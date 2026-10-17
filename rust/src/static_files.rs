use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{header, Response, StatusCode};
use axum::response::IntoResponse;

const CSP: &str = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com";

const NOT_BUILT: &str = "UI not built. Run: npm run build:web";

#[derive(rust_embed::Embed)]
#[folder = "../web/dist"]
struct Embedded;

pub async fn serve_static(web_dir: Option<&Path>, url: &str) -> Response<Body> {
    let rel = if url == "/" { "index.html" } else { url.trim_start_matches('/') };
    let spa_fallback = !rel.starts_with("assets/");
    match web_dir.and_then(|d| d.canonicalize().ok()) {
        Some(root) => serve_disk(&root, rel, spa_fallback).await,
        None => serve_embedded(rel, spa_fallback),
    }
}

async fn serve_disk(root: &Path, rel: &str, spa_fallback: bool) -> Response<Body> {
    let file = resolve_under(root, &root.join(rel)).or_else(|| spa_fallback.then(|| root.join("index.html")));
    let Some(file) = file else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => file_response(&file.to_string_lossy(), bytes),
        Err(_) if file.ends_with("index.html") => (StatusCode::SERVICE_UNAVAILABLE, NOT_BUILT).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn serve_embedded(rel: &str, spa_fallback: bool) -> Response<Body> {
    if let Some(file) = Embedded::get(rel) {
        return file_response(rel, file.data.into_owned());
    }
    if !spa_fallback {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match Embedded::get("index.html") {
        Some(file) => file_response("index.html", file.data.into_owned()),
        None => (StatusCode::SERVICE_UNAVAILABLE, NOT_BUILT).into_response(),
    }
}

fn file_response(name: &str, bytes: Vec<u8>) -> Response<Body> {
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.essence_str())
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .body(Body::from(bytes))
        .unwrap()
}

fn resolve_under(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let canon = candidate.canonicalize().ok()?;
    if canon == root || canon.starts_with(root) {
        Some(canon)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn serves_index() {
        let dir = tempdir().unwrap();
        tokio::fs::write(dir.path().join("index.html"), b"<html>ok</html>")
            .await
            .unwrap();
        let res = serve_static(Some(dir.path()), "/").await;
        assert_eq!(res.status(), StatusCode::OK);
    }
}
