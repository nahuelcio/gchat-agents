use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message as ClientMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
use tower_http::compression::CompressionLayer;
use tower_http::decompression::RequestDecompressionLayer;

use crate::agents::{detect_agents, pi_models};
use crate::handler::TEAM_PREFIX;
use crate::schedules::{describe_cron, job_name, JobPatch, NewJob};
use crate::settings::SettingsPatch;
use crate::state::AppState;
use crate::static_files::serve_static;
use crate::team::{team_delete, team_fork, team_members, team_rewrite, team_send, team_steer, team_thread, thread_id_ok, TeamMemberInput};
use crate::workspace::slug_for;

pub fn admin_router(state: Arc<AppState>) -> Router {
    let app = Router::new()
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/health", get(get_health))
        .route("/api/activity", get(get_activity))
        .route("/api/search", get(get_search))
        .route("/api/agents", get(get_agents))
        .route("/api/agents/pi/models", get(get_pi_models))
        .route("/api/threads", get(get_threads))
        .route("/api/threads/logs", get(get_thread_logs))
        .route("/api/threads/down", post(post_thread_down))
        .route("/api/schedules", get(get_schedules).post(post_schedules))
        .route("/api/schedules/update", post(post_schedules_update))
        .route("/api/schedules/run", post(post_schedules_run))
        .route("/api/schedules/delete", post(post_schedules_delete))
        .route("/api/schedules/log", get(get_schedules_log))
        .route("/api/approvals", get(get_approvals))
        .route("/api/approvals/decide", post(post_approvals_decide))
        .route("/api/gate", post(post_gate))
        .route("/api/usage", get(get_usage))
        .route("/api/insights", get(get_insights))
        .route("/api/insights/analyze", post(post_insights_analyze))
        .route("/api/insights/engram", get(get_insights_engram))
        .route("/api/evals", get(get_evals))
        .route("/api/versions", get(get_versions))
        .route("/api/evals/cases", post(post_evals_cases))
        .route("/api/evals/run", post(post_evals_run))
        .route("/api/evals/runs/delete", post(post_evals_run_delete))
        .route("/api/evals/judge", post(post_evals_judge))
        .route("/api/evals/feedback", post(post_evals_feedback))
        .route("/api/pi/packages", get(get_pi_packages))
        .route("/api/pi/search", get(get_pi_search))
        .route("/api/pi/packages/install", post(post_pi_install))
        .route("/api/pi/packages/remove", post(post_pi_remove))
        .route("/api/threads/touches", get(get_touches))
        .route("/api/schedules/suggest", post(post_schedules_suggest))
        .route("/api/share", get(get_share))
        .route("/api/share/rotate", post(post_share_rotate))
        .route("/api/login", post(post_login))
        .route("/api/logout", post(post_logout))
        .route("/api/me", get(get_me))
        .route("/api/users", get(get_users).post(post_users))
        .route("/api/users/delete", post(post_users_delete))
        .route("/api/triggers", get(get_triggers).post(post_triggers))
        .route("/api/triggers/delete", post(post_triggers_delete))
        .route("/api/docs", get(get_docs).post(post_docs))
        .route("/api/docs/query", post(post_docs_query))
        .route("/api/docs/delete", post(post_docs_delete))
        .route("/api/pi/packages/command", post(post_pi_command))
        .route("/api/google", get(get_google))
        .route("/api/google/key", post(post_google_key))
        .route("/api/google/key/delete", post(post_google_clear))
        .route("/api/google/test", post(post_google_test))
        .route("/api/ado/status", get(get_ado_status))
        .route("/api/ado", post(post_ado_config))
        .route("/api/ado/delete", post(post_ado_clear))
        .route("/api/ado/projects", get(get_ado_projects))
        .route("/api/ado/repos", get(get_ado_repos))
        .route("/api/ado/clone", post(post_ado_clone))
        .route("/api/team/threads", get(get_team_threads))
        .route("/api/team/thread", get(get_team_thread))
        .route("/api/team/send", post(post_team_send))
        .route("/api/team/rewrite", post(post_team_rewrite))
        .route("/api/team/fork", post(post_team_fork))
        .route("/api/team/export", get(get_team_export))
        .route("/api/team/summarize", post(post_team_summarize))
        .route("/api/team/diff", get(get_team_diff))
        .route("/api/team/pr", post(post_team_pr))
        .route("/api/team/steer", post(post_team_steer))
        .route("/api/team/stop", post(post_team_stop))
        .route("/api/team/resume", post(post_team_resume))
        .route("/api/team/archive", post(post_team_archive))
        .route("/api/team/delete", post(post_team_delete))
        .route("/api/team/members", post(post_team_members))
        .route("/api/media/{id}", get(get_media))
        .route("/api/artifacts", post(post_artifact))
        .route("/api/thread/repos", get(get_thread_repos))
        .route("/api/thread/status", get(get_thread_status))
        .route("/api/thread/invite", post(post_thread_invite).put(post_thread_invite))
        .route("/api/thread/repo", post(post_thread_repo).put(post_thread_repo))
        .route("/api/thread/app", post(post_thread_app).put(post_thread_app))
        .route("/api/work-item", axum::routing::put(put_work_item))
        .route("/api/drive/xlsx", post(post_drive_xlsx))
        .route("/api/google/drive-mcp", get(get_drive_mcp).post(post_drive_mcp))
        .route("/api/google/drive-mcp/start", post(post_drive_mcp_start))
        .route("/api/google/drive-mcp/callback", get(get_drive_mcp_callback))
        .route("/api/google/drive-mcp/delete", post(post_drive_mcp_clear))
        .route("/api/drive/mcp/tools", get(get_drive_mcp_tools))
        .route("/api/drive/mcp/call", post(post_drive_mcp_call))
        .route("/api/google/calendar-mcp", get(get_calendar_mcp).post(post_calendar_mcp))
        .route("/api/google/calendar-mcp/start", post(post_calendar_mcp_start))
        .route("/api/google/calendar-mcp/callback", get(get_calendar_mcp_callback))
        .route("/api/google/calendar-mcp/delete", post(post_calendar_mcp_clear))
        .route("/api/calendar/mcp/tools", get(get_calendar_mcp_tools))
        .route("/api/calendar/mcp/call", post(post_calendar_mcp_call))
        .route("/api/google/gmail-mcp", get(get_gmail_mcp).post(post_gmail_mcp))
        .route("/api/google/gmail-mcp/start", post(post_gmail_mcp_start))
        .route("/api/google/gmail-mcp/callback", get(get_gmail_mcp_callback))
        .route("/api/google/gmail-mcp/delete", post(post_gmail_mcp_clear))
        .route("/api/gmail/mcp/tools", get(get_gmail_mcp_tools))
        .route("/api/gmail/mcp/call", post(post_gmail_mcp_call))
        .route("/api/skills", get(get_skills).put(put_skill).delete(delete_skill))
        .route("/api/skills/install", post(post_install_skill))
        .route("/api/skills/search", get(get_skills_search))
        .route("/api/mcp/import", post(post_mcp_import))
        .route("/api/mcp/servers", get(get_mcp_servers))
        .route("/api/mcp/check", post(post_mcp_check))
        .route("/api/mcp/catalog", get(get_mcp_catalog).post(post_mcp_catalog))
        .route("/api/agents/delegates", get(get_delegates))
        .route("/api/agents/ask", post(post_ask_agent))
        .route("/api/ai/draft-agent", post(post_draft_agent))
        .route("/api/ai/draft-skill", post(post_draft_skill))
        .route("/api/ai/draft-agent/chat", post(post_draft_agent_chat))
        .route("/api/ai/draft-skill/chat", post(post_draft_skill_chat))
        .route("/api/ai/draft-host/chat", post(post_draft_host_chat))
        .route("/api/pi/keys", get(get_pi_keys).post(post_pi_key))
        .route("/api/pi/custom-providers", get(get_pi_custom_providers).post(post_pi_custom_provider).delete(delete_pi_custom_provider))
        .route("/api/pi/custom-providers/import-tokenbank", post(import_tokenbank_provider))
        .route("/api/drive/spreadsheets", get(get_drive_spreadsheets))
        .fallback(admin_fallback)
        .layer(axum::extract::DefaultBodyLimit::max(crate::team::UPLOAD_LIMIT))
        .layer(axum::middleware::from_fn_with_state(state.clone(), require_actor))
        .layer(axum::middleware::from_fn(require_local_host))
        .layer(CompressionLayer::new())
        .layer(RequestDecompressionLayer::new())
        .with_state(state.clone());
    app.merge(
        Router::new()
            .route("/api/team/view", get(get_team_view))
            .layer(axum::middleware::from_fn(require_local_host))
            .with_state(state),
    )
}

async fn require_local_host(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if !host_ok(req.headers()) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden host" }))).into_response();
    }
    next.run(req).await
}

async fn require_actor(State(state): State<Arc<AppState>>, req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().as_str().to_string();
    let actor = crate::share::resolve_actor(&state.data_dir, req.headers());
    if actor.is_none() && path != "/api/login" && path != "/api/logout" {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "sign in required", "authRequired": true }))).into_response();
    }
    if let Some(actor) = &actor {
        if !crate::share::role_allows(&actor.role, &method, &path) {
            return (StatusCode::FORBIDDEN, Json(json!({ "error": "this role cannot do that" }))).into_response();
        }
    }
    next.run(req).await
}

async fn admin_fallback(State(state): State<Arc<AppState>>, uri: axum::http::Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    }
    serve_static(state.web_dir.as_deref(), path).await
}

fn host_ok(headers: &HeaderMap) -> bool {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    host == "127.0.0.1" || host == "localhost"
}

async fn get_settings(State(state): State<Arc<AppState>>) -> Response {
    Json(state.settings.get()).into_response()
}

