use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use switchboard::admin::admin_router;
use switchboard::bridge::bridge_router;
use switchboard::build_runtime;
use switchboard::config::{AgentDriverKind, Config};
use tempfile::tempdir;
use tokio::net::TcpListener;

async fn start_servers(data_dir: std::path::PathBuf) -> (u16, u16, Arc<switchboard::state::AppState>) {
    let config = Config {
        port: 0,
        token_audience: Some("http://test/google/chat".into()),
        tunnel: Some(switchboard::tunnel::TunnelMode::Off),
        service_account_json: None,
        allowed_spaces: vec!["spaces/test".into()],
        agent_driver: AgentDriverKind::Opencode,
        workdir: data_dir.join("workspace"),
        opencode_bin: "opencode".into(),
        opencode_model: None,
        claude_bin: "claude".into(),
        claude_model: None,
        turn_timeout_ms: 5_000,
        data_dir,
        repos: HashMap::new(),
        admin_port: 0,
        skip_token_verify: true,
    };
    let runtime = build_runtime(config, true).unwrap();
    let state = runtime.state;

    let bridge_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let admin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge_port = bridge_listener.local_addr().unwrap().port();
    let admin_port = admin_listener.local_addr().unwrap().port();

    let bridge = bridge_router(state.clone());
    let admin = admin_router(state.clone());
    tokio::spawn(async move {
        axum::serve(bridge_listener, bridge).await.ok();
    });
    tokio::spawn(async move {
        axum::serve(admin_listener, admin).await.ok();
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    (bridge_port, admin_port, state)
}

async fn get_json(port: u16, path: &str) -> (u16, Value) {
    let url = format!("http://127.0.0.1:{port}{path}");
    let res = reqwest::Client::new()
        .get(&url)
        .header("host", format!("127.0.0.1:{port}"))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    let body = res.json().await.unwrap_or(json!({}));
    (status, body)
}

async fn put_json(port: u16, path: &str, body: Value) -> (u16, Value) {
    let url = format!("http://127.0.0.1:{port}{path}");
    let res = reqwest::Client::new()
        .put(&url)
        .header("host", format!("127.0.0.1:{port}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    let body = res.json().await.unwrap_or(json!({}));
    (status, body)
}

async fn post_json(port: u16, path: &str, body: Value) -> (u16, Value) {
    let url = format!("http://127.0.0.1:{port}{path}");
    let res = reqwest::Client::new()
        .post(&url)
        .header("host", format!("127.0.0.1:{port}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    let body = res.json().await.unwrap_or(json!({}));
    (status, body)
}

#[tokio::test]
async fn healthz_and_admin_contract() {
    let dir = tempdir().unwrap();
    let (bridge_port, admin_port, _) = start_servers(dir.path().to_path_buf()).await;

    let (status, body) = get_json(bridge_port, "/healthz").await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);

    let (status, body) = get_json(admin_port, "/api/health").await;
    assert_eq!(status, 200);
    assert!(body["starts"].as_u64().unwrap() >= 1);
    assert!(body.get("uptimeSec").is_some());
    assert!(body.get("supervised").is_some());

    let (status, body) = get_json(admin_port, "/api/settings").await;
    assert_eq!(status, 200);
    assert_eq!(body["agentDriver"], "opencode");
    assert!(body.get("repos").is_some());
    assert!(body.get("personas").is_some());
    assert!(body.get("contextFooter").is_some());

    let (status, body) = put_json(admin_port, "/api/settings", json!({ "contextFooter": "never" })).await;
    assert_eq!(status, 200);
    assert_eq!(body["contextFooter"], "never");

    let (status, body) = get_json(admin_port, "/api/agents").await;
    assert_eq!(status, 200);
    assert!(body.as_array().unwrap().len() >= 2);

    let (status, body) = get_json(admin_port, "/api/threads").await;
    assert_eq!(status, 200);
    assert!(body.as_array().is_some());

    let (status, body) = get_json(admin_port, "/api/schedules").await;
    assert_eq!(status, 200);
    assert!(body.as_array().is_some());

    let (status, body) = post_json(
        admin_port,
        "/api/schedules",
        json!({
            "prompt": "ping",
            "cron": "0 9 * * 1-5",
            "space": "team-chat"
        }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body.as_array().unwrap().len(), 1);
    assert_eq!(body[0]["when"], "Weekdays at 09:00");

    let (status, body) = get_json(admin_port, "/api/google").await;
    assert_eq!(status, 200);
    assert_eq!(body["configured"], false);

    let (status, body) = get_json(admin_port, "/api/ado/status").await;
    assert_eq!(status, 200);
    assert!(body["connected"].is_boolean());
    if body["connected"] == false {
        let (status, body) = get_json(admin_port, "/api/ado/projects").await;
        assert_eq!(status, 409);
        assert!(body["error"].as_str().unwrap().contains("Azure DevOps"));
    }

    let (status, body) = get_json(admin_port, "/api/team/threads").await;
    assert_eq!(status, 200);
    assert!(body.as_array().is_some());

    let (status, _) = put_json(
        admin_port,
        "/api/settings",
        json!({ "personas": [{ "name": "qa", "prompt": "You are QA" }] }),
    )
    .await;
    assert_eq!(status, 200);

    let (status, body) = post_json(
        admin_port,
        "/api/team/members",
        json!({
            "thread": "room-contract-1",
            "op": "add",
            "member": { "kind": "agent", "persona": "qa" }
        }),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body["members"].as_array().unwrap().iter().any(|m| m["persona"] == "qa"));
}

#[tokio::test]
async fn google_chat_accepts_message() {
    let dir = tempdir().unwrap();
    let (bridge_port, _, _) = start_servers(dir.path().to_path_buf()).await;

    let (status, body) = post_json(
        bridge_port,
        "/google/chat",
        json!({
            "type": "MESSAGE",
            "space": { "name": "spaces/test" },
            "message": {
                "text": "hello rust",
                "thread": { "name": "spaces/test/threads/t1" },
                "sender": { "displayName": "Nahuel" }
            }
        }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn static_ui_when_built() {
    let dir = tempdir().unwrap();
    let web = dir.path().join("webdist");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("index.html"), b"<html>switchboard</html>").unwrap();
    let res = switchboard::static_files::serve_static(Some(&web), "/").await;
    assert_eq!(res.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn activity_records_turns_and_members() {
    let dir = tempdir().unwrap();
    let (_bridge, admin, _state) = start_servers(dir.path().to_path_buf()).await;
    put_json(admin, "/api/settings", json!({ "personas": [{ "name": "qa", "prompt": "QA" }] })).await;
    post_json(admin, "/api/team/members", json!({ "thread": "act1", "op": "add", "member": { "kind": "agent", "persona": "qa" } })).await;
    post_json(admin, "/api/team/send", json!({ "thread": "act1", "name": "Ana", "text": "hola equipo" })).await;
    let mut kinds = Vec::new();
    for _ in 0..50 {
        let (_, events) = get_json(admin, "/api/activity").await;
        kinds = events.as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
        if kinds.contains(&"turn_ok".to_string()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(kinds.contains(&"member_add".to_string()), "{kinds:?}");
    assert!(kinds.contains(&"turn_ok".to_string()), "{kinds:?}");
    let (_, only) = get_json(admin, "/api/activity?kind=member_add").await;
    let only = only.as_array().unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(only[0]["href"], "#team/act1");
    assert_eq!(only[0]["title"], "@qa");
    let (_, threads) = get_json(admin, "/api/threads").await;
    let room = threads.as_array().unwrap().iter().find(|t| t["key"] == "share/act1").unwrap();
    assert_eq!(room["members"], json!(["@qa", "Ana"]));
}

#[tokio::test]
async fn search_requires_two_characters_and_finds_messages() {
    let dir = tempdir().unwrap();
    let (_bridge, admin, _state) = start_servers(dir.path().to_path_buf()).await;
    post_json(admin, "/api/team/send", json!({ "thread": "s1", "name": "Ana", "text": "el token de Meta vence" })).await;
    post_json(admin, "/api/team/send", json!({ "thread": "s2", "name": "Beto", "text": "otra cosa" })).await;
    let (status, _) = get_json(admin, "/api/search?q=a").await;
    assert_eq!(status, 400);
    let (status, hits) = get_json(admin, "/api/search?q=token%20de%20meta").await;
    assert_eq!(status, 200);
    let hits = hits.as_array().unwrap();
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| h["threadKey"] == "share/s1"));
}

async fn job_by_command(admin: u16, command: &str) -> Value {
    let (_, jobs) = get_json(admin, "/api/schedules").await;
    jobs.as_array().unwrap().iter().find(|j| j["command"] == command).unwrap().clone()
}

async fn wait_status(admin: u16, command: &str, status: &str) -> Value {
    for _ in 0..50 {
        let job = job_by_command(admin, command).await;
        if job["lastStatus"] == status {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{command} never reached {status}: {}", job_by_command(admin, command).await);
}

#[tokio::test]
async fn command_jobs_run_and_approval_gates_them() {
    let dir = tempdir().unwrap();
    let (_bridge, admin, _state) = start_servers(dir.path().to_path_buf()).await;
    for (command, approval) in [("ship", false), ("release", true)] {
        let (status, _) = post_json(
            admin,
            "/api/schedules",
            json!({ "prompt": format!("do {command}"), "trigger": "command", "command": command, "space": "*", "needsApproval": approval }),
        )
        .await;
        assert_eq!(status, 200);
    }
    post_json(admin, "/api/team/send", json!({ "thread": "wf", "name": "Ana", "text": "hola, nada de ship" })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(job_by_command(admin, "ship").await["lastStatus"].is_null());

    post_json(admin, "/api/team/send", json!({ "thread": "wf", "name": "Ana", "text": "/ship" })).await;
    let ship = wait_status(admin, "ship", "ok").await;
    let (_, log) = get_json(admin, &format!("/api/schedules/log?id={}", ship["id"].as_str().unwrap())).await;
    assert_eq!(log["messages"].as_array().unwrap().len(), 2);

    post_json(admin, "/api/team/send", json!({ "thread": "wf", "name": "Ana", "text": "/release" })).await;
    let release = wait_status(admin, "release", "pending").await;
    let release_id = release["id"].as_str().unwrap().to_string();
    let (_, approvals) = get_json(admin, "/api/approvals").await;
    let pending = approvals.as_array().unwrap()[0]["id"].as_str().unwrap().to_string();
    post_json(admin, "/api/approvals/decide", json!({ "id": pending, "approve": false })).await;
    wait_status(admin, "release", "denied").await;
    let (_, log) = get_json(admin, &format!("/api/schedules/log?id={release_id}")).await;
    assert!(log["messages"].as_array().unwrap().is_empty());

    post_json(admin, "/api/team/send", json!({ "thread": "wf", "name": "Ana", "text": "/release" })).await;
    wait_status(admin, "release", "pending").await;
    let (_, approvals) = get_json(admin, "/api/approvals").await;
    let pending = approvals.as_array().unwrap()[0]["id"].as_str().unwrap().to_string();
    post_json(admin, "/api/team/send", json!({ "thread": "wf", "name": "Ana", "text": format!("/approve {pending}") })).await;
    wait_status(admin, "release", "ok").await;
    let (_, log) = get_json(admin, &format!("/api/schedules/log?id={release_id}")).await;
    assert_eq!(log["messages"].as_array().unwrap().len(), 2);
    let (_, events) = get_json(admin, "/api/activity?kind=approval_pending,approval_decided").await;
    assert_eq!(events.as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn json_cli_matches_the_admin_api() {
    let dir = tempdir().unwrap();
    let (_bridge, admin, _state) = start_servers(dir.path().to_path_buf()).await;
    post_json(admin, "/api/team/send", json!({ "thread": "cli1", "name": "Ana", "text": "hola desde la api" })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let base = format!("http://127.0.0.1:{admin}");
    let args: Vec<String> = ["activity", "--limit", "50"].iter().map(|s| s.to_string()).collect();
    let via_cli = switchboard::cli::send(&base, switchboard::cli::plan(&args, None).unwrap()).await.unwrap();
    let (_, via_api) = get_json(admin, "/api/activity?limit=50").await;
    assert_eq!(via_cli, via_api);
    let send: Vec<String> = ["thread", "send", "--thread", "cli1", "otra", "vez"].iter().map(|s| s.to_string()).collect();
    switchboard::cli::send(&base, switchboard::cli::plan(&send, None).unwrap()).await.unwrap();
    let (_, thread) = get_json(admin, "/api/team/thread?thread=cli1").await;
    assert!(thread["messages"].as_array().unwrap().iter().any(|m| m["text"] == "otra vez"));
    let down = switchboard::cli::send("http://127.0.0.1:1", switchboard::cli::plan(&args, None).unwrap()).await;
    assert_eq!(down.unwrap_err(), "control plane is not running");
}
