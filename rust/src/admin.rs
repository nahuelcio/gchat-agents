use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agents::{claude_models, detect_agents, opencode_agents, opencode_models};
use crate::handler::TEAM_PREFIX;
use crate::schedules::{describe_cron, job_name, JobPatch, NewJob};
use crate::settings::SettingsPatch;
use crate::state::AppState;
use crate::static_files::serve_static;
use crate::team::{team_delete, team_members, team_send, team_thread, thread_id_ok, TeamMemberInput};
use crate::workspace::slug_for;

pub fn admin_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/health", get(get_health))
        .route("/api/activity", get(get_activity))
        .route("/api/search", get(get_search))
        .route("/api/agents", get(get_agents))
        .route("/api/agents/opencode/models", get(get_opencode_models))
        .route("/api/agents/opencode/agents", get(get_opencode_agents))
        .route("/api/agents/claude/models", get(get_claude_models))
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
        .route("/api/schedules/suggest", post(post_schedules_suggest))
        .route("/api/share", get(get_share))
        .route("/api/share/rotate", post(post_share_rotate))
        .route("/api/google", get(get_google))
        .route("/api/google/key", post(post_google_key))
        .route("/api/google/key/delete", post(post_google_clear))
        .route("/api/google/test", post(post_google_test))
        .route("/api/ado/status", get(get_ado_status))
        .route("/api/ado/projects", get(get_ado_projects))
        .route("/api/ado/repos", get(get_ado_repos))
        .route("/api/ado/clone", post(post_ado_clone))
        .route("/api/team/threads", get(get_team_threads))
        .route("/api/team/thread", get(get_team_thread))
        .route("/api/team/send", post(post_team_send))
        .route("/api/team/stop", post(post_team_stop))
        .route("/api/team/archive", post(post_team_archive))
        .route("/api/team/delete", post(post_team_delete))
        .route("/api/team/members", post(post_team_members))
        .route("/api/media/{id}", get(get_media))
        .route("/api/thread/repos", get(get_thread_repos))
        .route("/api/thread/status", get(get_thread_status))
        .route("/api/thread/invite", post(post_thread_invite).put(post_thread_invite))
        .route("/api/thread/repo", post(post_thread_repo).put(post_thread_repo))
        .route("/api/thread/app", post(post_thread_app).put(post_thread_app))
        .route("/api/work-item", axum::routing::put(put_work_item))
        .route("/api/drive/xlsx", post(post_drive_xlsx))
        .route("/api/skills", get(get_skills))
        .route("/api/drive/spreadsheets", get(get_drive_spreadsheets))
        .fallback(admin_fallback)
        .layer(axum::extract::DefaultBodyLimit::max(crate::team::UPLOAD_LIMIT))
        .layer(axum::middleware::from_fn(require_local_host))
        .with_state(state)
}

async fn require_local_host(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if !host_ok(req.headers()) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden host" }))).into_response();
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
        Ok(s) => Json(s).into_response(),
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

async fn get_agents(State(state): State<Arc<AppState>>) -> Response {
    Json(detect_agents(&state.opencode_bin, &state.claude_bin).await).into_response()
}

async fn get_opencode_models(State(state): State<Arc<AppState>>) -> Response {
    Json(opencode_models(&state.opencode_bin).await).into_response()
}

async fn get_opencode_agents(State(state): State<Arc<AppState>>) -> Response {
    Json(opencode_agents(&state.opencode_bin).await).into_response()
}

async fn get_claude_models(State(state): State<Arc<AppState>>) -> Response {
    Json(claude_models(&state.claude_bin).await).into_response()
}

async fn get_threads(State(state): State<Arc<AppState>>) -> Response {
    let personas = state.settings.get().personas;
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
        .collect();
    Json(list).into_response()
}

#[derive(Deserialize)]
struct DecideBody {
    id: Option<String>,
    approve: Option<bool>,
}

async fn post_approvals_decide(State(state): State<Arc<AppState>>, Json(body): Json<DecideBody>) -> Response {
    let (Some(id), Some(approve)) = (body.id, body.approve) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "id and approve are required" }))).into_response();
    };
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

async fn get_share(State(state): State<Arc<AppState>>) -> Response {
    let url = state.public_url.lock().unwrap().clone();
    let Some(url) = url else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "sharing needs the tunnel" }))).into_response();
    };
    let token = state.share.lock().await.value().to_string();
    Json(json!({ "link": format!("{url}/play#{token}") })).into_response()
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