async fn put_settings(State(state): State<Arc<AppState>>, Json(patch): Json<SettingsPatch>) -> Response {
    match state.settings.update(patch).await {
        Ok(s) => {
            snapshot(&state).await;
            Json(s).into_response()
        }
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_health(State(state): State<Arc<AppState>>) -> Response {
    let mut snap = state.health.lock().await.snapshot(std::time::SystemTime::now());
    if let Some(url) = state.public_url.lock().unwrap().as_ref() {
        snap.endpoint = Some(format!("{url}/google/chat"));
    }
    Json(snap).into_response()
}

async fn get_agents(State(_state): State<Arc<AppState>>) -> Response {
    Json(detect_agents().await).into_response()
}

#[derive(Deserialize)]
struct RefreshQuery {
    refresh: Option<String>,
}

async fn get_pi_models(State(state): State<Arc<AppState>>, Query(q): Query<RefreshQuery>) -> Response {
    let mut models = pi_models().await;
    models.extend(crate::agents::custom_pi_models(&state.data_dir));
    let path = if q.refresh.as_deref() == Some("1") { "/models?refresh=1" } else { "/models" };
    if let Ok(v) = crate::pi_sidecar::call(reqwest::Method::GET, path, None).await {
        if let Some(list) = v.as_array() {
            models.extend(list.iter().filter_map(|item| item.as_str().map(str::to_string)));
        }
    }
    models.sort();
    models.dedup();
    Json(models).into_response()
}

async fn get_threads(State(state): State<Arc<AppState>>) -> Response {
    let personas = state.settings.get().personas;
    let workdir = state.handler.config.lock().unwrap().workdir.clone();
    let mut threads: Vec<Value> = state
        .handler
        .store
        .all()
        .into_iter()
        .map(|(key, r)| {
            let slug = slug_for(&key);
            json!({
                "key": key,
                "slug": slug,
                "space": r.space,
                "repo": r.repo,
                "branch": r.branch,
                "title": r.title,
                "folder": r.worktree.clone().unwrap_or_else(|| workdir.clone()),
                "speaking": crate::handler::speaking(&key),
                "worktree": r.worktree,
                "updatedAt": r.updated_at,
                "hasSession": r.session_ref.is_some(),
                "members": crate::team::effective_members(Some(&r), &personas)
                    .iter()
                    .map(|m| match m {
                        crate::session::RoomMember::Agent { persona, .. } => format!("@{persona}"),
                        crate::session::RoomMember::Human { name, .. } => name.clone(),
                    })
                    .collect::<Vec<_>>(),
                "driver": r.driver,
                "model": r.model,
                "app": {
                    "running": state.workspaces.is_up(&slug),
                    "port": state.workspaces.port(&slug),
                }
            })
        })
        .collect();
    threads.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(a.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Json(threads).into_response()
}

#[derive(Deserialize)]
struct SlugQuery {
    slug: Option<String>,
}

async fn get_thread_logs(State(state): State<Arc<AppState>>, Query(q): Query<SlugQuery>) -> Response {
    let slug = q.slug.unwrap_or_default();
    Json(json!({ "logs": state.workspaces.logs(&slug, 200) })).into_response()
}

#[derive(Deserialize)]
struct DownBody {
    slug: String,
}

async fn post_thread_down(State(state): State<Arc<AppState>>, Json(body): Json<DownBody>) -> Response {
    Json(json!({ "stopped": state.workspaces.down(&body.slug) })).into_response()
}

async fn get_schedules(State(state): State<Arc<AppState>>) -> Response {
    let jobs: Vec<Value> = state
        .schedules
        .all()
        .into_iter()
        .map(|j| {
            let mut v = serde_json::to_value(&j).unwrap_or(json!({}));
            if let Some(obj) = v.as_object_mut() {
                obj.insert("when".into(), json!(describe_cron(&j.cron)));
            }
            v
        })
        .collect();
    Json(jobs).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleBody {
    id: Option<String>,
    name: Option<String>,
    prompt: Option<String>,
    cron: Option<String>,
    space: Option<String>,
    repo: Option<String>,
    enabled: Option<bool>,
    trigger: Option<String>,
    command: Option<String>,
    pattern: Option<String>,
    needs_approval: Option<bool>,
    precheck: Option<String>,
    webhook: Option<String>,
    notify_failures: Option<bool>,
}

async fn post_schedules(State(state): State<Arc<AppState>>, Json(body): Json<ScheduleBody>) -> Response {
    let prompt = body.prompt.unwrap_or_default();
    let cron = body.cron.unwrap_or_default();
    let on_cron = body.trigger.as_deref().is_none_or(|t| t == "cron");
    if prompt.trim().is_empty() || (on_cron && cron.is_empty()) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "prompt and cron are required" }))).into_response();
    }
    let name = body
        .name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| job_name(&prompt, 48));
    match state
        .schedules
        .add(
            NewJob {
                name,
                prompt: prompt.trim().to_string(),
                cron,
                space: body.space.unwrap_or_else(|| "team-chat".into()),
                created_by: "control plane".into(),
                repo: body.repo,
                trigger: body.trigger,
                command: body.command,
                pattern: body.pattern,
                needs_approval: body.needs_approval.unwrap_or(false),
                precheck: body.precheck,
                webhook: body.webhook,
                notify_failures: body.notify_failures,
            },
            chrono::Local::now(),
        )
        .await
    {
        Ok(_) => get_schedules(State(state)).await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_schedules_update(State(state): State<Arc<AppState>>, Json(body): Json<ScheduleBody>) -> Response {
    let Some(id) = body.id else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    };
    match state
        .schedules
        .update(
            &id,
            JobPatch {
                enabled: body.enabled,
                cron: body.cron,
                prompt: body.prompt,
                name: body.name,
                precheck: body.precheck,
                space: body.space,
                webhook: body.webhook,
                notify_failures: body.notify_failures,
                ..Default::default()
            },
            chrono::Local::now(),
        )
        .await
    {
        Ok(_) => get_schedules(State(state)).await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_schedules_run(State(state): State<Arc<AppState>>, Json(body): Json<ScheduleBody>) -> Response {
    let Some(id) = body.id else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    };
    let scheduler = state.scheduler.clone();
    let id2 = id.clone();
    tokio::spawn(async move {
        let _ = scheduler.run_now(&id2, chrono::Local::now()).await;
    });
    get_schedules(State(state)).await
}

async fn post_schedules_delete(State(state): State<Arc<AppState>>, Json(body): Json<ScheduleBody>) -> Response {
    let Some(id) = body.id else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    };
    let _ = state.schedules.remove(&id).await;
    let _ = state.transcripts.remove(&format!("schedule/{id}")).await;
    get_schedules(State(state)).await
}

#[derive(Deserialize)]
struct IdQuery {
    id: Option<String>,
}

async fn get_approvals(State(state): State<Arc<AppState>>) -> Response {
    let list: Vec<Value> = state
        .scheduler
        .approvals()
        .into_iter()
        .filter_map(|j| {
            let p = j.pending.clone()?;
            Some(json!({ "id": p.id, "at": p.at, "reason": p.reason, "jobId": j.id, "name": j.name, "prompt": j.prompt }))
        })
        .chain(crate::gate::pending().into_iter().map(|g| {
            json!({ "id": g.id, "at": g.at, "reason": g.kind, "name": format!("Agent wants to run {}", g.tool), "prompt": g.detail, "thread": g.thread_key, "gate": true })
        }))
        .collect();
    Json(list).into_response()
}

async fn get_touches(State(state): State<Arc<AppState>>, Query(q): Query<ThreadKeyQuery>) -> Response {
    let Some(key) = thread_key_of(q.thread_key) else {
        return missing_thread_key();
    };
    let raw = tail(&state.data_dir.join("touches.jsonl"), 2 * 1024 * 1024);
    let mut list: Vec<Value> = raw
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("thread").and_then(|t| t.as_str()) == Some(key.as_str()))
        .collect();
    let start = list.len().saturating_sub(300);
    list.drain(..start);
    list.reverse();
    Json(list).into_response()
}

fn tail(path: &std::path::Path, max: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(max)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    if len > max { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { text }
}

fn harness_reply(r: Result<Value, String>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct PiSearchQuery {
    q: Option<String>,
    from: Option<u32>,
}

async fn get_pi_search(Query(q): Query<PiSearchQuery>) -> Response {
    let text = format!("keywords:pi-package {}", q.q.unwrap_or_default().trim());
    let res = reqwest::Client::new()
        .get("https://registry.npmjs.org/-/v1/search")
        .query(&[("text", text.trim().to_string()), ("size", "24".into()), ("from", q.from.unwrap_or(0).to_string())])
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    let body: Value = match res {
        Ok(r) => r.json().await.unwrap_or(Value::Null),
        Err(err) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("npm search failed: {err}") }))).into_response(),
    };
    let items: Vec<Value> = body["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|o| {
            let p = &o["package"];
            json!({
                "name": p["name"],
                "version": p["version"],
                "description": p["description"],
                "keywords": p["keywords"],
                "publisher": p["publisher"]["username"],
                "updated": o["updated"].as_str().or(p["date"].as_str()),
                "monthly": o["downloads"]["monthly"],
                "npm": p["links"]["npm"],
                "repository": p["links"]["repository"],
                "homepage": p["links"]["homepage"],
            })
        })
        .collect();
    Json(json!({ "total": body["total"], "items": items })).into_response()
}

async fn get_pi_packages() -> Response {
    harness_reply(crate::pi_sidecar::call(reqwest::Method::GET, "/packages", None).await)
}

async fn post_pi_install(Json(body): Json<Value>) -> Response {
    harness_reply(crate::pi_sidecar::call(reqwest::Method::POST, "/packages/install", Some(body)).await)
}

async fn post_pi_remove(Json(body): Json<Value>) -> Response {
    harness_reply(crate::pi_sidecar::call(reqwest::Method::POST, "/packages/remove", Some(body)).await)
}

#[derive(Deserialize)]
struct UsageQuery {
    days: Option<i64>,
}

#[derive(Deserialize)]
struct InsightsQuery {
    days: Option<u32>,
    agent: Option<String>,
    repo: Option<String>,
    thread: Option<String>,
    project: Option<String>,
}

impl InsightsQuery {
    fn filter(&self) -> Value {
        let pick = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        json!({ "agent": pick(&self.agent), "repo": pick(&self.repo), "thread": pick(&self.thread) })
    }
}

async fn get_insights(State(state): State<Arc<AppState>>, Query(q): Query<InsightsQuery>) -> Response {
    harness_reply(crate::insights::collect(&state.handler.store, q.days.unwrap_or(7).clamp(1, 90), q.filter(), &snapshot(&state).await).await)
}

async fn get_insights_engram(Query(q): Query<InsightsQuery>) -> Response {
    harness_reply(crate::insights::collect_engram(q.project.as_deref()).await)
}

