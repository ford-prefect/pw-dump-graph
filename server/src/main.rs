//! pw-dump-graph share service.
//!
//! Accepts a `pw-dump` JSON body, stores it in memory under a short random key, and
//! hands the key back so the frontend can load the graph via `/?g=<key>`. Nothing is
//! persisted: the store is bounded by a max entry count and a TTL, and everything is
//! lost on restart. The same binary also serves the built frontend (`dist/`).
//!
//! Optionally (`PWG_STATE_FILE`) the store is handed off across a *restart* — written
//! once on graceful shutdown (SIGTERM/Ctrl-C) and read back **then deleted** on startup,
//! so the file exists only during the restart window. This is a transient handoff for
//! deploying a new binary, NOT durable storage: a hard kill writes nothing, and nothing
//! sits on disk while the server runs.
//!
//! Dumps are stored **minified and gzip-compressed** (pw-dump JSON is pretty-printed
//! and highly repetitive, ~15× here), so far more entries fit in a given memory budget.
//! `GET` serves the stored gzip bytes verbatim with `Content-Encoding: gzip` to clients
//! that accept it (browsers do — the frontend's `fetch`/`res.text()` decodes it
//! transparently), decompressing server-side only for the rare client that doesn't.

use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{
        header::{CONTENT_ENCODING, CONTENT_TYPE},
        HeaderMap, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use pw_dump_graph_common::frontend;
use rand::{distributions::Alphanumeric, Rng};

/// One stored dump (minified + gzip-compressed) plus when it was created (for TTL).
struct Entry {
    gz: Bytes,
    created: Instant,
}

/// In-memory dump store. `order` tracks insertion order (oldest at the front) so we can
/// evict the oldest first; it may briefly hold keys already gone from `map` (lazily
/// removed on TTL reads), which `evict` cleans as they reach the front.
struct Store {
    map: HashMap<String, Entry>,
    order: VecDeque<String>,
    max: usize,
    ttl: Duration,
}

impl Store {
    fn new(max: usize, ttl: Duration) -> Self {
        Store {
            map: HashMap::new(),
            order: VecDeque::new(),
            max,
            ttl,
        }
    }

    fn evict(&mut self, now: Instant) {
        // Drop expired (and stale) entries from the front.
        while let Some(key) = self.order.front() {
            let expired = match self.map.get(key) {
                Some(e) => now.duration_since(e.created) > self.ttl,
                None => true, // dangling order entry whose value is already gone
            };
            if !expired {
                break;
            }
            let key = self.order.pop_front().unwrap();
            self.map.remove(&key);
        }
        // Enforce the max count, evicting oldest first.
        while self.map.len() > self.max {
            match self.order.pop_front() {
                Some(key) => {
                    self.map.remove(&key);
                }
                None => break,
            }
        }
    }

    fn insert(&mut self, key: String, gz: Bytes, now: Instant) {
        self.map.insert(key.clone(), Entry { gz, created: now });
        self.order.push_back(key);
        self.evict(now);
    }

    fn get(&mut self, key: &str, now: Instant) -> Option<Bytes> {
        match self.map.get(key) {
            Some(e) if now.duration_since(e.created) > self.ttl => {
                self.map.remove(key); // lazily expire on read
                None
            }
            Some(e) => Some(e.gz.clone()),
            None => None,
        }
    }

    /// Serialize live entries (in insertion order) into a transient handoff blob:
    /// `MAGIC`, then per entry `key_len:u8, key, remaining_secs:u64le, gz_len:u32le, gz`.
    /// Entries with no life left are skipped (their remaining is 0).
    fn snapshot(&self, now: Instant) -> Vec<u8> {
        let mut out = Vec::from(SNAPSHOT_MAGIC);
        for key in &self.order {
            let Some(e) = self.map.get(key) else { continue };
            let remaining = self.ttl.saturating_sub(now.duration_since(e.created));
            if remaining.is_zero() || key.len() > u8::MAX as usize {
                continue;
            }
            out.push(key.len() as u8);
            out.extend_from_slice(key.as_bytes());
            out.extend_from_slice(&remaining.as_secs().to_le_bytes());
            out.extend_from_slice(&(e.gz.len() as u32).to_le_bytes());
            out.extend_from_slice(&e.gz);
        }
        out
    }

    /// Rebuild a store from a handoff blob, restoring each entry's remaining life.
    /// Best-effort: a blob missing the magic yields an empty store, and a truncated
    /// tail simply drops the entries that didn't fully parse. `max` is then enforced.
    fn from_snapshot(max: usize, ttl: Duration, data: &[u8]) -> Store {
        let mut store = Store::new(max, ttl);
        let now = Instant::now();
        if data.len() < SNAPSHOT_MAGIC.len() || &data[..SNAPSHOT_MAGIC.len()] != SNAPSHOT_MAGIC {
            return store;
        }
        let mut p = SNAPSHOT_MAGIC.len();
        // Read a fixed slice and advance the cursor, or None if not enough bytes.
        let take = |p: &mut usize, n: usize| -> Option<&[u8]> {
            let s = data.get(*p..*p + n)?;
            *p += n;
            Some(s)
        };
        while let Some(klen) = take(&mut p, 1).map(|b| b[0] as usize) {
            let Some(kb) = take(&mut p, klen) else { break };
            let Some(rem) = take(&mut p, 8) else { break };
            let Some(glen) =
                take(&mut p, 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize)
            else {
                break;
            };
            let Some(gz) = take(&mut p, glen) else { break };
            let Ok(key) = std::str::from_utf8(kb) else {
                continue;
            };
            let remaining = Duration::from_secs(u64::from_le_bytes(rem.try_into().unwrap()));
            // created so that ttl - (now - created) == remaining; guard boot-time underflow.
            let created = now
                .checked_sub(ttl.saturating_sub(remaining))
                .unwrap_or(now);
            store.map.insert(
                key.to_owned(),
                Entry {
                    gz: Bytes::copy_from_slice(gz),
                    created,
                },
            );
            store.order.push_back(key.to_owned());
        }
        store.evict(now); // enforce max (and drop anything already expired)
        store
    }
}

const SNAPSHOT_MAGIC: &[u8] = b"PWG1";

type Shared = Arc<Mutex<Store>>;

fn gen_key() -> String {
    // Alphanumeric is url-safe (A-Za-z0-9); 10 chars ≈ 60 bits, unguessable enough for
    // an unlisted share link with no durable data behind it.
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(10)
        .map(char::from)
        .collect()
}

/// Validate, minify, and gzip a dump body for storage. `None` if it isn't JSON.
fn encode(body: &[u8]) -> Option<Bytes> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let minified = serde_json::to_vec(&value).ok()?; // drop pretty-print whitespace
    let mut enc = GzEncoder::new(Vec::new(), Compression::best());
    enc.write_all(&minified).ok()?;
    Some(Bytes::from(enc.finish().ok()?))
}

