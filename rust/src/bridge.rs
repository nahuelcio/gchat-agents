use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde_json::json;
use tower_http::compression::CompressionLayer;
use tower_http::decompression::RequestDecompressionLayer;

use crate::handler::{handle_event, ChatEvent};
use crate::share::ShareAccess;
use crate::state::AppState;
use crate::static_files::serve_static;

pub fn bridge_router(state: Arc<AppState>) -> Router {
    let play = Router::new()
        .route("/play/api/threads", get(play_threads))
        .route("/play/api/thread", get(play_thread))
        .route("/play/api/send", post(play_send))
        .route("/play/api/rewrite", post(play_rewrite))
        .route("/play/api/fork", post(play_fork))
        .route("/play/api/export", get(play_export))
        .route("/play/api/summarize", post(play_summarize))
        .route("/play/api/feedback", post(play_feedback))
        .route("/play/api/stop", post(play_stop))
        .route("/play/api/agents", get(play_agents))
        .route("/play/api/personas", get(play_personas))
        .route("/play/api/media/{id}", get(crate::admin::get_media))
        .layer(axum::extract::DefaultBodyLimit::max(crate::team::UPLOAD_LIMIT))
        .layer(axum::middleware::from_fn_with_state(state.clone(), require_share_token));
    Router::new()
        .merge(play)
        .route("/healthz", get(healthz))
        .route("/hooks/{id}", post(post_hook).layer(axum::extract::DefaultBodyLimit::max(64 * 1024)))
        .route("/google/chat", post(google_chat).layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)))
        .fallback(bridge_fallback)
        .layer(CompressionLayer::new())
        .layer(RequestDecompressionLayer::new())
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
    let Some(scope) = state.share.lock().await.access(bearer.or(access).as_deref()) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "invalid or expired share link" }))).into_response();
    };
    let mut req = req;
    req.extensions_mut().insert(scope);
    next.run(req).await
}

fn allows(scope: &ShareAccess, thread: &str) -> bool {
    match scope {
        ShareAccess::All => true,
        ShareAccess::Thread(t) => t == thread,
    }
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": "this link only opens one conversation" }))).into_response()
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

#[derive(serde::Deserialize)]
struct ThreadsQuery {
    archived: Option<String>,
}

async fn play_threads(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, axum::extract::Query(q): axum::extract::Query<ThreadsQuery>) -> Response {
    let archived = q.archived.as_deref() == Some("1");
    let list: Vec<_> = state
        .transcripts
        .list(crate::handler::TEAM_PREFIX, archived)
        .into_iter()
        .filter(|t| allows(&scope, t.key.strip_prefix(crate::handler::TEAM_PREFIX).unwrap_or(&t.key)))
        .map(|t| {
            let title = state.handler.store.get(&t.key).and_then(|r| r.title).unwrap_or(t.title);
            json!({
                "id": t.key.strip_prefix(crate::handler::TEAM_PREFIX).unwrap_or(&t.key),
                "title": title,
                "updatedAt": t.updated_at,
                "count": t.count,
            })
        })
        .collect();
    Json(list).into_response()
}

async fn play_thread(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, axum::extract::Query(q): axum::extract::Query<ThreadQuery>) -> Response {
    if !allows(&scope, q.thread.as_deref().unwrap_or("")) {
        return forbidden();
    }
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
    #[serde(rename = "replyTo")]
    reply_to: Option<crate::transcripts::Quote>,
}

async fn play_send(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, Json(body): Json<PlaySend>) -> Response {
    if !allows(&scope, body.thread.as_deref().unwrap_or("")) {
        return forbidden();
    }
    let name: String = body.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Guest".into()).chars().take(40).collect();
    match crate::team::team_send(
        state.handler.clone(),
        state.transcripts.clone(),
        body.thread.as_deref().unwrap_or(""),
        body.text.as_deref().unwrap_or(""),
        &name,
        Some(crate::team::GUEST_COMMANDS),
        body.attachments.as_deref().unwrap_or_default(),
        body.reply_to,
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn play_stop(Extension(scope): Extension<ShareAccess>, Json(body): Json<crate::admin::TeamThreadBody>) -> Response {
    if !allows(&scope, body.thread.as_deref().unwrap_or("")) {
        return forbidden();
    }
    crate::admin::post_team_stop(Json(body)).await
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

async fn post_hook(State(state): State<Arc<AppState>>, Path(id): Path<String>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let Some(trigger) = state.triggers.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "unknown trigger" }))).into_response();
    };
    let sig = headers.get("x-switchboard-signature").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !crate::schedules::signature_ok(&trigger.secret, &body, sig) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "bad signature" }))).into_response();
    }
    let payload = String::from_utf8_lossy(&body).to_string();
    let job = crate::schedules::event_job(&trigger, &payload);
    let thread = job.id.clone();
    let ok = state.scheduler.run_ephemeral(job).await;
    if ok {
        Json(json!({ "ok": true, "thread": thread })).into_response()
    } else {
        (StatusCode::BAD_GATEWAY, Json(json!({ "error": "trigger failed", "thread": thread }))).into_response()
    }
}

