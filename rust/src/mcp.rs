use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::driver::types::AgentTurnResult;

#[derive(Debug, Clone)]
pub struct SwitchboardMcp {
    pub server_path: String,
    pub admin_url: String,
}

pub fn mcp_env(thread_key: &str, admin_url: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert(
        "SWITCHBOARD_ADMIN_URL".into(),
        admin_url.trim_end_matches('/').to_string(),
    );
    m.insert("SWITCHBOARD_THREAD_KEY".into(), thread_key.to_string());
    m
}

pub fn claude_mcp_config(server_path: &str, thread_key: &str, admin_url: &str) -> String {
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "switchboard".into());
    json!({
        "mcpServers": {
            "switchboard": {
                "command": exe,
                "args": ["mcp", "--server", server_path],
                "env": mcp_env(thread_key, admin_url)
            }
        }
    })
    .to_string()
}

pub fn switchboard_thread_note(thread_key: &str) -> String {
    format!("[Switchboard thread: {thread_key}. Pass it as \"thread\" when you call switchboard tools.]")
}

pub fn opencode_mcp_args(server_path: &str, admin_url: &str) -> Vec<String> {
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "switchboard".into());
    vec![
        "mcp".into(),
        "add".into(),
        "switchboard".into(),
        "--global".into(),
        "--env".into(),
        format!("SWITCHBOARD_ADMIN_URL={}", admin_url.trim_end_matches('/')),
        "--".into(),
        exe,
        "mcp".into(),
        "--server".into(),
        server_path.to_string(),
    ]
}

pub const SWITCHBOARD_HINT: &str = "You have Switchboard MCP tools for this chat thread. After creating or choosing an Azure work item, call link_work_item. To work in a configured git repo, call list_repos then attach_repo (detach_repo to leave). Use start_app / stop_app for the repo's configured up command. Use thread_status to inspect the panel state. For recurring work, create_schedule / list_schedules / update_schedule / delete_schedule.";

fn tools() -> Value {
    json!([
        {"name":"invite_agent","description":"Add an agent to the current chat room.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}},
        {"name":"link_work_item","description":"Attach an Azure DevOps work item.","inputSchema":{"type":"object","properties":{"id":{"type":"number"}},"required":["id"]}},
        {"name":"clear_work_item","description":"Remove the work item link.","inputSchema":{"type":"object","properties":{}}},
        {"name":"list_repos","description":"List configured repos.","inputSchema":{"type":"object","properties":{}}},
        {"name":"attach_repo","description":"Attach a repo worktree.","inputSchema":{"type":"object","properties":{"repo":{"type":"string"}},"required":["repo"]}},
        {"name":"detach_repo","description":"Detach the repo worktree.","inputSchema":{"type":"object","properties":{}}},
        {"name":"thread_status","description":"Read thread context.","inputSchema":{"type":"object","properties":{}}},
        {"name":"start_app","description":"Start the repo up command.","inputSchema":{"type":"object","properties":{}}},
        {"name":"stop_app","description":"Stop the thread app.","inputSchema":{"type":"object","properties":{}}},
        {"name":"list_schedules","description":"List schedules.","inputSchema":{"type":"object","properties":{}}},
        {"name":"create_schedule","description":"Create a schedule.","inputSchema":{"type":"object","properties":{"cron":{"type":"string"},"prompt":{"type":"string"},"name":{"type":"string"}},"required":["cron","prompt"]}},
        {"name":"update_schedule","description":"Update a schedule.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"enabled":{"type":"boolean"},"cron":{"type":"string"},"prompt":{"type":"string"},"name":{"type":"string"}},"required":["id"]}},
        {"name":"delete_schedule","description":"Delete a schedule.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}},
        {"name":"create_xlsx","description":"Create an .xlsx in the shared Google Drive folder and return its link. Numbers stay numbers. Calling it again for the same request returns the same file.","inputSchema":{"type":"object","properties":{"title":{"type":"string"},"sheets":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"rows":{"type":"array","items":{"type":"array"}}},"required":["name","rows"]}}},"required":["title","sheets"]}},
        {"name":"list_spreadsheets","description":"List the .xlsx files in the shared Google Drive folder.","inputSchema":{"type":"object","properties":{}}}
    ])
}