#[derive(Deserialize)]
struct AnalyzeBody {
    focus: Option<String>,
    source: Option<String>,
    #[serde(flatten)]
    q: InsightsQuery,
}

async fn post_insights_analyze(State(state): State<Arc<AppState>>, Json(b): Json<AnalyzeBody>) -> Response {
    if b.source.as_deref() == Some("engram") {
        let result = match crate::insights::collect_engram(b.q.project.as_deref()).await {
            Ok(d) if d.get("available").and_then(|v| v.as_bool()) == Some(false) => Err("Engram is not installed or has no memory yet".to_string()),
            Ok(d) => crate::insights::analyze_engram(&state.handler.driver, &d, b.focus.as_deref().unwrap_or(""), &draft_ctx(&state)).await,
            Err(e) => Err(e),
        };
        return match result {
            Ok(report) => Json(json!({ "report": report })).into_response(),
            Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
        };
    }
    let digest = match crate::insights::collect(&state.handler.store, b.q.days.unwrap_or(7).clamp(1, 90), b.q.filter(), &snapshot(&state).await).await {
        Ok(d) => d,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response(),
    };
    let focus = b.focus.as_deref().unwrap_or("");
    let result = if b.source.as_deref() == Some("talk") {
        crate::insights::analyze_talk(&state.handler.driver, &digest, focus, &draft_ctx(&state)).await
    } else {
        crate::insights::analyze(&state.handler.driver, &digest, focus, &draft_ctx(&state)).await
    };
    match result {
        Ok(report) => Json(json!({ "report": report })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

pub(crate) fn evals(state: &AppState) -> Arc<crate::evals::EvalStore> {
    static STORE: std::sync::OnceLock<Arc<crate::evals::EvalStore>> = std::sync::OnceLock::new();
    STORE.get_or_init(|| Arc::new(crate::evals::EvalStore::open(state.data_dir.join("evals.json")))).clone()
}

fn versions(state: &AppState) -> Arc<crate::versions::VersionStore> {
    static STORE: std::sync::OnceLock<Arc<crate::versions::VersionStore>> = std::sync::OnceLock::new();
    STORE.get_or_init(|| Arc::new(crate::versions::VersionStore::open(state.data_dir.join("versions.json")))).clone()
}

async fn snapshot(state: &AppState) -> Vec<crate::versions::Version> {
    let store = versions(state);
    let settings = state.settings.get();
    let now = tokio::task::spawn_blocking(move || crate::versions::current(&settings)).await.unwrap_or_default();
    let _ = store.record(now).await;
    store.all()
}

async fn get_versions(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "versions": snapshot(&state).await })).into_response()
}

fn bad(e: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response()
}

async fn get_evals(State(state): State<Arc<AppState>>) -> Response {
    let store = evals(&state);
    Json(json!({ "cases": store.cases(), "runs": store.runs(), "judgments": store.judgments() })).into_response()
}

#[derive(Deserialize)]
struct EvalCasesBody {
    cases: Vec<crate::evals::Case>,
}

async fn post_evals_cases(State(state): State<Arc<AppState>>, Json(b): Json<EvalCasesBody>) -> Response {
    match evals(&state).set_cases(b.cases).await {
        Ok(cases) => Json(json!({ "cases": cases })).into_response(),
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct EvalRunBody {
    model: Option<String>,
    label: Option<String>,
    #[serde(default)]
    cases: Vec<String>,
}

async fn post_evals_run(State(state): State<Arc<AppState>>, Json(b): Json<EvalRunBody>) -> Response {
    let options = (state.handler.options)();
    let all = snapshot(&state).await;
    match crate::evals::start_run(evals(&state), state.handler.driver.clone(), options, draft_ctx(&state), b.model, b.label, b.cases, &all).await {
        Ok(run) => Json(json!({ "run": run })).into_response(),
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct IdBody {
    id: String,
}

async fn post_evals_run_delete(State(state): State<Arc<AppState>>, Json(b): Json<IdBody>) -> Response {
    match evals(&state).delete_run(&b.id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct EvalJudgeBody {
    n: Option<usize>,
    #[serde(flatten)]
    q: InsightsQuery,
}

async fn post_evals_judge(State(state): State<Arc<AppState>>, Json(b): Json<EvalJudgeBody>) -> Response {
    let digest = match crate::insights::collect(&state.handler.store, b.q.days.unwrap_or(7).clamp(1, 90), b.q.filter(), &snapshot(&state).await).await {
        Ok(d) => d,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response(),
    };
    match crate::evals::judge_sample(&evals(&state), &state.handler.driver, &digest, b.n.unwrap_or(15).clamp(1, 40), &draft_ctx(&state)).await {
        Ok(js) => Json(json!({ "judged": js.len() })).into_response(),
        Err(e) => bad(e),
    }
}

async fn get_usage(State(state): State<Arc<AppState>>, Query(q): Query<UsageQuery>) -> Response {
    let days = q.days.unwrap_or(30).clamp(1, 366);
    let since = (chrono::Local::now() - chrono::Duration::days(days - 1)).format("%Y-%m-%d").to_string();
    let mut report = crate::usage::global().map(|l| l.report(&since)).unwrap_or_default();
    for row in &mut report.by_thread {
        if let Some(title) = state.handler.store.get(&row.key).and_then(|r| r.title) {
            row.key = format!("{}	{title}", row.key);
        }
    }
    Json(json!({ "days": days, "report": report })).into_response()
}

#[derive(Deserialize)]
struct GateBody {
    thread: Option<String>,
    tool: String,
    detail: String,
    kind: String,
}

fn approval_for(state: &AppState, thread: &str) -> crate::settings::ApprovalMode {
    let settings = state.settings.get();
    let record = state.handler.store.get(thread);
    let repo = record.as_ref().and_then(|r| r.repo.as_deref()).unwrap_or("");
    let repo_mode = settings.repo_approvals.iter().find(|(k, _)| k.eq_ignore_ascii_case(repo)).map(|(_, m)| *m);
    let agent_mode = crate::handler::speaking(thread).into_iter().find_map(|name| {
        let key = name.trim_start_matches('@');
        settings.agent_approvals.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, m)| *m)
    });
    crate::gate::effective_mode(settings.approvals, agent_mode, repo_mode)
}

async fn post_gate(State(state): State<Arc<AppState>>, Json(body): Json<GateBody>) -> Response {
    let thread = body.thread.clone().unwrap_or_default();
    if !crate::gate::needs_gate(approval_for(&state, &thread), &body.kind) {
        return Json(json!({ "approve": true })).into_response();
    }
    let (info, rx) = crate::gate::open(&thread, &body.tool, &body.detail, &body.kind);
    let summary = crate::gate::summary(&info);
    crate::handler::note(&state.handler, "approval_pending", &thread, format!("{} needs approval ({})", info.tool, info.id), info.detail.clone()).await;
    if let Some((space, chat_thread)) = crate::gate::route(&thread) {
        let msg = crate::google::PostMessageBody { text: summary, thread: chat_thread, cards_v2: Some(crate::gate::card(&info)) };
        if let Err(err) = state.handler.chat.post_message(&space, &msg).await {
            tracing::error!(%err, "approval card failed");
        }
    } else if thread.starts_with(TEAM_PREFIX) {
        let _ = state.transcripts.append(&thread, vec![crate::team::bot_line(&summary)]).await;
    }
    let approve = match tokio::time::timeout(crate::gate::WAIT, rx).await {
        Ok(Ok(v)) => v,
        _ => {
            crate::gate::forget(&info.id);
            false
        }
    };
    crate::handler::note(&state.handler, "approval_decided", &thread, format!("{} {}", info.tool, if approve { "approved" } else { "denied" }), info.detail.clone()).await;
    Json(json!({ "approve": approve, "id": info.id })).into_response()
}

#[derive(Deserialize)]
struct DecideBody {
    id: Option<String>,
    approve: Option<bool>,
}

async fn post_approvals_decide(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<DecideBody>) -> Response {
    let (Some(id), Some(approve)) = (body.id, body.approve) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "id and approve are required" }))).into_response();
    };
    let actor = crate::share::resolve_actor(&state.data_dir, &headers).map(|a| a.name).unwrap_or_else(|| "local".into());
    if id.starts_with('g') {
        return match crate::gate::decide(&id, approve) {
            Some(info) => {
                state.activity.record("approval_decided", &info.thread_key, &info.tool, format!("{} by {actor}", if approve { "approved" } else { "denied" })).await;
                Json(json!({ "id": info.id, "name": info.tool, "approved": approve, "by": actor })).into_response()
            }
            None => (StatusCode::NOT_FOUND, Json(json!({ "error": format!("no pending approval {id}") }))).into_response(),
        };
    }
    match state.scheduler.decide(&id, approve, chrono::Local::now()).await {
        Ok(job) => Json(job).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_schedules_log(State(state): State<Arc<AppState>>, Query(q): Query<IdQuery>) -> Response {
    let id = q.id.unwrap_or_default();
    if state.schedules.get(&id).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "job not found" }))).into_response();
    }
    Json(json!({ "messages": state.transcripts.get(&format!("schedule/{id}")) })).into_response()
}

#[derive(Deserialize)]
struct SuggestBody {
    text: Option<String>,
}

async fn post_schedules_suggest(Json(body): Json<SuggestBody>) -> Response {
    let text = body.text.unwrap_or_default();
    Json(json!({
        "name": job_name(&text, 48),
        "prompt": text,
        "cron": "0 9 * * 1-5",
        "when": describe_cron("0 9 * * 1-5"),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct ActivityQuery {
    limit: Option<usize>,
    kind: Option<String>,
}

async fn get_activity(State(state): State<Arc<AppState>>, Query(q): Query<ActivityQuery>) -> Response {
    let kinds: Vec<&str> = q.kind.as_deref().map(|k| k.split(',').filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    Json(state.activity.recent(q.limit.unwrap_or(50).min(500), &kinds)).into_response()
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    limit: Option<usize>,
}

async fn get_search(State(state): State<Arc<AppState>>, Query(q): Query<SearchQuery>) -> Response {
    let query = q.q.unwrap_or_default();
    if query.trim().chars().count() < 2 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "q needs at least 2 characters" }))).into_response();
    }
    Json(state.transcripts.search(query.trim(), q.limit.unwrap_or(30).min(30))).into_response()
}