fn scoped_thread(scope: &ShareAccess, thread: Option<&str>) -> Result<(), Response> {
    if !allows(scope, thread.unwrap_or("")) { Err(forbidden()) } else { Ok(()) }
}

#[derive(serde::Deserialize)]
struct PlayRewrite {
    thread: Option<String>,
    name: Option<String>,
    text: Option<String>,
    #[serde(default)]
    edit: bool,
}

async fn play_rewrite(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, Json(body): Json<PlayRewrite>) -> Response {
    if scoped_thread(&scope, body.thread.as_deref()).is_err() {
        return forbidden();
    }
    let name: String = body.name.unwrap_or_else(|| "Guest".into()).chars().take(40).collect();
    let replacement = body.edit.then(|| body.text.unwrap_or_default());
    match crate::team::team_rewrite(state.handler.clone(), state.transcripts.clone(), body.thread.as_deref().unwrap_or(""), &name, replacement.as_deref()).await {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct PlayFork {
    thread: Option<String>,
    index: Option<usize>,
}

async fn play_fork(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, Json(body): Json<PlayFork>) -> Response {
    if scoped_thread(&scope, body.thread.as_deref()).is_err() {
        return forbidden();
    }
    match crate::team::team_fork(state.handler.clone(), state.transcripts.clone(), body.thread.as_deref().unwrap_or(""), body.index.unwrap_or(0)).await {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn play_export(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, axum::extract::Query(q): axum::extract::Query<ThreadQuery>) -> Response {
    let thread = q.thread.clone().unwrap_or_default();
    if scoped_thread(&scope, Some(&thread)).is_err() {
        return forbidden();
    }
    let key = format!("{}{thread}", crate::handler::TEAM_PREFIX);
    let title = state.handler.store.get(&key).and_then(|r| r.title).unwrap_or(thread);
    Json(json!({ "markdown": crate::transcripts::to_markdown(&title, &state.transcripts.get(&key)) })).into_response()
}

async fn play_summarize(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, Json(body): Json<PlaySend>) -> Response {
    if scoped_thread(&scope, body.thread.as_deref()).is_err() {
        return forbidden();
    }
    let thread = body.thread.unwrap_or_default();
    let key = format!("{}{thread}", crate::handler::TEAM_PREFIX);
    let summary = crate::transcripts::summarize(&state.transcripts.get(&key));
    let title = state.handler.store.get(&key).and_then(|r| r.title).unwrap_or_else(|| format!("Summary {thread}"));
    let html = match crate::artifacts::summary_html(&title.chars().take(80).collect::<String>(), &summary) {
        Ok(h) => h,
        Err(err) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    };
    match state.media.save(html.as_bytes(), "text/html", Some("summary.html")).await {
        Ok(saved) => {
            let marker = crate::artifacts::marker(&saved.id, title.trim());
            let _ = state.transcripts.append(&key, vec![crate::team::bot_line(&marker)]).await;
            Json(json!({ "id": saved.id, "marker": marker })).into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct PlayFeedback {
    thread: Option<String>,
    index: Option<usize>,
    vote: Option<String>,
    reason: Option<String>,
}

async fn play_feedback(State(state): State<Arc<AppState>>, Extension(scope): Extension<ShareAccess>, Json(body): Json<PlayFeedback>) -> Response {
    if scoped_thread(&scope, body.thread.as_deref()).is_err() {
        return forbidden();
    }
    let key = format!("{}{}", crate::handler::TEAM_PREFIX, body.thread.unwrap_or_default());
    let messages = state.transcripts.get(&key);
    let Some(reply) = body.index.and_then(|i| messages.get(i)).filter(|m| m.bot) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "that reply is not in the thread" }))).into_response();
    };
    let index = body.index.unwrap_or(0);
    let prompt = messages[..index].iter().rev().find(|m| !m.bot).map(|m| m.text.clone()).unwrap_or_else(|| "(no user message)".into());
    let agent = crate::personas::last_bot_agent(&reply.text, &reply.author).unwrap_or_else(|| reply.author.clone());
    let reply_text = reply.text.clone();
    match crate::admin::evals(&state).add_feedback(&prompt, &reply_text, body.vote.as_deref().unwrap_or("down"), body.reason.as_deref(), &agent).await {
        Ok(case) => Json(case).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
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
