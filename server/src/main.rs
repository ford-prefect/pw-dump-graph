//! pw-dump-graph share service.
//!
//! Accepts a `pw-dump` JSON body, stores it in memory under a short random key, and
//! hands the key back so the frontend can load the graph via `/?g=<key>`. Nothing is
//! persisted: the store is bounded by a max entry count and a TTL, and everything is
//! lost on restart. The same binary also serves the built frontend (`dist/`).

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header::CONTENT_TYPE, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use pw_dump_graph_common::frontend;
use rand::{distributions::Alphanumeric, Rng};

/// One stored dump plus when it was created (for TTL).
struct Entry {
    bytes: Bytes,
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

    fn insert(&mut self, key: String, bytes: Bytes, now: Instant) {
        self.map.insert(
            key.clone(),
            Entry {
                bytes,
                created: now,
            },
        );
        self.order.push_back(key);
        self.evict(now);
    }

    fn get(&mut self, key: &str, now: Instant) -> Option<Bytes> {
        match self.map.get(key) {
            Some(e) if now.duration_since(e.created) > self.ttl => {
                self.map.remove(key); // lazily expire on read
                None
            }
            Some(e) => Some(e.bytes.clone()),
            None => None,
        }
    }
}

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

/// Validate + store a dump, returning its key (None if the body isn't JSON).
fn store_dump(store: &Shared, body: Bytes) -> Option<String> {
    if serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        return None;
    }
    let key = gen_key();
    store
        .lock()
        .unwrap()
        .insert(key.clone(), body, Instant::now());
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

async fn fetch(State(store): State<Shared>, Path(key): Path<String>) -> impl IntoResponse {
    match store.lock().unwrap().get(&key, Instant::now()) {
        Some(bytes) => ([(CONTENT_TYPE, "application/json")], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() {
    let max = env_parse("PWG_MAX_ENTRIES", 500usize);
    let ttl = Duration::from_secs(env_parse("PWG_TTL_SECS", 24 * 3600u64));
    let limit = env_parse("PWG_BODY_LIMIT", 8 * 1024 * 1024usize);
    let addr = std::env::var("PWG_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());

    let store: Shared = Arc::new(Mutex::new(Store::new(max, ttl)));

    let app = Router::new()
        // Root: GET serves the frontend; POST/PUT accept a piped dump and reply with
        // the share URL as plain text — so `pw-dump | curl -T- http://host` just works.
        .route("/", get(frontend).post(create_text).put(create_text))
        .route("/api/dumps", post(create))
        .route("/api/dumps/{key}", get(fetch))
        .fallback(frontend) // embedded/disk frontend + SPA fallback (common crate)
        .layer(DefaultBodyLimit::max(limit))
        .with_state(store);

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("pw-dump-graph-server on http://{addr} (max={max}, ttl={ttl:?})");
    axum::serve(listener, app).await.expect("serve");
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
}