#[derive(Deserialize)]
struct ShareQuery {
    thread: Option<String>,
}

async fn get_share(State(state): State<Arc<AppState>>, Query(q): Query<ShareQuery>) -> Response {
    let url = state.public_url.lock().unwrap().clone();
    let Some(url) = url else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "sharing needs the tunnel" }))).into_response();
    };
    let share = state.share.lock().await;
    match q.thread {
        Some(thread) if thread_id_ok(&thread) => Json(json!({ "link": format!("{url}/play#{}&thread={thread}", share.scoped(&thread)) })).into_response(),
        Some(_) => (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response(),
        None => Json(json!({ "link": format!("{url}/play#{}", share.value()) })).into_response(),
    }
}

async fn post_share_rotate(State(state): State<Arc<AppState>>) -> Response {
    let url = state.public_url.lock().unwrap().clone();
    let Some(url) = url else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "sharing needs the tunnel" }))).into_response();
    };
    let token = state.share.lock().await.rotate().to_string();
    state.activity.record("share_rotate", "", "Share link rotated", "").await;
    Json(json!({ "link": format!("{url}/play#{token}") })).into_response()
}

async fn get_google(State(state): State<Arc<AppState>>) -> Response {
    let mut status = state.google.status();
    if let Some(url) = state.public_url.lock().unwrap().as_ref() {
        status.endpoint = Some(format!("{url}/google/chat"));
    }
    Json(status).into_response()
}

#[derive(Deserialize)]
struct GoogleKeyBody {
    key: Option<String>,
    space: Option<String>,
}

async fn post_google_key(State(state): State<Arc<AppState>>, Json(body): Json<GoogleKeyBody>) -> Response {
    match state.google.set_key(&body.key.unwrap_or_default()).await {
        Ok(()) => get_google(State(state)).await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_google_clear(State(state): State<Arc<AppState>>) -> Response {
    let _ = state.google.clear_key().await;
    get_google(State(state)).await
}

async fn post_google_test(State(state): State<Arc<AppState>>, Json(body): Json<GoogleKeyBody>) -> Response {
    let space = body.space.unwrap_or_default();
    if !regex::Regex::new(r"^spaces/[^/\s]+$").unwrap().is_match(&space) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Pick a space (spaces/XXXX)" }))).into_response();
    }
    match state
        .google
        .post_message(
            &space,
            &crate::google::PostMessageBody::text("Relay is connected. Mention me in a thread to start."),
        )
        .await
    {
        Ok(()) => get_google(State(state)).await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_ado_status(State(state): State<Arc<AppState>>) -> Response {
    let has_env_pat = crate::integrations::env_ado_pat().is_some();
    match crate::integrations::resolve_ado(&state.data_dir) {
        Some(ado) => Json(json!({
            "connected": true,
            "org": ado.org,
            "profile": ado.profile,
            "projects": ado.projects,
            "defaultProject": ado.default_project,
            "source": ado.source,
            "hasEnvPat": has_env_pat,
        }))
        .into_response(),
        None => Json(json!({ "connected": false, "hasEnvPat": has_env_pat })).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdoConfigBody {
    org: Option<String>,
    pat: Option<String>,
    default_project: Option<String>,
}

async fn post_ado_config(State(state): State<Arc<AppState>>, Json(body): Json<AdoConfigBody>) -> Response {
    let org = body.org.unwrap_or_default();
    let mut pat = body.pat.unwrap_or_default();
    if pat.trim().is_empty() {
        if let Some(prev) = crate::integrations::load_stored_ado(&state.data_dir) {
            pat = prev.pat;
        } else if let Some(env_pat) = crate::integrations::env_ado_pat() {
            pat = env_pat;
        }
    }
    match crate::integrations::save_ado(
        &state.data_dir,
        &org,
        &pat,
        body.default_project.as_deref(),
    )
    .await
    {
        Ok(ado) => Json(json!({
            "connected": true,
            "org": ado.org,
            "profile": ado.profile,
            "projects": ado.projects,
            "defaultProject": ado.default_project,
            "source": ado.source,
            "hasEnvPat": crate::integrations::env_ado_pat().is_some(),
        }))
        .into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_ado_clear(State(state): State<Arc<AppState>>) -> Response {
    if let Err(err) = crate::integrations::clear_ado(&state.data_dir).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))).into_response();
    }
    match crate::integrations::resolve_ado(&state.data_dir) {
        Some(ado) => Json(json!({
            "connected": true,
            "org": ado.org,
            "profile": ado.profile,
            "projects": ado.projects,
            "defaultProject": ado.default_project,
            "source": ado.source,
        }))
        .into_response(),
        None => Json(json!({ "connected": false })).into_response(),
    }
}

fn ado_missing() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error": "Azure DevOps not configured — paste your org and PAT in Settings → Connections, or run `ado init`"
        })),
    )
        .into_response()
}

