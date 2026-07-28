//! pw-dump-graph — standalone PipeWire graph viewer.
//!
//! Runs `pw-dump` (overridable via PWG_DUMP_CMD) and serves the browser viewer.
//! By default it gathers one dump, serves it, and exits once the UI has fetched it.
//! With `-m` it runs `pw-dump -m` and streams live updates (SSE) instead.
//! `--remote` binds 0.0.0.0 and doesn't open a browser (run on a device, view remotely).

use std::{
    collections::BTreeMap,
    convert::Infallible,
    io::BufReader,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::State,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::get,
    Router,
};
use pw_dump_graph_common::frontend;
use serde_json::Value;
use tokio::sync::{watch, Notify};

/// Shared router state: the current graph, a watch of its version for SSE, and — in
/// one-shot (gather) mode — a Notify fired after the first /api/graph GET to shut down.
#[derive(Clone)]
struct AppState {
    graph: Shared,
    version_rx: watch::Receiver<u64>,
    shutdown: Option<Arc<Notify>>,
}

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
fn apply_batch(state: &Shared, objects: Vec<Value>) -> u64 {
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
    s.version
}

/// Spawn the dump source and feed each parsed batch into `apply_batch`, calling
/// `on_batch` with the new version. Blocking. The command runs through `sh -c` so
/// PWG_DUMP_CMD can be a pipeline (and tests can substitute a fake generator).
fn run_source(cmd: String, state: Shared, on_batch: impl FnMut(u64)) {
    let mut child = match Command::new("sh").arg("-c").arg(&cmd).stdout(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("pw-dump-graph: failed to start `{cmd}`: {e}");
            std::process::exit(1);
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    ingest(stdout, &state, on_batch);
    let _ = child.wait();
}

/// Read a pw-dump stream — successive top-level JSON arrays — and merge each batch,
/// invoking `on_batch` with the new version. serde_json's streaming iterator yields
/// each complete array whether pretty-printed or raw, so we don't rely on `pw-dump -R`.
/// Shared by the live monitor and the tests.
fn ingest(reader: impl std::io::Read, state: &Shared, mut on_batch: impl FnMut(u64)) {
    let batches =
        serde_json::Deserializer::from_reader(BufReader::new(reader)).into_iter::<Vec<Value>>();
    for batch in batches {
        match batch {
            Ok(objects) => on_batch(apply_batch(state, objects)),
            Err(e) => {
                eprintln!("pw-dump-graph: error parsing dump stream: {e}");
                break;
            }
        }
    }
}

/// Current graph as a JSON array of objects (what the frontend's parser expects). The
/// `x-pwg-live` header tells the client whether to subscribe for live updates. In
/// one-shot mode, fetching this triggers shutdown (the UI now has what it needs).
async fn graph(State(app): State<AppState>) -> Response {
    let body = {
        let s = app.graph.lock().unwrap();
        serde_json::to_vec(&s.objects.values().collect::<Vec<_>>()).unwrap_or_default()
    };
    let live = app.shutdown.is_none();
    let response = (
        [("content-type", "application/json"), ("x-pwg-live", if live { "1" } else { "0" })],
        body,
    )
        .into_response();
    if let Some(notify) = &app.shutdown {
        notify.notify_one(); // graceful shutdown; this in-flight response still flushes
    }
    response
}

/// SSE stream that ticks whenever the graph changes (debounced). The client re-fetches
/// /api/graph on each tick. An initial tick is sent on connect so the client syncs even
/// if a change slipped in between its /api/graph load and this subscription.
async fn events(State(app): State<AppState>) -> impl IntoResponse {
    let mut rx = app.version_rx.clone();
    let stream = async_stream::stream! {
        yield Ok::<Event, Infallible>(Event::default().data("0"));
        loop {
            if rx.changed().await.is_err() {
                break; // sender dropped
            }
            // Debounce: absorb a burst of batches into one client refresh.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let version = *rx.borrow_and_update();
            yield Ok(Event::default().data(version.to_string()));
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

struct Args {
    remote: bool,
    monitor: bool,
    addr: String,
}

fn parse_args() -> Args {
    let mut remote = false;
    let mut monitor = false;
    let mut port = std::env::var("PWG_PORT").ok().and_then(|v| v.parse::<u16>().ok()).unwrap_or(8787);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--remote" => remote = true,
            "-m" | "--monitor" => monitor = true,
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
    Args { remote, monitor, addr }
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    // `-m` passes through to pw-dump and streams; otherwise gather one dump.
    let default_cmd = if args.monitor { "pw-dump -m" } else { "pw-dump" };
    let cmd = std::env::var("PWG_DUMP_CMD").unwrap_or_else(|_| default_cmd.to_string());

    let state: Shared = Arc::new(Mutex::new(GraphState::default()));
    let (version_tx, version_rx) = watch::channel(0u64);
    // One-shot mode carries a shutdown signal fired after the UI fetches the graph.
    let shutdown = if args.monitor { None } else { Some(Arc::new(Notify::new())) };

    if args.monitor {
        let state = state.clone();
        std::thread::spawn(move || {
            run_source(cmd, state, move |v| {
                let _ = version_tx.send(v); // wake SSE subscribers (coalesced by watch)
            });
        });
    } else {
        // Gather the whole dump before serving, so the single GET returns it complete.
        let state = state.clone();
        tokio::task::spawn_blocking(move || run_source(cmd, state, |_| {}))
            .await
            .expect("gather task");
        drop(version_tx); // no live updates in one-shot mode
    }

    let app = Router::new()
        .route("/api/graph", get(graph))
        .route("/api/events", get(events))
        .route("/", get(frontend))
        .fallback(frontend)
        .with_state(AppState { graph: state, version_rx, shutdown: shutdown.clone() });

    let listener = tokio::net::TcpListener::bind(&args.addr).await.expect("bind");
    let url = format!("http://{}/", args.addr.replace("0.0.0.0", "127.0.0.1"));
    let mode = if args.monitor { "monitor" } else { "one-shot" };
    let net = if args.remote { "remote" } else { "local" };
    println!("pw-dump-graph on {url} ({net}, {mode})");

    if !args.remote {
        // Best-effort: open the viewer locally.
        let _ = Command::new("xdg-open").arg(&url).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }

    match shutdown {
        // One-shot: shut down after the UI's fetch (graceful — the response still flushes).
        Some(notify) => axum::serve(listener, app)
            .with_graceful_shutdown(async move { notify.notified().await })
            .await
            .expect("serve"),
        None => axum::serve(listener, app).await.expect("serve"),
    }
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

    #[test]
    fn parses_and_merges_a_pretty_stream() {
        // Exercises the full StreamDeserializer path over multi-line pretty batches
        // (as `pw-dump -m` emits by default): initial add, update, and both null removals.
        let stream = r#"
        [
          { "id": 1, "type": "Node", "info": { "props": { "node.name": "a" } } },
          { "id": 2, "type": "Port", "info": {} }
        ]
        [ { "id": 1, "info": { "props": { "node.name": "a2" } } } ]
        [ { "id": 2, "info": null } ]
        [ { "id": 3, "props": { "x": 1 } } ]
        [ { "id": 3, "props": null } ]
        "#;
        let s = new_state();
        let mut versions = vec![];
        ingest(stream.as_bytes(), &s, |v| versions.push(v));
        let g = s.lock().unwrap();
        assert_eq!(g.objects.keys().copied().collect::<Vec<_>>(), vec![1], "only id 1 survives");
        assert_eq!(g.objects[&1]["info"]["props"]["node.name"], json!("a2"), "id 1 replaced");
        assert_eq!(versions, vec![1, 2, 3, 4, 5], "one version bump per batch");
    }

    // Opt-in: replay a recorded `pw-dump -m` capture (kept out of the repo). Run with
    //   PWG_TEST_STREAM=../pw-dump-updates.json cargo test -p pw-dump-graph -- --ignored
    #[test]
    #[ignore = "set PWG_TEST_STREAM to a recorded pw-dump -m capture"]
    fn replays_recorded_stream() {
        let path = std::env::var("PWG_TEST_STREAM").expect("PWG_TEST_STREAM");
        let file = std::fs::File::open(&path).expect("open PWG_TEST_STREAM");
        let s = new_state();
        ingest(file, &s, |_| {});
        let g = s.lock().unwrap();
        assert!(!g.objects.is_empty(), "stream produced a non-empty graph");
        // No removal-shaped leftovers: every survivor is a real object with a type.
        assert!(g.objects.values().all(|o| o.get("type").is_some()), "survivors keep their type");
    }
}