/// Inflate a stored (gzip) entry back to JSON bytes, for clients that don't accept gzip.
fn decode(gz: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    // Infallible in practice — we only ever store what `encode` produced.
    let _ = GzDecoder::new(gz).read_to_end(&mut out);
    out
}

/// Validate + store a dump, returning its key (None if the body isn't JSON).
fn store_dump(store: &Shared, body: Bytes) -> Option<String> {
    let gz = encode(&body)?;
    let key = gen_key();
    store
        .lock()
        .unwrap()
        .insert(key.clone(), gz, Instant::now());
    Some(key)
}

/// Build a share URL from the request's Host (honouring a proxy's scheme header).
fn share_url(headers: &HeaderMap, key: &str) -> String {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    format!("{scheme}://{host}/?g={key}")
}

/// JSON response — used by the frontend Share button (`POST /api/dumps`).
async fn create(State(store): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    match store_dump(&store, body) {
        Some(key) => Json(serde_json::json!({ "key": key, "url": share_url(&headers, &key) }))
            .into_response(),
        None => (StatusCode::BAD_REQUEST, "body is not valid JSON").into_response(),
    }
}

/// Plain-text response — for `pw-dump | curl --data-binary @- http://host` (or `-T-`).
/// Stores the piped dump and prints just the share URL, so it's easy to copy/open.
async fn create_text(State(store): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    match store_dump(&store, body) {
        Some(key) => (
            [(CONTENT_TYPE, "text/plain; charset=utf-8")],
            format!("{}\n", share_url(&headers, &key)),
        )
            .into_response(),
        None => (StatusCode::BAD_REQUEST, "body is not valid JSON\n").into_response(),
    }
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get("accept-encoding")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("gzip"))
}