async fn get_ado_projects(State(state): State<Arc<AppState>>) -> Response {
    let Some(ado) = crate::integrations::resolve_ado(&state.data_dir) else {
        return ado_missing();
    };
    let client = reqwest::Client::new();
    let auth = crate::integrations::AdoAuth {
        org: ado.org,
        pat: ado.pat,
    };
    match crate::integrations::ado_projects(&auth, &client).await {
        Ok(list) => Json(list).into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct AdoReposQuery {
    project: Option<String>,
}

async fn get_ado_repos(State(state): State<Arc<AppState>>, Query(q): Query<AdoReposQuery>) -> Response {
    let Some(ado) = crate::integrations::resolve_ado(&state.data_dir) else {
        return ado_missing();
    };
    let Some(project) = q.project.filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "project is required" }))).into_response();
    };
    let client = reqwest::Client::new();
    let auth = crate::integrations::AdoAuth {
        org: ado.org,
        pat: ado.pat,
    };
    match crate::integrations::ado_repos(&auth, &project, &client).await {
        Ok(list) => Json(list).into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct AdoCloneBody {
    project: Option<String>,
    repo: Option<String>,
}

async fn post_ado_clone(State(state): State<Arc<AppState>>, Json(body): Json<AdoCloneBody>) -> Response {
    let Some(ado) = crate::integrations::resolve_ado(&state.data_dir) else {
        return ado_missing();
    };
    let project = body.project.unwrap_or_default();
    let repo = body.repo.unwrap_or_default();
    if project.is_empty() || repo.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "project and repo are required" }))).into_response();
    }
    let client = reqwest::Client::new();
    let auth = crate::integrations::AdoAuth {
        org: ado.org.clone(),
        pat: ado.pat.clone(),
    };
    let repos = match crate::integrations::ado_repos(&auth, &project, &client).await {
        Ok(r) => r,
        Err(err) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    };
    let Some(found) = repos.into_iter().find(|r| r.name == repo) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("repo \"{repo}\" not found in {project}") })),
        )
            .into_response();
    };
    let name = regex::Regex::new(r"[^a-zA-Z0-9._-]+")
        .unwrap()
        .replace_all(&repo, "-")
        .to_string();
    if state.settings.get().repos.contains_key(&name) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("a repo named \"{name}\" is already configured") })),
        )
            .into_response();
    }
    let dest = state.data_dir.join("repos").join(&name);
    if let Err(err) = crate::integrations::clone_repo(&found.remote_url, &dest, &ado.pat).await {
        return (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("clone failed: {err}") }))).into_response();
    }
    let mut repos_map = state.settings.get().repos.clone();
    repos_map.insert(
        name,
        crate::config::RepoConfig {
            path: dest.to_string_lossy().into_owned(),
            up: None,
            base: found.default_branch,
        },
    );
    match state
        .settings
        .update(crate::settings::SettingsPatch {
            repos: Some(repos_map),
            ..Default::default()
        })
        .await
    {
        Ok(s) => Json(s).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct ArchivedQuery {
    archived: Option<String>,
}

async fn get_team_threads(State(state): State<Arc<AppState>>, Query(q): Query<ArchivedQuery>) -> Response {
    let archived = q.archived.as_deref() == Some("1");
    let mut list: Vec<Value> = Vec::new();
    let gated: Vec<String> = crate::gate::pending().into_iter().map(|g| g.thread_key).collect();
    for t in state.transcripts.list(TEAM_PREFIX, archived) {
        let title = state.handler.store.get(&t.key).and_then(|r| r.title).unwrap_or(t.title);
        let busy = state.handler.queue.busy(&t.key).await || crate::handler::lanes_busy(&t.key);
        list.push(json!({
            "id": t.key.strip_prefix(TEAM_PREFIX).unwrap_or(&t.key),
            "title": title,
            "updatedAt": t.updated_at,
            "count": t.count,
            "busy": busy,
            "needsApproval": gated.contains(&t.key),
        }));
    }
    Json(list).into_response()
}

#[derive(Deserialize)]
struct ThreadQuery {
    thread: Option<String>,
}

async fn get_team_thread(State(state): State<Arc<AppState>>, Query(q): Query<ThreadQuery>) -> Response {
    let thread = q.thread.unwrap_or_default();
    match team_thread(state.handler.clone(), state.transcripts.clone(), &thread).await {
        Ok(t) => Json(t).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_team_view(ws: WebSocketUpgrade, Query(q): Query<ThreadQuery>) -> Response {
    let thread = q.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    let mut url = reqwest::Url::parse(&format!("ws://127.0.0.1:{}/view", crate::pi_sidecar::port())).expect("pi harness url");
    url.query_pairs_mut().append_pair("thread", &format!("{TEAM_PREFIX}{thread}"));
    ws.on_upgrade(move |client| relay_view(client, url))
}

async fn relay_view(client: WebSocket, url: reqwest::Url) {
    let Ok((upstream, _)) = tokio_tungstenite::connect_async(url.as_str()).await else {
        return;
    };
    let (mut to_client, mut from_client) = client.split();
    let (mut to_upstream, mut from_upstream) = upstream.split();
    let up = async {
        while let Some(Ok(message)) = from_client.next().await {
            let outgoing = match message {
                ClientMessage::Text(text) => UpstreamMessage::Text(text.as_str().into()),
                ClientMessage::Binary(bytes) => UpstreamMessage::Binary(bytes),
                ClientMessage::Ping(bytes) => UpstreamMessage::Ping(bytes),
                ClientMessage::Pong(bytes) => UpstreamMessage::Pong(bytes),
                ClientMessage::Close(_) => break,
            };
            if to_upstream.send(outgoing).await.is_err() {
                break;
            }
        }
    };
    let down = async {
        while let Some(Ok(message)) = from_upstream.next().await {
            let outgoing = match message {
                UpstreamMessage::Text(text) => ClientMessage::Text(text.as_str().into()),
                UpstreamMessage::Binary(bytes) => ClientMessage::Binary(bytes),
                UpstreamMessage::Ping(bytes) => ClientMessage::Ping(bytes),
                UpstreamMessage::Pong(bytes) => ClientMessage::Pong(bytes),
                UpstreamMessage::Close(_) => break,
                UpstreamMessage::Frame(_) => continue,
            };
            if to_client.send(outgoing).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

#[derive(Deserialize)]
struct TeamSendBody {
    thread: Option<String>,
    text: Option<String>,
    name: Option<String>,
    attachments: Option<Vec<crate::team::TeamAttachmentInput>>,
    #[serde(rename = "replyTo")]
    reply_to: Option<crate::transcripts::Quote>,
}

async fn post_team_send(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<TeamSendBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    let text = body.text.unwrap_or_default();
    let name = body.name.unwrap_or_else(|| "Owner".into());
    let actor = crate::share::resolve_actor(&state.data_dir, &headers).map(|a| a.name).unwrap_or_else(|| "local".into());
    state.activity.record("team_send", &format!("{TEAM_PREFIX}{thread}"), &name, format!("by {actor}")).await;
    match team_send(
        state.handler.clone(),
        state.transcripts.clone(),
        &thread,
        &text,
        &name.chars().take(40).collect::<String>(),
        None,
        body.attachments.as_deref().unwrap_or_default(),
        body.reply_to,
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct TeamSteerBody {
    thread: Option<String>,
    text: Option<String>,
    name: Option<String>,
    #[serde(rename = "replyTo")]
    reply_to: Option<crate::transcripts::Quote>,
}

#[derive(Deserialize)]
struct RewriteBody {
    thread: Option<String>,
    name: Option<String>,
    text: Option<String>,
    #[serde(default)]
    edit: bool,
}

async fn post_team_rewrite(State(state): State<Arc<AppState>>, Json(body): Json<RewriteBody>) -> Response {
    let name: String = body.name.unwrap_or_else(|| "Owner".into()).chars().take(40).collect();
    let replacement = if body.edit { Some(body.text.unwrap_or_default()) } else { None };
    match team_rewrite(state.handler.clone(), state.transcripts.clone(), body.thread.as_deref().unwrap_or(""), &name, replacement.as_deref()).await {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct ForkBody {
    thread: Option<String>,
    index: Option<usize>,
}

async fn post_team_fork(State(state): State<Arc<AppState>>, Json(body): Json<ForkBody>) -> Response {
    match team_fork(state.handler.clone(), state.transcripts.clone(), body.thread.as_deref().unwrap_or(""), body.index.unwrap_or(0)).await {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_team_export(State(state): State<Arc<AppState>>, Query(q): Query<ThreadQuery>) -> Response {
    let thread = q.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    let key = format!("{TEAM_PREFIX}{thread}");
    let messages = state.transcripts.get(&key);
    let title = state.handler.store.get(&key).and_then(|r| r.title).unwrap_or_else(|| thread.clone());
    Json(json!({ "markdown": crate::transcripts::to_markdown(&title, &messages) })).into_response()
}

async fn post_team_summarize(State(state): State<Arc<AppState>>, Json(body): Json<TeamThreadBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    let key = format!("{TEAM_PREFIX}{thread}");
    let messages = state.transcripts.get(&key);
    let title = state.handler.store.get(&key).and_then(|r| r.title).unwrap_or_else(|| format!("Summary {thread}"));
    let summary = crate::transcripts::summarize(&messages);
    let html = match crate::artifacts::summary_html(&title.chars().take(80).collect::<String>(), &summary) {
        Ok(h) => h,
        Err(err) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    };
    let name = format!("{}.html", title.chars().take(40).collect::<String>());
    match state.media.save(html.as_bytes(), "text/html", Some(&name)).await {
        Ok(saved) => {
            let marker = crate::artifacts::marker(&saved.id, title.trim());
            let _ = state.transcripts.append(&key, vec![crate::team::bot_line(&marker)]).await;
            Json(json!({ "id": saved.id, "marker": marker })).into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_team_diff(State(state): State<Arc<AppState>>, Query(q): Query<ThreadQuery>) -> Response {
    let thread = q.thread.unwrap_or_default();
    let key = format!("{TEAM_PREFIX}{thread}");
    let Some(dir) = state.handler.store.get(&key).and_then(|r| r.worktree) else {
        return Json(json!({ "files": [] })).into_response();
    };
    Json(json!({ "files": state.workspaces.diffs_in(&dir).await })).into_response()
}

#[derive(Deserialize)]
struct PrBody {
    thread: Option<String>,
    title: Option<String>,
    body: Option<String>,
}

async fn post_team_pr(State(state): State<Arc<AppState>>, Json(body): Json<PrBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    let key = format!("{TEAM_PREFIX}{thread}");
    let Some(dir) = state.handler.store.get(&key).and_then(|r| r.worktree) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "this thread has no worktree" }))).into_response();
    };
    let title = body.title.unwrap_or_else(|| format!("switchboard {thread}"));
    let text = body.body.unwrap_or_default();
    match crate::workspace::open_pull_request(&dir, &title, &text, &state.data_dir).await {
        Ok(url) => Json(json!({ "url": url })).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct FeedbackBody {
    thread: Option<String>,
    index: Option<usize>,
    vote: Option<String>,
    reason: Option<String>,
}

async fn post_evals_feedback(State(state): State<Arc<AppState>>, Json(body): Json<FeedbackBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    let key = format!("{TEAM_PREFIX}{thread}");
    let messages = state.transcripts.get(&key);
    let index = body.index.unwrap_or(usize::MAX);
    let Some(reply) = messages.get(index).filter(|m| m.bot) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "that reply is not in the thread" }))).into_response();
    };
    let prompt = messages[..index].iter().rev().find(|m| !m.bot).map(|m| m.text.clone()).unwrap_or_else(|| "(no user message)".into());
    let agent = crate::personas::last_bot_agent(&reply.text, &reply.author).unwrap_or_else(|| reply.author.clone());
    match evals(&state).add_feedback(&prompt, &reply.text, body.vote.as_deref().unwrap_or("down"), body.reason.as_deref(), &agent).await {
        Ok(case) => Json(case).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct LoginBody {
    name: Option<String>,
    password: Option<String>,
    role: Option<String>,
}

fn users(state: &AppState) -> crate::share::UserStore {
    crate::share::UserStore::open(state.data_dir.join("users.json"))
}

async fn get_me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    match crate::share::resolve_actor(&state.data_dir, &headers) {
        Some(actor) => Json(json!({ "name": actor.name, "role": actor.role, "authRequired": !users(&state).is_empty() })).into_response(),
        None => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "sign in required", "authRequired": true }))).into_response(),
    }
}

async fn post_login(State(state): State<Arc<AppState>>, Json(body): Json<LoginBody>) -> Response {
    let store = users(&state);
    if store.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "create the first user before signing in" }))).into_response();
    }
    match store.login(body.name.as_deref().unwrap_or(""), body.password.as_deref().unwrap_or("")) {
        Ok(token) => {
            let mut res = Json(json!({ "ok": true })).into_response();
            if let Ok(value) = HeaderValue::from_str(&crate::share::session_cookie(&token)) {
                res.headers_mut().insert(axum::http::header::SET_COOKIE, value);
            }
            res
        }
        Err(err) => (StatusCode::UNAUTHORIZED, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(token) = crate::share::cookie_token(&headers) {
        users(&state).logout(&token);
    }
    let mut res = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&crate::share::clear_cookie()) {
        res.headers_mut().insert(axum::http::header::SET_COOKIE, value);
    }
    res
}

async fn get_users(State(state): State<Arc<AppState>>) -> Response {
    let list: Vec<_> = users(&state).list().into_iter().map(|(name, role)| json!({ "name": name, "role": role })).collect();
    Json(json!({ "users": list })).into_response()
}

