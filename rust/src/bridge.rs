use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::handler::{handle_event, ChatEvent};
use crate::state::AppState;
use crate::static_files::serve_static;

pub fn bridge_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/google/chat", post(google_chat))
        .fallback(bridge_fallback)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .with_state(state)
}

async fn healthz() -> Response {
    Json(json!({ "ok": true })).into_response()
}

async fn google_chat(State(state): State<Arc<AppState>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let event: ChatEvent = match serde_json::from_slice(&body) {
        Ok(e) => e,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid JSON" }))).into_response();
        }
    };
    let auth = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let result = handle_event(auth, event, state.handler.clone()).await;
    (
        StatusCode::from_u16(result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(result.body),
    )
        .into_response()
}

async fn bridge_fallback(State(state): State<Arc<AppState>>, uri: axum::http::Uri) -> Response {
    let path = uri.path();
    if path == "/play" || path.starts_with("/play/") || path.starts_with("/assets/") {
        let serve_path = if path.starts_with("/assets/") { path } else { "/" };
        return serve_static(state.web_dir.as_deref(), serve_path).await;
    }
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
}