async fn fetch(
    State(store): State<Shared>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> impl IntoResponse {
    let Some(gz) = store.lock().unwrap().get(&key, Instant::now()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if accepts_gzip(&headers) {
        // Serve the stored bytes as-is — the client (browser) inflates them.
        (
            [
                (CONTENT_TYPE, "application/json"),
                (CONTENT_ENCODING, "gzip"),
            ],
            gz,
        )
            .into_response()
    } else {
        ([(CONTENT_TYPE, "application/json")], decode(&gz)).into_response()
    }
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Load the handoff file (if present) into a store, then delete it — so the dumps
/// live on disk only across the restart, never while the server is running. Any
/// error (missing/unreadable/corrupt) falls back to an empty store.
fn load_and_clear(path: &str, max: usize, ttl: Duration) -> Store {
    match std::fs::read(path) {
        Ok(data) => {
            let store = Store::from_snapshot(max, ttl, &data);
            let _ = std::fs::remove_file(path);
            store
        }
        Err(_) => Store::new(max, ttl),
    }
}

/// Write the store to `path` for handoff, privately (0600) and atomically
/// (temp + rename). Best-effort: a failure is logged, not fatal.
fn save_snapshot(path: &str, store: &Store) {
    let blob = store.snapshot(Instant::now());
    let tmp = format!("{path}.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600); // the dumps were private in RAM; keep them private on disk
    }
    let result = opts
        .open(&tmp)
        .and_then(|mut f| f.write_all(&blob))
        .and_then(|()| std::fs::rename(&tmp, path));
    if let Err(e) = result {
        eprintln!("pw-dump-graph-server: could not save state to {path}: {e}");
    }
}

/// Resolve when the process is asked to shut down: SIGTERM (deploys) or Ctrl-C (dev).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut s) = signal(SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

#[tokio::main]
async fn main() {
    let max = env_parse("PWG_MAX_ENTRIES", 500usize);
    let ttl = Duration::from_secs(env_parse("PWG_TTL_SECS", 24 * 3600u64));
    let limit = env_parse("PWG_BODY_LIMIT", 8 * 1024 * 1024usize);
    let addr = std::env::var("PWG_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let state_file = std::env::var("PWG_STATE_FILE").ok();

    // Restore a handoff from a previous graceful shutdown (and delete it), else start empty.
    let store: Shared = Arc::new(Mutex::new(match &state_file {
        Some(path) => load_and_clear(path, max, ttl),
        None => Store::new(max, ttl),
    }));

    let app = Router::new()
        // Root: GET serves the frontend; POST/PUT accept a piped dump and reply with
        // the share URL as plain text — so `pw-dump | curl -T- http://host` just works.
        .route("/", get(frontend).post(create_text).put(create_text))
        .route("/api/dumps", post(create))
        .route("/api/dumps/{key}", get(fetch))
        .fallback(frontend) // embedded/disk frontend + SPA fallback (common crate)
        .layer(DefaultBodyLimit::max(limit))
        .with_state(store.clone());

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("pw-dump-graph-server on http://{addr} (max={max}, ttl={ttl:?})");
    if let Some(path) = &state_file {
        println!(
            "  state handoff via {path} (restored {} entries)",
            store.lock().unwrap().map.len()
        );
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve");

    // Graceful shutdown: hand the store off for the next start to pick up.
    if let Some(path) = &state_file {
        let store = store.lock().unwrap();
        save_snapshot(path, &store);
        eprintln!(
            "pw-dump-graph-server: saved {} entries to {path}",
            store.map.len()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(s: &str) -> Bytes {
        Bytes::from(s.to_owned())
    }

    #[test]
    fn evicts_oldest_over_max() {
        let mut s = Store::new(2, Duration::from_secs(100));
        let t = Instant::now();
        s.insert("a".into(), bytes("1"), t);
        s.insert("b".into(), bytes("2"), t);
        s.insert("c".into(), bytes("3"), t);
        assert!(s.get("a", t).is_none(), "oldest should be evicted");
        assert!(s.get("b", t).is_some());
        assert!(s.get("c", t).is_some());
    }

    #[test]
    fn expires_on_read_after_ttl() {
        let mut s = Store::new(100, Duration::from_secs(10));
        let t0 = Instant::now();
        s.insert("a".into(), bytes("1"), t0);
        assert!(s.get("a", t0 + Duration::from_secs(5)).is_some());
        assert!(s.get("a", t0 + Duration::from_secs(11)).is_none());
    }

    #[test]
    fn insert_sweeps_expired_from_front() {
        let mut s = Store::new(100, Duration::from_secs(10));
        let t0 = Instant::now();
        s.insert("a".into(), bytes("1"), t0);
        // A later insert past the TTL should sweep "a" out during eviction.
        s.insert("b".into(), bytes("2"), t0 + Duration::from_secs(20));
        assert_eq!(s.map.len(), 1);
        assert!(s.map.contains_key("b"));
    }

    #[test]
    fn encode_minifies_and_roundtrips() {
        let pretty = b"[\n  { \"a\": 1, \"b\": [2, 3] }\n]";
        let gz = encode(pretty).expect("valid JSON encodes");
        assert_eq!(decode(&gz), br#"[{"a":1,"b":[2,3]}]"#); // whitespace dropped
    }

    #[test]
    fn encode_rejects_non_json() {
        assert!(encode(b"not json").is_none());
        assert!(encode(b"").is_none());
    }

    #[test]
    fn encode_shrinks_repetitive_json() {
        // A repetitive array compresses well below its source size.
        let big = format!("[{}]", vec![r#"{"node":"x","ok":true}"#; 500].join(",\n  "));
        let gz = encode(big.as_bytes()).expect("valid JSON");
        assert!(
            gz.len() * 10 < big.len(),
            "expected >10x: {} vs {}",
            gz.len(),
            big.len()
        );
        assert_eq!(
            decode(&gz).len(),
            serde_json::to_vec(&serde_json::from_str::<serde_json::Value>(&big).unwrap())
                .unwrap()
                .len()
        );
    }

    #[test]
    fn snapshot_roundtrips_with_order() {
        let ttl = Duration::from_secs(3600);
        let mut s = Store::new(100, ttl);
        let t = Instant::now();
        s.insert("aaa".into(), bytes("one"), t);
        s.insert("bbb".into(), bytes("two"), t);
        let blob = s.snapshot(t);

        let mut r = Store::from_snapshot(100, ttl, &blob);
        assert_eq!(r.get("aaa", Instant::now()).as_deref(), Some(&b"one"[..]));
        assert_eq!(r.get("bbb", Instant::now()).as_deref(), Some(&b"two"[..]));
        // Insertion order preserved (aaa is oldest at the front).
        assert_eq!(r.order, ["aaa", "bbb"]);
    }

    #[test]
    fn snapshot_skips_expired_and_carries_remaining() {
        let ttl = Duration::from_secs(100);
        let mut s = Store::new(100, ttl);
        let t0 = Instant::now();
        s.insert("old".into(), bytes("x"), t0);
        s.insert("new".into(), bytes("y"), t0 + Duration::from_secs(90));
        // Snapshot 101s in: "old" is past its 100s life; "new" (age 11s) has ~89s left.
        let blob = s.snapshot(t0 + Duration::from_secs(101));

        let r = Store::from_snapshot(100, ttl, &blob);
        assert!(!r.map.contains_key("old"), "expired entry not serialized");
        assert!(r.map.contains_key("new"));
        // "new" still has life left after reload.
        let remaining = ttl - Instant::now().duration_since(r.map["new"].created);
        assert!(
            remaining > Duration::from_secs(60),
            "remaining ~95s: {remaining:?}"
        );
    }

    #[test]
    fn from_snapshot_enforces_max() {
        let ttl = Duration::from_secs(3600);
        let mut s = Store::new(100, ttl);
        let t = Instant::now();
        s.insert("a".into(), bytes("1"), t);
        s.insert("b".into(), bytes("2"), t);
        s.insert("c".into(), bytes("3"), t);
        let blob = s.snapshot(t);

        // Reload with a smaller cap: the oldest ("a") is evicted.
        let mut r = Store::from_snapshot(2, ttl, &blob);
        assert_eq!(r.map.len(), 2);
        assert!(r.get("a", Instant::now()).is_none());
        assert!(r.get("b", Instant::now()).is_some());
        assert!(r.get("c", Instant::now()).is_some());
    }

    #[test]
    fn from_snapshot_tolerates_corruption() {
        let ttl = Duration::from_secs(3600);
        // No magic → empty store.
        assert_eq!(Store::from_snapshot(100, ttl, b"garbage").map.len(), 0);
        assert_eq!(Store::from_snapshot(100, ttl, b"").map.len(), 0);

        // Valid head, truncated tail: the first entry survives, the torn one is dropped.
        let mut s = Store::new(100, ttl);
        let t = Instant::now();
        s.insert("aaa".into(), bytes("one"), t);
        s.insert("bbb".into(), bytes("two"), t);
        let mut blob = s.snapshot(t);
        blob.truncate(blob.len() - 2); // chop the end of "bbb"'s payload
        let r = Store::from_snapshot(100, ttl, &blob);
        assert!(r.map.contains_key("aaa"));
        assert!(!r.map.contains_key("bbb"));
    }

    #[test]
    fn load_and_clear_consumes_the_file() {
        let ttl = Duration::from_secs(3600);
        let mut s = Store::new(100, ttl);
        s.insert("aaa".into(), bytes("one"), Instant::now());
        let path = std::env::temp_dir().join(format!("pwg-test-{}", gen_key()));
        let p = path.to_str().unwrap();
        std::fs::write(&path, s.snapshot(Instant::now())).unwrap();

        let mut r = load_and_clear(p, 100, ttl);
        assert_eq!(r.get("aaa", Instant::now()).as_deref(), Some(&b"one"[..]));
        assert!(!path.exists(), "handoff file must be deleted after load");
    }
}
