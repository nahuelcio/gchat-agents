use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{header, Response, StatusCode};
use axum::response::IntoResponse;

const CSP: &str = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com";

pub async fn serve_static(web_dir: Option<&Path>, url: &str) -> Response<Body> {
    let Some(root) = web_dir else {
        return (StatusCode::SERVICE_UNAVAILABLE, "UI not built. Run: npm run build:web").into_response();
    };
    let root = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::SERVICE_UNAVAILABLE, "UI not built. Run: npm run build:web").into_response();
        }
    };
    let rel = if url == "/" {
        "index.html".to_string()
    } else {
        url.trim_start_matches('/').to_string()
    };
    let candidate = root.join(&rel);
    let file = resolve_under(&root, &candidate).or_else(|| {
        if rel.starts_with("assets/") {
            None
        } else {
            Some(root.join("index.html"))
        }
    });
    let Some(file) = file else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&file).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.essence_str())
                .header(header::CONTENT_SECURITY_POLICY, CSP)
                .body(Body::from(bytes))
                .unwrap()
        }
        Err(_) => {
            if file.ends_with("index.html") {
                (StatusCode::SERVICE_UNAVAILABLE, "UI not built. Run: npm run build:web").into_response()
            } else {
                (StatusCode::NOT_FOUND, "not found").into_response()
            }
        }
    }
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
