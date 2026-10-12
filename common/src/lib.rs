//! Shared frontend-serving for the pw-dump-graph binaries. Serves the built SPA —
//! baked into the binary with the `embed` feature, else from `PWG_DIST` on disk — with
//! SPA fallback to index.html and a path-traversal guard. Used both as the `/` GET
//! handler and as the axum router fallback.

use axum::{
    http::{header::CONTENT_TYPE, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};

/// What this build is: the workspace version and the git commit it was built from
/// (captured by build.rs; "unknown" outside a git checkout). Both binaries report it
/// at `GET /api/version` so a running instance can be identified.
pub struct BuildInfo {
    pub version: &'static str,
    pub commit: &'static str,
}

pub const BUILD: BuildInfo = BuildInfo {
    version: env!("CARGO_PKG_VERSION"),
    commit: env!("PWG_GIT_COMMIT"),
};

/// Body for `GET /api/version`: which binary this is, its version, and its commit.
pub fn version_json(service: &'static str) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "service": service,
        "version": BUILD.version,
        "commit": BUILD.commit,
    }))
}

/// The built frontend, baked in with the `embed` feature.
#[cfg(feature = "embed")]
#[derive(rust_embed::RustEmbed)]
#[folder = "../dist/"]
struct Assets;

/// The SPA fallback must not shadow the API namespace. An unmatched `/api/…` is a missing
/// endpoint, not a client-side route, and answering it with index.html yields a 200 full of
/// HTML that a JSON caller reads as a real response — which is how a share server (no
/// `/api/graph`) used to look like a live viewer to the frontend.
fn is_api_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// Serve the embedded frontend, with SPA fallback to index.html so `/?g=…` works.
#[cfg(feature = "embed")]
pub async fn frontend(uri: Uri) -> Response {
    if is_api_path(uri.path()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return ([(CONTENT_TYPE, mime.as_ref())], file.data.into_owned()).into_response();
    }
    match Assets::get("index.html") {
        Some(file) => ([(CONTENT_TYPE, "text/html")], file.data.into_owned()).into_response(),
        None => (StatusCode::NOT_FOUND, "frontend not embedded").into_response(),
    }
}

/// Without the `embed` feature, serve the built frontend from disk (`PWG_DIST`,
/// default "dist"), with SPA fallback — so a debug build serves the app once
/// `npm run build` has run. Falls back to a hint if the frontend isn't built.
#[cfg(not(feature = "embed"))]
pub async fn frontend(uri: Uri) -> Response {
    if is_api_path(uri.path()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let dist = std::env::var("PWG_DIST").unwrap_or_else(|_| "dist".to_string());
    let base = std::path::Path::new(&dist);
    let rel = uri.path().trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.split('/').any(|c| c == "..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if let Ok(bytes) = tokio::fs::read(base.join(rel)).await {
        let mime = mime_guess::from_path(rel).first_or_octet_stream();
        return ([(CONTENT_TYPE, mime.as_ref())], bytes).into_response();
    }
    match tokio::fs::read(base.join("index.html")).await {
        Ok(bytes) => ([(CONTENT_TYPE, "text/html")], bytes).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            "frontend not found — run `npm run build` (PWG_DIST), or build with `--features embed`",
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_api_path, version_json, BUILD};

    #[test]
    fn version_json_reports_build() {
        assert_eq!(BUILD.version, env!("CARGO_PKG_VERSION"));
        assert!(!BUILD.commit.is_empty());
        let v = version_json("pw-dump-graph-test").0;
        assert_eq!(v["service"], "pw-dump-graph-test");
        assert_eq!(v["version"], BUILD.version);
        assert_eq!(v["commit"], BUILD.commit);
    }

    #[test]
    fn api_namespace_is_not_spa_routable() {
        assert!(is_api_path("/api"));
        assert!(is_api_path("/api/"));
        assert!(is_api_path("/api/graph"));
        assert!(is_api_path("/api/dumps/abc"));
        // Not the API namespace — these are ordinary SPA/asset paths.
        assert!(!is_api_path("/"));
        assert!(!is_api_path("/apiary"));
        assert!(!is_api_path("/pw-dump.json"));
    }
}