async fn get_ado_status() -> Response {
    match crate::integrations::detect_ado_from_env() {
        Some(ado) => Json(json!({
            "connected": true,
            "org": ado.org,
            "profile": ado.profile,
            "projects": ado.projects,
            "defaultProject": ado.default_project,
        }))
        .into_response(),
        None => Json(json!({ "connected": false })).into_response(),
    }
}

async fn get_ado_projects() -> Response {
    let Some(ado) = crate::integrations::detect_ado_from_env() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "Azure DevOps not configured on this machine — run `ado init`" })),
        )
            .into_response();
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

async fn get_ado_repos(Query(q): Query<AdoReposQuery>) -> Response {
    let Some(ado) = crate::integrations::detect_ado_from_env() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "Azure DevOps not configured on this machine — run `ado init`" })),
        )
            .into_response();
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
    let Some(ado) = crate::integrations::detect_ado_from_env() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "Azure DevOps not configured on this machine — run `ado init`" })),
        )
            .into_response();
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
    let list: Vec<Value> = state
        .transcripts
        .list(TEAM_PREFIX, archived)
        .into_iter()
        .map(|t| {
            let title = state.handler.store.get(&t.key).and_then(|r| r.title).unwrap_or(t.title);
            json!({
                "id": t.key.strip_prefix(TEAM_PREFIX).unwrap_or(&t.key),
                "title": title,
                "updatedAt": t.updated_at,
                "count": t.count,
            })
        })
        .collect();
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

#[derive(Deserialize)]
struct TeamSendBody {
    thread: Option<String>,
    text: Option<String>,
    name: Option<String>,
    attachments: Option<Vec<crate::team::TeamAttachmentInput>>,
}

async fn post_team_send(State(state): State<Arc<AppState>>, Json(body): Json<TeamSendBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    let text = body.text.unwrap_or_default();
    let name = body.name.unwrap_or_else(|| "Owner".into());
    match team_send(
        state.handler.clone(),
        state.transcripts.clone(),
        &thread,
        &text,
        &name.chars().take(40).collect::<String>(),
        None,
        body.attachments.as_deref().unwrap_or_default(),
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct TeamThreadBody {
    thread: Option<String>,
    archived: Option<bool>,
}

pub async fn post_team_stop(Json(body): Json<TeamThreadBody>) -> Response {
    let thread = body.thread.unwrap_or_default();
    if !thread_id_ok(&thread) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad thread id" }))).into_response();
    }
    crate::personas::request_stop(&format!("{TEAM_PREFIX}{thread}"));
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
    if let Some(name) = name {
        let safe = name.replace('"', "");
        if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{safe}\"")) {
            headers.insert(axum::http::header::CONTENT_DISPOSITION, v);
        }
    }
    (StatusCode::OK, headers, bytes).into_response()
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
    title: Option<String>,
    sheets: Option<Vec<crate::google_drive::Sheet>>,
}

async fn get_skills() -> Response {
    let list: Vec<Value> = crate::skills::available().into_iter().map(|s| json!({ "name": s.name, "description": s.description, "mcps": s.mcps })).collect();
    Json(list).into_response()
}

async fn post_drive_xlsx(State(state): State<Arc<AppState>>, Json(body): Json<XlsxBody>) -> Response {
    let Some(key) = thread_key_of(body.thread_key) else {
        return missing_thread_key();
    };
    let folder = match crate::google_drive::allowed(&key, &state.settings.get()) {
        Ok(f) => f,
        Err(err) => return (StatusCode::FORBIDDEN, Json(json!({ "error": err }))).into_response(),
    };
    let title = body.title.unwrap_or_default();
    let sheets = body.sheets.unwrap_or_default();
    if title.trim().is_empty() || sheets.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "title and at least one sheet are required" }))).into_response();
    }
    let task = crate::google_drive::task_id(&key, state.handler.ledger.as_deref(), &title);
    match state.drive.create_xlsx(&folder, &task, title.trim(), &sheets).await {
        Ok(created) => {
            let link = created.file.web_view_link.clone().unwrap_or_default();
            crate::handler::note(&state.handler, "drive_xlsx", &key, created.file.name.clone(), link).await;
            Json(created).into_response()
        }
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
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