fn with_thread_arg(tool: &Value) -> Value {
    let mut t = tool.clone();
    if let Some(schema) = t.get_mut("inputSchema") {
        if let Some(props) = schema.get_mut("properties") {
            if let Some(obj) = props.as_object_mut() {
                obj.insert(
                    "thread".into(),
                    json!({"type":"string","description":"Switchboard thread id"}),
                );
            }
        }
    }
    t
}

pub async fn call_admin(
    path: &str,
    method: &str,
    body: Option<Value>,
    thread: bool,
    env: &HashMap<String, String>,
    client: &reqwest::Client,
) -> Result<Value, String> {
    let base = env
        .get("SWITCHBOARD_ADMIN_URL")
        .map(|s| s.trim_end_matches('/').to_string())
        .ok_or_else(|| "SWITCHBOARD_ADMIN_URL is not set".to_string())?;
    let thread_key = env.get("SWITCHBOARD_THREAD_KEY");
    if thread && thread_key.is_none() {
        return Err("SWITCHBOARD_THREAD_KEY is not set".into());
    }
    let mut url = format!("{base}{path}");
    if method == "GET" && thread {
        if let Some(tk) = thread_key {
            url.push_str(&format!("?threadKey={tk}"));
        }
    }
    let mut req = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => client.put(&url),
    };
    if let Some(mut b) = body {
        if thread {
            if let Some(tk) = thread_key {
                if let Some(obj) = b.as_object_mut() {
                    obj.entry("threadKey".to_string())
                        .or_insert_with(|| json!(tk));
                }
            }
        }
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let data: Value = res.json().await.unwrap_or(json!({}));
    if !status.is_success() {
        let err = data
            .get("error")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(err);
    }
    Ok(data)
}

