//! pw-dump-graph — standalone live viewer.
//!
//! Runs `pw-dump -m` (overridable via PWG_DUMP_CMD), maintains the current PipeWire
//! graph in memory by merging the streamed batches, and serves the browser viewer.
//! `GET /api/graph` returns the current object array; the frontend renders it.
//!
//! Default mode binds 127.0.0.1 and opens a browser; `--remote` binds 0.0.0.0 and
//! doesn't, so the viewer can run on a device and be viewed from another host.

use std::{
    collections::BTreeMap,
    io::BufReader,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

use axum::{
    extract::State,
    http::header::CONTENT_TYPE,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use pw_dump_graph_common::frontend;
use serde_json::Value;

/// Current graph: pw-dump objects keyed by their top-level `id`, plus a version that
/// bumps on every applied batch (used later to notify live clients).
#[derive(Default)]
struct GraphState {
    objects: BTreeMap<i64, Value>,
    version: u64,
}

type Shared = Arc<Mutex<GraphState>>;

/// Merge one pw-dump batch into the state. Each element is keyed by `id`; an element
/// whose `info` (or `props`) is JSON null is a removal, otherwise it's the full object
/// and replaces any previous value. (pw-dump re-emits whole objects, not deltas.)
fn apply_batch(state: &Shared, objects: Vec<Value>) {
    let mut s = state.lock().unwrap();
    for obj in objects {
        let Some(id) = obj.get("id").and_then(Value::as_i64) else { continue };
        let removed = obj.get("info").is_some_and(Value::is_null)
            || obj.get("props").is_some_and(Value::is_null);
        if removed {
            s.objects.remove(&id);
        } else {
            s.objects.insert(id, obj);
        }
    }
    s.version += 1;
}

/// Spawn the dump source and feed each parsed batch into `apply_batch`. Runs on a
/// blocking thread. The command is run through `sh -c` so PWG_DUMP_CMD can be a
/// pipeline (and tests can substitute a fake generator).
fn run_monitor(cmd: String, state: Shared) {
    let mut child = match Command::new("sh").arg("-c").arg(&cmd).stdout(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("pw-dump-graph: failed to start `{cmd}`: {e}");
            std::process::exit(1);
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    // serde_json's streaming iterator yields each successive top-level JSON array,
    // whether pretty-printed or raw — so we don't rely on `pw-dump -R`.
    let batches = serde_json::Deserializer::from_reader(BufReader::new(stdout)).into_iter::<Vec<Value>>();
    for batch in batches {
        match batch {
            Ok(objects) => apply_batch(&state, objects),
            Err(e) => {
                eprintln!("pw-dump-graph: error parsing dump stream: {e}");
                break;
            }
        }
    }
    let _ = child.wait();
    eprintln!("pw-dump-graph: dump source ended; serving last-known graph");
}

/// Current graph as a JSON array of objects (what the frontend's parser expects).
async fn graph(State(state): State<Shared>) -> Response {
    let body = {
        let s = state.lock().unwrap();
        serde_json::to_vec(&s.objects.values().collect::<Vec<_>>()).unwrap_or_default()
    };
    ([(CONTENT_TYPE, "application/json")], body).into_response()
}

struct Args {
    remote: bool,
    addr: String,
}

fn parse_args() -> Args {
    let mut remote = false;
    let mut port = std::env::var("PWG_PORT").ok().and_then(|v| v.parse::<u16>().ok()).unwrap_or(8787);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--remote" => remote = true,
            "--port" | "-p" => {
                if let Some(v) = args.next().and_then(|v| v.parse().ok()) {
                    port = v;
                }
            }
            _ => {}
        }
    }
    // PWG_ADDR (if set) wins outright; otherwise bind loopback locally, all-interfaces remote.
    let addr = std::env::var("PWG_ADDR").unwrap_or_else(|_| {
        let host = if remote { "0.0.0.0" } else { "127.0.0.1" };
        format!("{host}:{port}")
    });
    Args { remote, addr }
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    let cmd = std::env::var("PWG_DUMP_CMD").unwrap_or_else(|_| "pw-dump -m".to_string());

    let state: Shared = Arc::new(Mutex::new(GraphState::default()));
    {
        let state = state.clone();
        std::thread::spawn(move || run_monitor(cmd, state));
    }

    let app = Router::new()
        .route("/api/graph", get(graph))
        .route("/", get(frontend))
        .fallback(frontend)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&args.addr).await.expect("bind");
    let url = format!("http://{}/", args.addr.replace("0.0.0.0", "127.0.0.1"));
    println!("pw-dump-graph on {url} ({})", if args.remote { "remote" } else { "local" });

    if !args.remote {
        // Best-effort: open the viewer locally.
        let _ = Command::new("xdg-open").arg(&url).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }

    axum::serve(listener, app).await.expect("serve");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn new_state() -> Shared {
        Arc::new(Mutex::new(GraphState::default()))
    }
    fn ids(state: &Shared) -> Vec<i64> {
        state.lock().unwrap().objects.keys().copied().collect()
    }

    #[test]
    fn initial_batch_adds_all() {
        let s = new_state();
        apply_batch(&s, vec![json!({"id":1,"type":"Node","info":{}}), json!({"id":2,"type":"Port","info":{}})]);
        assert_eq!(ids(&s), vec![1, 2]);
    }

    #[test]
    fn update_replaces_by_id() {
        let s = new_state();
        apply_batch(&s, vec![json!({"id":1,"info":{"props":{"a":1}}})]);
        apply_batch(&s, vec![json!({"id":1,"info":{"props":{"a":2}}})]);
        let g = s.lock().unwrap();
        assert_eq!(g.objects[&1]["info"]["props"]["a"], json!(2));
        assert_eq!(g.objects.len(), 1);
    }

    #[test]
    fn null_info_removes() {
        let s = new_state();
        apply_batch(&s, vec![json!({"id":1,"info":{}}), json!({"id":2,"info":{}})]);
        apply_batch(&s, vec![json!({"id":1,"info":null})]);
        assert_eq!(ids(&s), vec![2]);
    }

    #[test]
    fn null_props_removes() {
        let s = new_state();
        apply_batch(&s, vec![json!({"id":5,"props":{"x":1}})]);
        apply_batch(&s, vec![json!({"id":5,"props":null})]);
        assert!(ids(&s).is_empty());
    }

    #[test]
    fn version_bumps_per_batch() {
        let s = new_state();
        apply_batch(&s, vec![json!({"id":1,"info":{}})]);
        apply_batch(&s, vec![json!({"id":2,"info":{}})]);
        assert_eq!(s.lock().unwrap().version, 2);
    }
}