async fn post_users(State(state): State<Arc<AppState>>, Json(body): Json<LoginBody>) -> Response {
    match users(&state).add(body.name.as_deref().unwrap_or(""), body.password.as_deref().unwrap_or(""), body.role.as_deref().unwrap_or("operator")) {
        Ok(()) => get_users(State(state)).await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_users_delete(State(state): State<Arc<AppState>>, Json(body): Json<LoginBody>) -> Response {
    match users(&state).remove(body.name.as_deref().unwrap_or("")) {
        Ok(()) => get_users(State(state)).await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_triggers(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "triggers": state.triggers.list() })).into_response()
}

async fn post_triggers(State(state): State<Arc<AppState>>, Json(body): Json<crate::schedules::EventTrigger>) -> Response {
    match state.triggers.upsert(body).await {
        Ok(t) => Json(t).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_triggers_delete(State(state): State<Arc<AppState>>, Json(body): Json<IdBody>) -> Response {
    match state.triggers.delete(&body.id).await {
        Ok(()) => get_triggers(State(state)).await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct DocBody {
    project: Option<String>,
    kind: Option<String>,
    title: Option<String>,
    body: Option<String>,
    action: Option<String>,
    query: Option<String>,
    path: Option<String>,
}

async fn get_docs(State(state): State<Arc<AppState>>, Query(q): Query<DocBody>) -> Response {
    match crate::mcp::query_docs(&state.data_dir, q.project.as_deref().unwrap_or(""), "list", "", "") {
        Ok(text) => Json(json!({ "text": text })).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_docs(State(state): State<Arc<AppState>>, Json(body): Json<DocBody>) -> Response {
    match crate::mcp::save_doc(&state.data_dir, body.project.as_deref().unwrap_or(""), body.kind.as_deref().unwrap_or("doc"), body.title.as_deref().unwrap_or(""), body.body.as_deref().unwrap_or("")) {
        Ok(path) => Json(json!({ "path": path })).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_docs_query(State(state): State<Arc<AppState>>, Json(body): Json<DocBody>) -> Response {
    match crate::mcp::query_docs(&state.data_dir, body.project.as_deref().unwrap_or(""), body.action.as_deref().unwrap_or("search"), body.query.as_deref().unwrap_or(""), body.path.as_deref().unwrap_or("")) {
        Ok(text) => Json(json!({ "text": text })).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_docs_delete(State(state): State<Arc<AppState>>, Json(body): Json<DocBody>) -> Response {
    let rel = body.path.unwrap_or_default();
    if rel.contains("..") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad path" }))).into_response();
    }
    match crate::mcp::docs_dir(&state.data_dir, body.project.as_deref().unwrap_or("")) {
        Ok(dir) => {
            let file = dir.join(&rel);
            if file.starts_with(&dir) {
                let _ = std::fs::remove_file(file);
            }
            Json(json!({ "ok": true })).into_response()
        }
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_pi_command(Json(body): Json<Value>) -> Response {
    harness_reply(crate::pi_sidecar::call(reqwest::Method::POST, "/packages/command", Some(body)).await)
}

async fn post_team_steer(State(state): State<Arc<AppState>>, Json(body): Json<TeamSteerBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    let text = body.text.unwrap_or_default();
    let name = body.name.unwrap_or_else(|| "Owner".into());
    match team_steer(
        state.handler.clone(),
        state.transcripts.clone(),
        &thread,
        &text,
        &name.chars().take(40).collect::<String>(),
        body.reply_to,
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct TeamThreadBody {
    pub thread: Option<String>,
    archived: Option<bool>,
    /// Stop (or pause) only this agent; none = every agent of the thread.
    agent: Option<String>,
    pause: Option<bool>,
}

pub async fn post_team_stop(Json(body): Json<TeamThreadBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    let key = format!("{TEAM_PREFIX}{thread}");
    match body.agent.as_deref().map(|a| a.trim_start_matches('@')).filter(|a| !a.is_empty()) {
        Some(agent) => {
            if body.pause.unwrap_or(false) {
                crate::personas::mark_paused(&key, agent);
            }
            crate::personas::request_agent_stop(&key, agent);
            crate::pi_sidecar::abort(&format!("{key}#{agent}")).await;
        }
        None => {
            crate::personas::request_stop(&key);
            crate::pi_sidecar::abort(&key).await;
        }
    }
    Json(json!({ "ok": true })).into_response()
}

async fn post_team_resume(State(state): State<Arc<AppState>>, Json(body): Json<TeamThreadBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    let agent = body.agent.unwrap_or_default();
    if !thread_id_ok(&thread) || agent.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "thread and agent are required" }))).into_response();
    }
    let req = crate::handler::TurnRequest {
        thread_key: format!("{TEAM_PREFIX}{thread}"),
        space_name: "team-chat".into(),
        text: String::new(),
        sender: None,
        reply_via_chat: false,
        thread: None,
        room_n: None,
        captured_replies: None,
        reply_sink: Some(state.transcripts.clone()),
        request_id: Some(uuid::Uuid::new_v4().to_string()),
    };
    let deps = state.handler.clone();
    tokio::spawn(async move {
        if let Err(err) = crate::handler::resume_agent(req, deps, agent.trim_start_matches('@')).await {
            tracing::error!(%err, "resume failed");
        }
    });
    Json(json!({ "ok": true })).into_response()
}

async fn post_team_archive(State(state): State<Arc<AppState>>, Json(body): Json<TeamThreadBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    let _ = state
        .transcripts
        .archive(&format!("{TEAM_PREFIX}{thread}"), body.archived.unwrap_or(true))
        .await;
    Json(json!({ "ok": true })).into_response()
}

async fn post_team_delete(State(state): State<Arc<AppState>>, Json(body): Json<TeamThreadBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    match team_delete(state.handler.clone(), state.transcripts.clone(), &thread).await {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct TeamMembersBody {
    thread: Option<String>,
    op: Option<String>,
    member: Option<TeamMemberBody>,
}

#[derive(Deserialize)]
struct TeamMemberBody {
    kind: Option<String>,
    persona: Option<String>,
    name: Option<String>,
}

async fn post_team_members(State(state): State<Arc<AppState>>, Json(body): Json<TeamMembersBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    let op = body.op.unwrap_or_default();
    let member = match body.member {
        Some(m) if m.kind.as_deref() == Some("agent") && m.persona.as_ref().is_some_and(|p| !p.is_empty()) => {
            TeamMemberInput::Agent {
                persona: m.persona.unwrap(),
            }
        }
        Some(m) if m.kind.as_deref() == Some("human") && m.name.as_ref().is_some_and(|n| !n.trim().is_empty()) => {
            TeamMemberInput::Human {
                name: m.name.unwrap(),
            }
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "member must be { kind: agent, persona } or { kind: human, name }" })),
            )
                .into_response();
        }
    };
    match team_members(state.handler.clone(), &thread, &op, member).await {
        Ok(members) => Json(json!({ "members": members })).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

pub async fn get_media(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some((bytes, content_type, name)) = state.media.read(&id).await else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    };
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&content_type) {
        headers.insert(axum::http::header::CONTENT_TYPE, v);
    }
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    let raster = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].contains(&content_type.to_ascii_lowercase().as_str());
    // Artifacts render in the pane iframe; attachment would download instead.
    let html = content_type.to_ascii_lowercase().starts_with("text/html");
    let disposition = if raster || html { "inline" } else { "attachment" };
    let safe: String = name.unwrap_or_else(|| id.clone()).chars().filter(|c| !c.is_control() && *c != '"').collect();
    if let Ok(v) = HeaderValue::from_str(&format!("{disposition}; filename=\"{safe}\"")) {
        headers.insert(axum::http::header::CONTENT_DISPOSITION, v);
    }
    headers.insert(axum::http::header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(axum::http::header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(if html {
        // Sandboxed (opaque origin, no same-origin) but templates need inline style/script and web fonts.
        "sandbox allow-scripts allow-forms allow-modals allow-popups; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; img-src data: https:"
    } else {
        "sandbox; default-src 'none'"
    }));
    (StatusCode::OK, headers, bytes).into_response()
}

#[derive(Deserialize)]
struct ArtifactBody {
    title: Option<String>,
    /// Named Switchboard skin: walkthrough | compare | quiz | cards
    template: Option<String>,
    /// Placeholder map for the template (`TITLE`, `LEAD`, `Q1`, …).
    fields: Option<serde_json::Map<String, serde_json::Value>>,
    /// Designed page body (style + content); ignored when `template` is set.
    html: Option<String>,
}

async fn post_artifact(State(state): State<Arc<AppState>>, Json(body): Json<ArtifactBody>) -> Response {
    let title = body.title.unwrap_or_default();
    let wrapped = if let Some(template) = body.template.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let fields = body.fields.unwrap_or_default();
        match crate::artifacts::build_from_template(&title, template, &fields) {
            Ok(w) => w,
            Err(err) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
        }
    } else {
        let html = body.html.unwrap_or_default();
        match crate::artifacts::validate_artifact(&title, &html) {
            Ok(w) => w,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": err
                    })),
                )
                    .into_response();
            }
        }
    };
    let name = format!("{}.html", title.trim().chars().take(40).collect::<String>());
    match state.media.save(wrapped.as_bytes(), "text/html", Some(&name)).await {
        Ok(saved) => Json(json!({
            "id": saved.id,
            "title": title.trim(),
            "marker": crate::artifacts::marker(&saved.id, title.trim()),
        }))
        .into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadKeyQuery {
    thread_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadAction {
    thread_key: Option<String>,
    name: Option<String>,
    repo: Option<Value>,
    action: Option<String>,
    id: Option<Value>,
}

fn thread_key_of(key: Option<String>) -> Option<String> {
    key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

fn missing_thread_key() -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "threadKey is required" }))).into_response()
}

