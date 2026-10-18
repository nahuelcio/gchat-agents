use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tower_http::compression::CompressionLayer;

use crate::handler::{handle_event, ChatEvent};
use crate::state::AppState;
use crate::static_files::serve_static;

pub fn bridge_router(state: Arc<AppState>) -> Router {
    let play = Router::new()
        .route("/play/api/thread", get(play_thread))
        .route("/play/api/send", post(play_send))
        .route("/play/api/stop", post(crate::admin::post_team_stop))
        .route("/play/api/agents", get(play_agents))
        .route("/play/api/personas", get(play_personas))
        .route("/play/api/media/{id}", get(crate::admin::get_media))
        .layer(axum::extract::DefaultBodyLimit::max(crate::team::UPLOAD_LIMIT))
        .layer(axum::middleware::from_fn_with_state(state.clone(), require_share_token));
    Router::new()
        .merge(play)
        .route("/healthz", get(healthz))
        .route("/google/chat", post(google_chat).layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)))
        .fallback(bridge_fallback)
        .layer(CompressionLayer::new())
        .with_state(state)
}

async fn require_share_token(State(state): State<Arc<AppState>>, req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let bearer = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(String::from);
    let access = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("access=")))
        .map(percent_decode);
    if !state.share.lock().await.check(bearer.or(access).as_deref()) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "invalid or expired share link" }))).into_response();
    }
    next.run(req).await
}

fn percent_decode(v: &str) -> String {
    let bytes = v.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (bytes[i], bytes.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok())) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(serde::Deserialize)]
struct ThreadQuery {
    thread: Option<String>,
}

async fn play_thread(State(state): State<Arc<AppState>>, axum::extract::Query(q): axum::extract::Query<ThreadQuery>) -> Response {
    match crate::team::team_thread(state.handler.clone(), state.transcripts.clone(), q.thread.as_deref().unwrap_or("")).await {
        Ok(t) => Json(t).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct PlaySend {
    thread: Option<String>,
    text: Option<String>,
    name: Option<String>,
    attachments: Option<Vec<crate::team::TeamAttachmentInput>>,
}

async fn play_send(State(state): State<Arc<AppState>>, Json(body): Json<PlaySend>) -> Response {
    let name: String = body.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Guest".into()).chars().take(40).collect();
    match crate::team::team_send(
        state.handler.clone(),
        state.transcripts.clone(),
        body.thread.as_deref().unwrap_or(""),
        body.text.as_deref().unwrap_or(""),
        &name,
        Some(crate::team::GUEST_COMMANDS),
        body.attachments.as_deref().unwrap_or_default(),
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn play_agents(State(_state): State<Arc<AppState>>) -> Response {
    let agents: Vec<_> = crate::agents::detect_agents()
        .await
        .into_iter()
        .filter(|a| a.supported && a.installed)
        .map(|a| json!({ "id": a.id, "name": a.name, "ready": a.ready }))
        .collect();
    Json(agents).into_response()
}

async fn play_personas(State(state): State<Arc<AppState>>) -> Response {
    let names: Vec<_> = state
        .settings
        .get()
        .personas
        .into_iter()
        .map(|p| {
            let mut o = json!({ "name": p.name });
            if let Some(avatar) = p.avatar {
                o["avatar"] = json!(avatar);
            }
            o
        })
        .collect();
    Json(names).into_response()
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