pub async fn run_tool(
    name: &str,
    args: &Value,
    env: &HashMap<String, String>,
    client: &reqwest::Client,
) -> Result<String, String> {
    let mut env = env.clone();
    if let Some(thread) = args.get("thread").and_then(|v| v.as_str()).map(str::trim) {
        if !thread.is_empty() {
            env.insert("SWITCHBOARD_THREAD_KEY".into(), thread.to_string());
        }
    }
    match name {
        "invite_agent" => {
            let agent = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim_start_matches('@')
                .trim();
            if agent.is_empty() {
                return Err("name is required".into());
            }
            call_admin(
                "/api/thread/invite",
                "POST",
                Some(json!({ "name": agent })),
                true,
                &env,
                client,
            )
            .await?;
            Ok(format!("@{agent} joined the room."))
        }
        "link_work_item" => {
            let id = args.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            if id <= 0 {
                return Err("id must be a positive integer".into());
            }
            call_admin("/api/work-item", "PUT", Some(json!({ "id": id })), true, &env, client).await?;
            Ok(format!("Linked work item #{id} to this thread."))
        }
        "clear_work_item" => {
            call_admin("/api/work-item", "PUT", Some(json!({ "id": null })), true, &env, client).await?;
            Ok("Cleared the work item on this thread.".into())
        }
        "create_xlsx" => {
            let body = json!({ "title": args.get("title").cloned().unwrap_or(Value::Null), "sheets": args.get("sheets").cloned().unwrap_or(Value::Null) });
            let data = call_admin("/api/drive/xlsx", "POST", Some(body), true, &env, client).await?;
            let link = data.pointer("/file/webViewLink").and_then(|v| v.as_str()).unwrap_or("(no link)");
            let rows = data.get("rows").and_then(|v| v.as_u64()).unwrap_or(0);
            let verb = if data.get("created").and_then(|v| v.as_bool()) == Some(false) { "Already created" } else { "Created" };
            Ok(format!("{verb}: {link} ({rows} rows)"))
        }
        "list_spreadsheets" => {
            let data = call_admin("/api/drive/spreadsheets", "GET", None, true, &env, client).await?;
            let files = data.as_array().cloned().unwrap_or_default();
            if files.is_empty() {
                return Ok("No spreadsheets in the Drive folder yet.".into());
            }
            Ok(files
                .iter()
                .map(|f| format!("{} · {}", f["name"].as_str().unwrap_or(""), f["webViewLink"].as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "list_repos" => {
            let data = call_admin("/api/thread/repos", "GET", None, false, &env, client).await?;
            let repos = data
                .get("repos")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if repos.is_empty() {
                Ok("No repos configured in Switchboard yet.".into())
            } else {
                let names: Vec<_> = repos.iter().filter_map(|v| v.as_str()).collect();
                Ok(format!("Configured repos: {}", names.join(", ")))
            }
        }
        "attach_repo" => {
            let repo = args.get("repo").and_then(|v| v.as_str()).unwrap_or("").trim();
            if repo.is_empty() {
                return Err("repo is required".into());
            }
            let data =
                call_admin("/api/thread/repo", "PUT", Some(json!({ "repo": repo })), true, &env, client).await?;
            Ok(format!(
                "Attached {repo}. Worktree: {}. Branch: {}.",
                data.get("worktree").and_then(|v| v.as_str()).unwrap_or("?"),
                data.get("branch").and_then(|v| v.as_str()).unwrap_or("?")
            ))
        }
        "detach_repo" => {
            let data =
                call_admin("/api/thread/repo", "PUT", Some(json!({ "repo": null })), true, &env, client).await?;
            if let Some(b) = data.get("branchKept").and_then(|v| v.as_str()) {
                Ok(format!("Detached. Branch {b} kept in the repo."))
            } else {
                Ok("No repo was attached.".into())
            }
        }
        "thread_status" => {
            let s = call_admin("/api/thread/status", "GET", None, true, &env, client).await?;
            Ok(format!(
                "Repo: {}\nWork item: {}\nAgent: {}",
                s.get("repo").and_then(|v| v.as_str()).unwrap_or("none"),
                s.get("workItemId")
                    .and_then(|v| v.as_i64())
                    .map(|id| format!("#{id}"))
                    .unwrap_or_else(|| "none".into()),
                s.get("agent").and_then(|v| v.as_str()).unwrap_or("default")
            ))
        }
        "start_app" => {
            let data = call_admin(
                "/api/thread/app",
                "PUT",
                Some(json!({ "action": "up" })),
                true,
                &env,
                client,
            )
            .await?;
            Ok(format!(
                "App starting on http://localhost:{}",
                data.get("port").and_then(|v| v.as_u64()).unwrap_or(0)
            ))
        }
        "stop_app" => {
            let data = call_admin(
                "/api/thread/app",
                "PUT",
                Some(json!({ "action": "down" })),
                true,
                &env,
                client,
            )
            .await?;
            if data.get("stopped").and_then(|v| v.as_bool()).unwrap_or(false) {
                Ok("App stopped.".into())
            } else {
                Ok("The app was not running.".into())
            }
        }
        "list_schedules" => {
            let jobs = call_admin("/api/schedules", "GET", None, false, &env, client).await?;
            let arr = jobs.as_array().cloned().unwrap_or_default();
            if arr.is_empty() {
                Ok("No schedules.".into())
            } else {
                Ok(arr
                    .iter()
                    .map(|j| {
                        format!(
                            "{} · {}",
                            j.get("id").and_then(|v| v.as_str()).unwrap_or("?"),
                            j.get("name").and_then(|v| v.as_str()).unwrap_or("?")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
        }
        "create_schedule" => {
            let cron = args.get("cron").and_then(|v| v.as_str()).unwrap_or("").trim();
            let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("").trim();
            if cron.is_empty() || prompt.is_empty() {
                return Err("cron and prompt are required".into());
            }
            let status = call_admin("/api/thread/status", "GET", None, true, &env, client).await?;
            let mut body = json!({
                "cron": cron,
                "prompt": prompt,
                "space": status.get("space").and_then(|v| v.as_str()).unwrap_or("team-chat")
            });
            if let Some(name) = args.get("name").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                body["name"] = json!(name);
            }
            if let Some(repo) = status.get("repo").and_then(|v| v.as_str()) {
                body["repo"] = json!(repo);
            }
            let _jobs = call_admin("/api/schedules", "POST", Some(body), false, &env, client).await?;
            Ok("Schedule created.".into())
        }
        "update_schedule" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
            if id.is_empty() {
                return Err("id is required".into());
            }
            let mut patch = json!({ "id": id });
            if let Some(v) = args.get("enabled") {
                patch["enabled"] = v.clone();
            }
            if let Some(v) = args.get("cron") {
                patch["cron"] = v.clone();
            }
            if let Some(v) = args.get("prompt") {
                patch["prompt"] = v.clone();
            }
            if let Some(v) = args.get("name") {
                patch["name"] = v.clone();
            }
            call_admin("/api/schedules/update", "POST", Some(patch), false, &env, client).await?;
            Ok(format!("Updated schedule {id}."))
        }
        "delete_schedule" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
            if id.is_empty() {
                return Err("id is required".into());
            }
            call_admin(
                "/api/schedules/delete",
                "POST",
                Some(json!({ "id": id })),
                false,
                &env,
                client,
            )
            .await?;
            Ok(format!("Deleted schedule {id}."))
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn frame(msg: &Value, line_mode: bool) -> String {
    let body = msg.to_string();
    if line_mode {
        format!("{body}\n")
    } else {
        format!("Content-Length: {}\r\n\r\n{body}", body.len())
    }
}

pub async fn handle_rpc(msg: &Value, env: &HashMap<String, String>, client: &reqwest::Client) -> Option<String> {
    let method = msg.get("method")?.as_str()?;
    let id = msg.get("id").cloned();
    let line_mode = true;
    match method {
        "initialize" => Some(frame(
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "switchboard", "version": "0.1.0" }
                }
            }),
            line_mode,
        )),
        "notifications/initialized" | "initialized" => None,
        "tools/list" => {
            let listed: Vec<Value> = tools()
                .as_array()
                .unwrap()
                .iter()
                .map(with_thread_arg)
                .collect();
            Some(frame(
                &json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": listed } }),
                line_mode,
            ))
        }
        "tools/call" => {
            let name = msg
                .pointer("/params/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = msg
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));
            match run_tool(name, &args, env, client).await {
                Ok(text) => Some(frame(
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "content": [{ "type": "text", "text": text }] }
                    }),
                    line_mode,
                )),
                Err(err) => Some(frame(
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32000, "message": err }
                    }),
                    line_mode,
                )),
            }
        }
        "ping" => Some(frame(&json!({ "jsonrpc": "2.0", "id": id, "result": {} }), line_mode)),
        _ => Some(frame(
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": format!("unsupported method: {method}") }
            }),
            line_mode,
        )),
    }
}

pub async fn serve_stdio() -> Result<(), String> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let client = reqwest::Client::new();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if let Some(out) = handle_rpc(&msg, &env, &client).await {
            stdout.write_all(out.as_bytes()).map_err(|e| e.to_string())?;
            stdout.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn mcp_server_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("mcp-marker")
}

#[allow(dead_code)]
pub type _Unused = AgentTurnResult;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_json() {
        let raw = claude_mcp_config("/tmp/x", "thread-1", "http://127.0.0.1:8081/");
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            v["mcpServers"]["switchboard"]["env"]["SWITCHBOARD_THREAD_KEY"],
            "thread-1"
        );
    }

    #[tokio::test]
    async fn tools_list_rpc() {
        let env = HashMap::new();
        let client = reqwest::Client::new();
        let out = handle_rpc(
            &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            &env,
            &client,
        )
        .await
        .unwrap();
        assert!(out.contains("invite_agent"));
        assert!(out.contains("list_repos"));
    }
}