async fn thread_reply(state: &AppState, thread_key: &str, command: &str) -> Response {
    match crate::handler::thread_command(&state.handler, thread_key, command).await {
        Ok(message) => {
            let r = state.handler.store.get(thread_key);
            Json(json!({
                "ok": true,
                "message": message,
                "repo": r.as_ref().and_then(|r| r.repo.clone()),
                "branch": r.as_ref().and_then(|r| r.branch.clone()),
                "worktree": r.as_ref().and_then(|r| r.worktree.clone()),
            }))
            .into_response()
        }
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_thread_status(State(state): State<Arc<AppState>>, Query(q): Query<ThreadKeyQuery>) -> Response {
    let Some(key) = thread_key_of(q.thread_key) else {
        return missing_thread_key();
    };
    let r = state.handler.store.get(&key);
    let settings = state.settings.get();
    let slug = slug_for(&key);
    let options = (state.handler.options)();
    Json(json!({
        "threadKey": key,
        "space": r.as_ref().map(|r| r.space.clone()).unwrap_or_else(|| "team-chat".into()),
        "repo": r.as_ref().and_then(|r| r.repo.clone()),
        "branch": r.as_ref().and_then(|r| r.branch.clone()),
        "worktree": r.as_ref().and_then(|r| r.worktree.clone()),
        "workItemId": r.as_ref().and_then(|r| r.work_item_id),
        "agent": r.as_ref().and_then(|r| r.driver).unwrap_or(settings.agent_driver),
        "model": r.as_ref().and_then(|r| r.model.clone()),
        "app": { "running": state.workspaces.is_up(&slug), "port": state.workspaces.port(&slug) },
        "context": r.as_ref().map(|r| crate::handler::context_line(r, &options).trim_start_matches('\n').to_string()),
        "repos": settings.repos.keys().collect::<Vec<_>>(),
    }))
    .into_response()
}

async fn post_thread_invite(State(state): State<Arc<AppState>>, Json(body): Json<ThreadAction>) -> Response {
    let Some(key) = thread_key_of(body.thread_key) else {
        return missing_thread_key();
    };
    let name = body.name.unwrap_or_default();
    thread_reply(&state, &key, &format!("/invite {}", name.trim().trim_start_matches('@'))).await
}

async fn post_thread_repo(State(state): State<Arc<AppState>>, Json(body): Json<ThreadAction>) -> Response {
    let Some(key) = thread_key_of(body.thread_key) else {
        return missing_thread_key();
    };
    match body.repo.as_ref().and_then(|v| v.as_str()).map(str::trim).filter(|r| !r.is_empty()) {
        Some(repo) => thread_reply(&state, &key, &format!("/repo {repo}")).await,
        None => thread_reply(&state, &key, "/close").await,
    }
}

async fn post_thread_app(State(state): State<Arc<AppState>>, Json(body): Json<ThreadAction>) -> Response {
    let Some(key) = thread_key_of(body.thread_key) else {
        return missing_thread_key();
    };
    match body.action.as_deref() {
        Some("up") => thread_reply(&state, &key, "/up").await,
        Some("down") => thread_reply(&state, &key, "/down").await,
        Some("logs") => thread_reply(&state, &key, "/logs").await,
        _ => (StatusCode::BAD_REQUEST, Json(json!({ "error": "action must be up, down or logs" }))).into_response(),
    }
}

async fn put_work_item(State(state): State<Arc<AppState>>, Json(body): Json<ThreadAction>) -> Response {
    let Some(key) = thread_key_of(body.thread_key) else {
        return missing_thread_key();
    };
    let id = match body.id {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_i64().filter(|n| *n > 0) {
            Some(n) => Some(n),
            None => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "id must be a positive integer" }))).into_response(),
        },
    };
    let space = state.handler.store.get(&key).map(|r| r.space).unwrap_or_else(|| "team-chat".into());
    match state
        .handler
        .store
        .update(&key, &space, crate::session::SessionPatch { work_item_id: Some(id), ..Default::default() })
        .await
    {
        Ok(()) => Json(json!({ "ok": true, "workItemId": id })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct XlsxBody {
    thread_key: Option<String>,
    task_id: Option<String>,
    title: Option<String>,
    sheets: Option<Vec<crate::google_drive::Sheet>>,
}

async fn get_pi_keys(State(state): State<Arc<AppState>>) -> Response {
    Json(crate::pi_keys::status(&state.data_dir)).into_response()
}

#[derive(Deserialize)]
struct PiKeyBody {
    provider: Option<String>,
    key: Option<String>,
}

async fn post_pi_key(State(state): State<Arc<AppState>>, Json(body): Json<PiKeyBody>) -> Response {
    match crate::pi_keys::set(&state.data_dir, body.provider.as_deref().unwrap_or(""), body.key.as_deref().unwrap_or("")).await {
        Ok(()) => Json(crate::pi_keys::status(&state.data_dir)).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_pi_custom_providers(State(state): State<Arc<AppState>>) -> Response {
    Json(crate::pi_custom_providers::list(&state.data_dir)).into_response()
}

async fn post_pi_custom_provider(State(state): State<Arc<AppState>>, Json(body): Json<crate::pi_custom_providers::CustomProviderUpsert>) -> Response {
    match crate::pi_custom_providers::upsert(&state.data_dir, body).await {
        Ok(list) => {
            crate::pi_sidecar::reload();
            Json(list).into_response()
        }
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn import_tokenbank_provider(State(state): State<Arc<AppState>>) -> Response {
    match crate::pi_custom_providers::import_tokenbank(&state.data_dir).await {
        Ok(list) => {
            crate::pi_sidecar::reload();
            Json(list).into_response()
        }
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct CustomProviderQuery {
    id: Option<String>,
}

async fn delete_pi_custom_provider(State(state): State<Arc<AppState>>, Query(q): Query<CustomProviderQuery>) -> Response {
    match crate::pi_custom_providers::remove(&state.data_dir, q.id.as_deref().unwrap_or("")).await {
        Ok(list) => {
            crate::pi_sidecar::reload();
            Json(list).into_response()
        }
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

fn skill_list() -> Vec<Value> {
    crate::skills::available()
        .into_iter()
        .map(|s| {
            json!({
                "name": s.name,
                "description": s.description,
                "mcps": s.mcps,
                "body": s.body,
                "files": s.files,
            })
        })
        .collect()
}

async fn get_skills() -> Response {
    Json(skill_list()).into_response()
}

#[derive(Deserialize)]
struct SourceBody {
    source: Option<String>,
}

async fn post_install_skill(Json(b): Json<SourceBody>) -> Response {
    match crate::skill_install::install(&b.source.unwrap_or_default(), &crate::skills::writable_dir()).await {
        Ok(installed) => Json(json!({ "installed": installed, "skills": skill_list() })).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct SkillsSearchQuery {
    q: Option<String>,
    owner: Option<String>,
    limit: Option<u32>,
}

async fn get_skills_search(Query(q): Query<SkillsSearchQuery>) -> Response {
    match crate::skill_install::search(
        q.q.as_deref().unwrap_or(""),
        q.owner.as_deref(),
        q.limit.unwrap_or(12),
    )
    .await
    {
        Ok(skills) => Json(json!({ "skills": skills })).into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct McpImportBody {
    json: Option<String>,
}

async fn post_mcp_import(State(state): State<Arc<AppState>>, Json(b): Json<McpImportBody>) -> Response {
    let parsed = match crate::mcp_client::parse_mcp_config(&b.json.unwrap_or_default()) {
        Ok(parsed) => parsed,
        Err(err) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    };
    let imported: Vec<String> = parsed.servers.iter().map(|s| s.name.clone()).collect();
    let mut servers = state.settings.get().mcp_servers;
    for server in parsed.servers {
        if let Some(existing) = servers.iter_mut().find(|s| s.name == server.name) {
            *existing = server;
        } else {
            servers.push(server);
        }
    }
    match state.settings.update(SettingsPatch { mcp_servers: Some(servers), ..Default::default() }).await {
        Ok(settings) => Json(json!({ "imported": imported, "skipped": parsed.skipped, "settings": settings })).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct SkillBody {
    name: Option<String>,
    description: Option<String>,
    mcps: Option<Vec<String>>,
    body: Option<String>,
    #[serde(default)]
    files: Option<Vec<crate::skills::SkillFile>>,
}

async fn put_skill(Json(b): Json<SkillBody>) -> Response {
    let skill = crate::skills::Skill {
        name: b.name.unwrap_or_default().trim().to_string(),
        description: b.description.unwrap_or_default().trim().to_string(),
        mcps: b.mcps.unwrap_or_default(),
        body: b.body.unwrap_or_default(),
        files: b.files.unwrap_or_default(),
    };
    match crate::skills::save(&crate::skills::writable_dir(), &skill) {
        Ok(()) => get_skills().await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct NameQuery {
    name: Option<String>,
}

async fn delete_skill(Query(q): Query<NameQuery>) -> Response {
    match crate::skills::delete(&crate::skills::writable_dir(), q.name.as_deref().unwrap_or("")) {
        Ok(()) => get_skills().await,
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_mcp_catalog() -> Response {
    Json(crate::mcp_client::catalog()).into_response()
}

#[derive(Deserialize)]
struct McpCatalogBody {
    name: String,
    #[serde(default)]
    values: std::collections::BTreeMap<String, String>,
}

async fn post_mcp_catalog(State(state): State<Arc<AppState>>, Json(b): Json<McpCatalogBody>) -> Response {
    let server = match crate::mcp_client::from_catalog(&b.name, &b.values) {
        Ok(server) => server,
        Err(err) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    };
    let mut servers = state.settings.get().mcp_servers;
    servers.retain(|s| s.name != server.name);
    servers.push(server);
    match state.settings.update(SettingsPatch { mcp_servers: Some(servers), ..Default::default() }).await {
        Ok(settings) => Json(settings).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
struct McpCheckBody {
    name: String,
}

async fn post_mcp_check(State(state): State<Arc<AppState>>, Json(body): Json<McpCheckBody>) -> Response {
    let Some(server) = state.settings.get().mcp_servers.into_iter().find(|s| s.name == body.name) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("no MCP server {}", body.name) }))).into_response();
    };
    Json(crate::mcp_client::probe(server).await).into_response()
}

async fn get_mcp_servers(State(state): State<Arc<AppState>>) -> Response {
    Json(state.settings.get().mcp_servers).into_response()
}

async fn get_delegates(State(state): State<Arc<AppState>>, Query(q): Query<ThreadKeyQuery>) -> Response {
    let Some(key) = thread_key_of(q.thread_key) else {
        return missing_thread_key();
    };
    let personas = state.settings.get().personas;
    let Some(caller) = crate::google_drive::persona_of(&key, &personas) else {
        return Json(json!([])).into_response();
    };
    let list: Vec<Value> = crate::handler::delegates_for(caller, &personas)
        .into_iter()
        .map(|p| json!({ "name": p.name, "about": p.prompt.chars().take(160).collect::<String>() }))
        .collect();
    Json(list).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskBody {
    thread_key: Option<String>,
    agent: Option<String>,
    question: Option<String>,
}

async fn post_ask_agent(State(state): State<Arc<AppState>>, Json(b): Json<AskBody>) -> Response {
    let Some(key) = thread_key_of(b.thread_key) else {
        return missing_thread_key();
    };
    let question = b.question.unwrap_or_default();
    if question.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "question is required" }))).into_response();
    }
    match crate::handler::ask_persona(&state.handler, &key, b.agent.as_deref().unwrap_or(""), &question).await {
        Ok(answer) => Json(json!({ "answer": answer })).into_response(),
        Err(err) => (StatusCode::FORBIDDEN, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftAgentBody {
    brief: Option<String>,
    current: Option<crate::ai_draft::AgentDraft>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftSkillBody {
    brief: Option<String>,
    current: Option<crate::ai_draft::SkillDraft>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftAgentChatBody {
    messages: Option<Vec<crate::ai_draft::DraftChatMessage>>,
    current: Option<crate::ai_draft::AgentDraft>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftSkillChatBody {
    messages: Option<Vec<crate::ai_draft::DraftChatMessage>>,
    current: Option<crate::ai_draft::SkillDraft>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftHostChatBody {
    messages: Option<Vec<crate::ai_draft::DraftChatMessage>>,
    current: Option<crate::ai_draft::HostDraft>,
}

fn draft_ctx(state: &AppState) -> crate::ai_draft::DraftContext {
    let settings = state.settings.get();
    crate::ai_draft::DraftContext {
        available_mcps: crate::ai_draft::available_mcps(&settings),
        available_skills: crate::ai_draft::available_skill_names(),
        workdir: state.handler.config.lock().unwrap().workdir.clone(),
        model: settings.models.pi.clone(),
    }
}

async fn post_draft_agent(State(state): State<Arc<AppState>>, Json(b): Json<DraftAgentBody>) -> Response {
    let brief = b.brief.unwrap_or_default();
    match crate::ai_draft::draft_agent(&state.handler.driver, &brief, b.current.as_ref(), &draft_ctx(&state)).await {
        Ok(draft) => Json(draft).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_draft_skill(State(state): State<Arc<AppState>>, Json(b): Json<DraftSkillBody>) -> Response {
    let brief = b.brief.unwrap_or_default();
    match crate::ai_draft::draft_skill(&state.handler.driver, &brief, b.current.as_ref(), &draft_ctx(&state)).await {
        Ok(draft) => Json(draft).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_draft_agent_chat(State(state): State<Arc<AppState>>, Json(b): Json<DraftAgentChatBody>) -> Response {
    let messages = b.messages.unwrap_or_default();
    match crate::ai_draft::draft_agent_chat(&state.handler.driver, &messages, b.current.as_ref(), &draft_ctx(&state)).await {
        Ok(reply) => Json(reply).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_draft_skill_chat(State(state): State<Arc<AppState>>, Json(b): Json<DraftSkillChatBody>) -> Response {
    let messages = b.messages.unwrap_or_default();
    match crate::ai_draft::draft_skill_chat(&state.handler.driver, &messages, b.current.as_ref(), &draft_ctx(&state)).await {
        Ok(reply) => Json(reply).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn post_draft_host_chat(State(state): State<Arc<AppState>>, Json(b): Json<DraftHostChatBody>) -> Response {
    let messages = b.messages.unwrap_or_default();
    match crate::ai_draft::draft_host_chat(&state.handler.driver, &messages, b.current.as_ref(), &draft_ctx(&state)).await {
        Ok(reply) => Json(reply).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

struct DriveTarget {
    key: String,
    folder: String,
    task: String,
}

fn drive_target(state: &AppState, thread_key: Option<String>, explicit: Option<String>, kind: &str, title: &str) -> Result<DriveTarget, Response> {
    let Some(key) = thread_key_of(thread_key) else {
        return Err(missing_thread_key());
    };
    let folder = match crate::google_drive::allowed(&key, &state.settings.get()) {
        Ok(f) => f,
        Err(err) => return Err((StatusCode::FORBIDDEN, Json(json!({ "error": err }))).into_response()),
    };
    let task = crate::google_drive::drive_task(explicit.as_deref(), kind, title, &key, state.handler.ledger.as_deref());
    Ok(DriveTarget { key, folder, task })
}

fn drive_bad(err: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response()
}

async fn drive_saved(state: &AppState, key: &str, kind: &str, created: crate::google_drive::Created) -> Response {
    let link = created.file.web_view_link.clone().unwrap_or_default();
    crate::handler::note(&state.handler, kind, key, created.file.name.clone(), link).await;
    Json(created).into_response()
}

fn drive_failed(err: String) -> Response {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response()
}

async fn post_drive_xlsx(State(state): State<Arc<AppState>>, Json(body): Json<XlsxBody>) -> Response {
    let title = body.title.unwrap_or_default();
    let sheets = body.sheets.unwrap_or_default();
    if title.trim().is_empty() || sheets.is_empty() {
        return drive_bad("title and at least one sheet are required".into());
    }
    let target = match drive_target(&state, body.thread_key, body.task_id, "xlsx", title.trim()) {
        Ok(t) => t,
        Err(res) => return res,
    };
    match state.drive.create_xlsx(&target.folder, &target.task, title.trim(), &sheets).await {
        Ok(created) => drive_saved(&state, &target.key, "drive_xlsx", created).await,
        Err(err) => drive_failed(err),
    }
}

fn request_host(headers: &HeaderMap) -> String {
    headers.get(axum::http::header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("127.0.0.1:8081").to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveMcpClient {
    client_id: Option<String>,
    client_secret: Option<String>,
}

#[derive(Deserialize)]
struct DriveMcpCall {
    name: Option<String>,
    arguments: Option<Value>,
}

fn google_mcp_redirect(headers: &HeaderMap, kind: crate::drive_mcp::GoogleMcpKind) -> String {
    crate::drive_mcp::redirect_uri_for(&request_host(headers), kind)
}

async fn google_mcp_status(mcp: &crate::drive_mcp::DriveMcp, headers: &HeaderMap) -> Response {
    let redirect = google_mcp_redirect(headers, mcp.kind());
    Json(mcp.status(&redirect).await).into_response()
}

async fn google_mcp_set_client(
    mcp: &crate::drive_mcp::DriveMcp,
    headers: &HeaderMap,
    body: DriveMcpClient,
) -> Response {
    let redirect = google_mcp_redirect(headers, mcp.kind());
    match mcp
        .set_client(body.client_id.as_deref().unwrap_or(""), body.client_secret.as_deref().unwrap_or(""))
        .await
    {
        Ok(_) => Json(mcp.status(&redirect).await).into_response(),
        Err(err) => drive_bad(err),
    }
}

async fn google_mcp_start(mcp: &crate::drive_mcp::DriveMcp, headers: &HeaderMap) -> Response {
    let redirect = google_mcp_redirect(headers, mcp.kind());
    match mcp.start_url(&redirect).await {
        Ok(url) => Json(json!({ "url": url })).into_response(),
        Err(err) => drive_bad(err),
    }
}

async fn google_mcp_callback(mcp: &crate::drive_mcp::DriveMcp, q: HashMap<String, String>, title: &str) -> Response {
    let code = q.get("code").cloned().unwrap_or_default();
    let oauth_state = q.get("state").cloned().unwrap_or_default();
    let page = match mcp.exchange(&code, &oauth_state).await {
        Ok(()) => format!("{title} is connected. You can close this tab and return to Settings."),
        Err(err) => err.replace('<', ""),
    };
    axum::response::Html(format!("<!doctype html><title>{title}</title><p>{page}</p>")).into_response()
}

async fn google_mcp_clear(mcp: &crate::drive_mcp::DriveMcp, headers: &HeaderMap) -> Response {
    let redirect = google_mcp_redirect(headers, mcp.kind());
    if let Err(err) = mcp.clear().await {
        return drive_failed(err);
    }
    Json(mcp.status(&redirect).await).into_response()
}

async fn google_mcp_tools(mcp: &crate::drive_mcp::DriveMcp, label: &str) -> Response {
    match mcp.tools().await {
        Ok(tools) => Json(json!({ "tools": tools })).into_response(),
        Err(err) => {
            eprintln!("{label} mcp: {err}");
            Json(json!({ "tools": [] })).into_response()
        }
    }
}

async fn google_mcp_call(mcp: &crate::drive_mcp::DriveMcp, body: DriveMcpCall) -> Response {
    let name = body.name.unwrap_or_default();
    match mcp.call(&name, body.arguments.unwrap_or(json!({}))).await {
        Ok(result) => Json(result).into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_drive_mcp(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_status(&state.drive_mcp, &headers).await
}
async fn post_drive_mcp(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<DriveMcpClient>) -> Response {
    google_mcp_set_client(&state.drive_mcp, &headers, body).await
}
async fn post_drive_mcp_start(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_start(&state.drive_mcp, &headers).await
}
async fn get_drive_mcp_callback(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    google_mcp_callback(&state.drive_mcp, q, "Google Drive").await
}
async fn post_drive_mcp_clear(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_clear(&state.drive_mcp, &headers).await
}
async fn get_drive_mcp_tools(State(state): State<Arc<AppState>>) -> Response {
    google_mcp_tools(&state.drive_mcp, "drive").await
}
async fn post_drive_mcp_call(State(state): State<Arc<AppState>>, Json(body): Json<DriveMcpCall>) -> Response {
    google_mcp_call(&state.drive_mcp, body).await
}

async fn get_calendar_mcp(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_status(&state.calendar_mcp, &headers).await
}
async fn post_calendar_mcp(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<DriveMcpClient>) -> Response {
    google_mcp_set_client(&state.calendar_mcp, &headers, body).await
}
async fn post_calendar_mcp_start(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_start(&state.calendar_mcp, &headers).await
}
async fn get_calendar_mcp_callback(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    google_mcp_callback(&state.calendar_mcp, q, "Google Calendar").await
}
async fn post_calendar_mcp_clear(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_clear(&state.calendar_mcp, &headers).await
}
async fn get_calendar_mcp_tools(State(state): State<Arc<AppState>>) -> Response {
    google_mcp_tools(&state.calendar_mcp, "calendar").await
}
async fn post_calendar_mcp_call(State(state): State<Arc<AppState>>, Json(body): Json<DriveMcpCall>) -> Response {
    google_mcp_call(&state.calendar_mcp, body).await
}

async fn get_gmail_mcp(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_status(&state.gmail_mcp, &headers).await
}
async fn post_gmail_mcp(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<DriveMcpClient>) -> Response {
    google_mcp_set_client(&state.gmail_mcp, &headers, body).await
}
async fn post_gmail_mcp_start(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_start(&state.gmail_mcp, &headers).await
}
async fn get_gmail_mcp_callback(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    google_mcp_callback(&state.gmail_mcp, q, "Gmail").await
}
async fn post_gmail_mcp_clear(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    google_mcp_clear(&state.gmail_mcp, &headers).await
}
async fn get_gmail_mcp_tools(State(state): State<Arc<AppState>>) -> Response {
    google_mcp_tools(&state.gmail_mcp, "gmail").await
}
async fn post_gmail_mcp_call(State(state): State<Arc<AppState>>, Json(body): Json<DriveMcpCall>) -> Response {
    google_mcp_call(&state.gmail_mcp, body).await
}

async fn get_drive_spreadsheets(State(state): State<Arc<AppState>>, Query(q): Query<ThreadKeyQuery>) -> Response {
    let Some(key) = thread_key_of(q.thread_key) else {
        return missing_thread_key();
    };
    let folder = match crate::google_drive::allowed(&key, &state.settings.get()) {
        Ok(f) => f,
        Err(err) => return (StatusCode::FORBIDDEN, Json(json!({ "error": err }))).into_response(),
    };
    match state.drive.list(&folder).await {
        Ok(files) => Json(files).into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

async fn get_thread_repos(State(state): State<Arc<AppState>>) -> Response {
    let repos: Vec<String> = state.settings.get().repos.keys().cloned().collect();
    Json(json!({ "repos": repos })).into_response()
}
