//! Shared frontend-serving for the pw-dump-graph binaries. Serves the built SPA —
//! baked into the binary with the `embed` feature, else from `PWG_DIST` on disk — with
//! SPA fallback to index.html and a path-traversal guard. Used both as the `/` GET
//! handler and as the axum router fallback.

use axum::{
    http::{header::CONTENT_TYPE, StatusCode, Uri},
    response::{IntoResponse, Response},
};

/// The built frontend, baked in with the `embed` feature.
#[cfg(feature = "embed")]
#[derive(rust_embed::RustEmbed)]
#[folder = "../dist/"]
struct Assets;

/// Serve the embedded frontend, with SPA fallback to index.html so `/?g=…` works.
#[cfg(feature = "embed")]
pub async fn frontend(uri: Uri) -> Response {
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
