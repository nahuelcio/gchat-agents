use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::driver::types::AgentTurnResult;

pub fn mcp_env(thread_key: &str, admin_url: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert(
        "SWITCHBOARD_ADMIN_URL".into(),
        admin_url.trim_end_matches('/').to_string(),
    );
    m.insert("SWITCHBOARD_THREAD_KEY".into(), thread_key.to_string());
    m
}

pub const ENGRAM_HINT: &str = "\
You have Engram persistent memory (engram__mem_save, engram__mem_search, engram__mem_context, \
engram__mem_session_summary, engram__mem_get_observation, engram__mem_update, engram__mem_suggest_topic_key). \
When you have a `codemode` tool, call them from a script as `await tools.engram__mem_save({...})`. \
It survives sessions and compaction — use it proactively; do not wait to be asked.\n\
\n\
SAVE immediately with engram__mem_save after: architecture/design decisions, conventions, bug fixes \
(with root cause), non-obvious discoveries, tool/library choices, and user preferences or confirmations/rejections. \
Self-check after every task: if any of those happened, save now.\n\
Format: title = verb + what; type = bugfix|decision|architecture|discovery|pattern|config|preference; \
scope = project (default)|personal; topic_key = stable key for evolving topics (reuse to upsert); \
content = What / Why / Where / Learned.\n\
\n\
SEARCH when the user asks to recall past work, or proactively when starting something that may have been done before, \
or on a first message that names a feature/problem: engram__mem_context first, then engram__mem_search, \
then engram__mem_get_observation for full text.\n\
\n\
Before saying you are done, call engram__mem_session_summary (Goal, Instructions, Discoveries, Accomplished, \
Next Steps, Relevant Files). After compaction/context reset, save the summary, then mem_context, then continue. \
Memory calls are bookkeeping — finish them before the user-facing answer.";

pub fn engram_registered(settings: &crate::settings::Settings) -> bool {
    settings
        .mcp_servers
        .iter()
        .any(|m| m.name == crate::mcp_client::ENGRAM_NAME)
}

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
        {"name":"list_spreadsheets","description":"List the .xlsx files in the shared Google Drive folder.","inputSchema":{"type":"object","properties":{}}},
        {"name":"create_artifact","description":"Publish a Switchboard-styled HTML artifact teammates view inline. ALWAYS use template+fields (never invent CSS or dark themes). Templates: walkthrough, compare, quiz, cards. After success, put the returned marker in your reply — do not paste HTML.","inputSchema":{"type":"object","properties":{"title":{"type":"string","description":"Short label above the preview"},"template":{"type":"string","description":"walkthrough | compare | quiz | cards"},"fields":{"type":"object","description":"Placeholder values e.g. TITLE, LEAD, STEP1_TITLE, Q1, Q1_A, Q1_ANSWER (0|1|2), …"}},"required":["title","template","fields"]}},
        {"name":"skill_search","description":"Search installed skills by name or description (case-insensitive substring). Empty query lists all. Use when unsure which skill fits a task.","inputSchema":{"type":"object","properties":{"query":{"type":"string"}}}},
        {"name":"skill_load","description":"Load a skill's full instructions plus its bundled file list. Required before acting on a skill from the catalog or skill_search.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}},
        {"name":"list_agents","description":"List the specialised agents you can ask, with what each one knows.","inputSchema":{"type":"object","properties":{}}},
        {"name":"ask_agent","description":"Ask another specialised agent a question and get its answer. Use it when the question belongs to that agent's field.","inputSchema":{"type":"object","properties":{"agent":{"type":"string"},"question":{"type":"string"}},"required":["agent","question"]}}
    ])
}

pub fn group_of(tool: &str) -> &'static str {
    match tool {
        "create_xlsx" | "list_spreadsheets" => "google-drive",
        "ask_agent" | "list_agents" => "agents",
        "skill_search" | "skill_load" => "skills",
        _ => "switchboard",
    }
}

fn wants_drive(env: &HashMap<String, String>) -> bool {
    wants_group(env, "google-drive")
}

fn wants_calendar(env: &HashMap<String, String>) -> bool {
    wants_group(env, "google-calendar")
}

fn wants_gmail(env: &HashMap<String, String>) -> bool {
    wants_group(env, "google-gmail")
}

fn wants_group(env: &HashMap<String, String>, group: &str) -> bool {
    allowed_groups(env).is_none_or(|groups| groups.iter().any(|g| g == group))
}

fn allowed_groups(env: &HashMap<String, String>) -> Option<Vec<String>> {
    env.get("SWITCHBOARD_MCPS").map(|v| v.split(',').map(|g| g.trim().to_string()).filter(|g| !g.is_empty()).collect())
}

pub struct External {
    pub child: crate::mcp_client::McpChild,
    pub tools: Vec<Value>,
}

pub async fn start_external(env: &HashMap<String, String>, client: &reqwest::Client) -> Vec<External> {
    let Ok(listed) = call_admin("/api/mcp/servers", "GET", None, false, env, client).await else {
        return Vec::new();
    };
    let servers: Vec<crate::mcp_client::McpServer> = serde_json::from_value(listed).unwrap_or_default();
    let wanted = allowed_groups(env);
    let mut out = Vec::new();
    for server in servers {
        if wanted.as_ref().is_some_and(|w| !w.contains(&server.name)) {
            continue;
        }
        let name = server.name.clone();
        match crate::mcp_client::McpChild::start(server).await {
            Ok(child) => {
                let tools = child.tools().await.unwrap_or_default();
                out.push(External { child, tools });
            }
            Err(err) => eprintln!("MCP {name}: {err}"),
        }
    }
    out
}

pub fn listed_tools(env: &HashMap<String, String>, external: &[External]) -> Vec<Value> {
    let wanted = allowed_groups(env);
    let keep = |group: &str| wanted.as_ref().is_none_or(|w| w.iter().any(|g| g == group));
    let mut out: Vec<Value> = tools()
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| keep(group_of(t["name"].as_str().unwrap_or(""))))
        .map(|t| {
            let mut t = with_thread_arg(t);
            t["_meta"] = json!({ "group": group_of(t["name"].as_str().unwrap_or("")) });
            t
        })
        .collect();
    for ext in external {
        for tool in &ext.tools {
            let mut t = tool.clone();
            let name = t["name"].as_str().unwrap_or("").to_string();
            t["name"] = json!(crate::mcp_client::prefixed(&ext.child.server.name, &name));
            t["_meta"] = json!({ "group": ext.child.server.name });
            out.push(t);
        }
    }
    out
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
            url.push_str(&format!("?threadKey={}", crate::cli::enc(tk)));
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

fn drive_args(args: &Value, mut body: Value) -> Value {
    if let Some(id) = args.get("taskId").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("taskId".into(), json!(id));
        }
    }
    body
}

fn drive_created(data: &Value, unit: &str) -> String {
    let link = data.pointer("/file/webViewLink").and_then(|v| v.as_str()).unwrap_or("(no link)");
    let n = data.get("rows").and_then(|v| v.as_u64()).unwrap_or(0);
    let verb = if data.get("created").and_then(|v| v.as_bool()) == Some(false) { "Already created" } else { "Created" };
    if unit.is_empty() {
        format!("{verb}: {link}")
    } else if unit.chars().all(|c| c.is_ascii_alphabetic()) {
        format!("{verb}: {link} ({n} {unit})")
    } else {
        format!("{verb}: {link} ({unit})")
    }
}

fn drive_list(data: &Value, empty: &str) -> String {
    let files = data.as_array().cloned().unwrap_or_default();
    if files.is_empty() {
        return empty.into();
    }
    files
        .iter()
        .map(|f| {
            let name = f["name"].as_str().unwrap_or("");
            let link = f["webViewLink"].as_str().unwrap_or("");
            match f["mimeType"].as_str().filter(|m| !m.is_empty()) {
                Some(mime) => format!("{name} · {mime} · {link}"),
                None => format!("{name} · {link}"),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
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
            let body = drive_args(args, json!({ "title": args.get("title").cloned().unwrap_or(Value::Null), "sheets": args.get("sheets").cloned().unwrap_or(Value::Null) }));
            let data = call_admin("/api/drive/xlsx", "POST", Some(body), true, &env, client).await?;
            Ok(drive_created(&data, "rows"))
        }
        "list_spreadsheets" => Ok(drive_list(&call_admin("/api/drive/spreadsheets", "GET", None, true, &env, client).await?, "No spreadsheets in the Drive folder yet.")),
        "create_artifact" => {
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
            let template = args.get("template").and_then(|v| v.as_str()).unwrap_or("").trim();
            let fields = args.get("fields").cloned().unwrap_or(json!({}));
            if title.is_empty() || template.is_empty() {
                return Err("title and template are required (walkthrough|compare|quiz|cards)".into());
            }
            if !fields.is_object() {
                return Err("fields must be an object of placeholder → string".into());
            }
            let data = call_admin(
                "/api/artifacts",
                "POST",
                Some(json!({ "title": title, "template": template, "fields": fields })),
                false,
                &env,
                client,
            )
            .await?;
            let marker = data.get("marker").and_then(|v| v.as_str()).unwrap_or("");
            Ok(format!(
                "Artifact \"{title}\" published ({template}). In your reply include a short intro and this marker on its own line (do not paste HTML):\n{marker}"
            ))
        }
        "skill_search" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
            let skills: Vec<_> = crate::skills::available()
                .into_iter()
                .filter(|s| crate::skills::loadable_name(&s.name))
                .filter(|s| q.is_empty() || s.name.to_lowercase().contains(&q) || s.description.to_lowercase().contains(&q))
                .map(|s| json!({ "name": s.name, "description": s.description }))
                .collect();
            Ok(json!({ "skills": skills, "hint": "load one with skill_load" }).to_string())
        }
        "skill_load" => {
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            if name.is_empty() {
                return Err("name is required".into());
            }
            let Some(skill) = crate::skills::load(name) else {
                return Err(format!("unknown skill: {name}. Use skill_search to find installed skills."));
            };
            let folder = crate::skills::skill_dir(&skill.name)
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            let files: Vec<_> = skill
                .files
                .iter()
                .map(|f| json!({ "path": f.path, "kind": f.path.split('/').next().unwrap_or("file") }))
                .collect();
            Ok(json!({
                "name": skill.name,
                "body": skill.body,
                "folder": folder,
                "files": files,
                "hint": "files are paths only; read their contents with your file tools when needed",
            })
            .to_string())
        }
        "list_agents" => {
            let data = call_admin("/api/agents/delegates", "GET", None, true, &env, client).await?;
            let list = data.as_array().cloned().unwrap_or_default();
            if list.is_empty() {
                return Ok("No other agents you can ask in this room.".into());
            }
            Ok(list.iter().map(|a| format!("@{} — {}", a["name"].as_str().unwrap_or(""), a["about"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"))
        }
        "ask_agent" => {
            let body = json!({ "agent": args.get("agent").cloned().unwrap_or(Value::Null), "question": args.get("question").cloned().unwrap_or(Value::Null) });
            let data = call_admin("/api/agents/ask", "POST", Some(body), true, &env, client).await?;
            Ok(data.get("answer").and_then(|v| v.as_str()).unwrap_or("").to_string())
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
    handle_rpc_with(msg, env, client, &[]).await
}

pub async fn handle_rpc_with(msg: &Value, env: &HashMap<String, String>, client: &reqwest::Client, external: &[External]) -> Option<String> {
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
            let mut listed = listed_tools(env, external);
            for (want, path, group) in [
                (wants_drive(env), "/api/drive/mcp/tools", "google-drive"),
                (wants_calendar(env), "/api/calendar/mcp/tools", "google-calendar"),
                (wants_gmail(env), "/api/gmail/mcp/tools", "google-gmail"),
            ] {
                if !want {
                    continue;
                }
                if let Ok(data) = call_admin(path, "GET", None, false, env, client).await {
                    if let Some(tools) = data.get("tools").and_then(|v| v.as_array()) {
                        for tool in tools {
                            let mut t = tool.clone();
                            t["_meta"] = json!({ "group": group });
                            listed.push(t);
                        }
                    }
                }
            }
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
            if let Some(ext) = external.iter().find(|e| name.starts_with(&format!("{}__", e.child.server.name))) {
                let tool = &name[ext.child.server.name.len() + 2..];
                let reply = match ext.child.call(tool, args).await {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err(err) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": err } }),
                };
                return Some(frame(&reply, line_mode));
            }
            match run_tool(name, &args, env, client).await {
                Ok(text) => Some(frame(
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "content": [{ "type": "text", "text": text }] }
                    }),
                    line_mode,
                )),
                Err(err) => {
                    if err.starts_with("unknown tool:") {
                        let mut forwarded = args.clone();
                        if let Some(obj) = forwarded.as_object_mut() {
                            obj.remove("thread");
                        }
                        for (want, path) in [
                            (wants_drive(env), "/api/drive/mcp/call"),
                            (wants_calendar(env), "/api/calendar/mcp/call"),
                            (wants_gmail(env), "/api/gmail/mcp/call"),
                        ] {
                            if !want {
                                continue;
                            }
                            match call_admin(path, "POST", Some(json!({ "name": name, "arguments": forwarded })), false, env, client).await {
                                Ok(result) => {
                                    return Some(frame(&json!({ "jsonrpc": "2.0", "id": id, "result": result }), line_mode))
                                }
                                Err(remote) if remote.starts_with("unknown tool:") => {}
                                Err(remote) => {
                                    return Some(frame(
                                        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": remote } }),
                                        line_mode,
                                    ))
                                }
                            }
                        }
                    }
                    Some(frame(
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32000, "message": err }
                        }),
                        line_mode,
                    ))
                }
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
    let external = start_external(&env, &client).await;
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
        if let Some(out) = handle_rpc_with(&msg, &env, &client, &external).await {
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

    #[tokio::test]
    async fn proxies_an_external_server_and_filters_by_group() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-mcp.mjs");
        std::fs::write(
            &script,
            crate::mcp_client::tests::FAKE_MCP,
        )
        .unwrap();
        let child = crate::mcp_client::McpChild::start(crate::mcp_client::McpServer {
            name: "fake".into(),
            command: "node".into(),
            args: vec![script.to_string_lossy().into_owned()],
            env: Default::default(),
        })
        .await
        .unwrap();
        let tools = child.tools().await.unwrap();
        let external = vec![External { child, tools }];
        let mut env = HashMap::new();
        let names = |env: &HashMap<String, String>| listed_tools(env, &external).iter().map(|t| (t["name"].as_str().unwrap().to_string(), t["_meta"]["group"].as_str().unwrap().to_string())).collect::<Vec<_>>();
        let all = names(&env);
        assert!(all.contains(&("fake__shout".into(), "fake".into())));
        assert!(all.contains(&("ask_agent".into(), "agents".into())));
        env.insert("SWITCHBOARD_MCPS".into(), "fake,google-drive".into());
        let some = names(&env);
        assert!(some.iter().all(|(_, g)| g == "fake" || g == "google-drive"), "{some:?}");
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "fake__shout", "arguments": { "text": "hola" } } });
        let out = handle_rpc_with(&call, &env, &reqwest::Client::new(), &external).await.unwrap();
        assert!(out.contains("HOLA"), "{out}");
    }

    #[tokio::test]
    async fn skill_search_filters_all_installed_and_skill_load_returns_body_and_folder() {
        let _dirs = crate::skills::TEST_DIRS_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("pdf/references")).unwrap();
        std::fs::write(dir.path().join("pdf/SKILL.md"), "---\nname: pdf\ndescription: Format PDFs\n---\nSplit pages before merging.").unwrap();
        std::fs::write(dir.path().join("pdf/references/pages.md"), "page rule").unwrap();
        std::fs::create_dir_all(dir.path().join("ventas")).unwrap();
        std::fs::write(dir.path().join("ventas/SKILL.md"), "---\nname: ventas\ndescription: Precios y planes\n---\nBody.").unwrap();
        crate::skills::set_dirs(vec![dir.path().to_path_buf()]);
        assert_eq!(group_of("skill_search"), "skills");
        assert_eq!(group_of("skill_load"), "skills");

        async fn run(name: &str, args: Value) -> Result<String, String> {
            run_tool(name, &args, &HashMap::new(), &reqwest::Client::new()).await
        }
        let out = run("skill_search", json!({ "query": "PDF" })).await.unwrap();
        assert!(out.contains("\"pdf\""), "{out}");
        assert!(!out.contains("ventas"), "{out}");
        assert!(out.contains("load one with skill_load"));
        let all = run("skill_search", json!({})).await.unwrap();
        assert!(all.contains("\"pdf\"") && all.contains("\"ventas\""), "{all}");

        let out = run("skill_load", json!({ "name": "pdf" })).await.unwrap();
        assert!(out.contains("Split pages before merging."), "{out}");
        assert!(out.contains("references/pages.md"), "{out}");
        assert!(out.contains("\"kind\":\"references\""), "{out}");
        assert!(out.contains("file tools"), "{out}");
        assert!(!out.contains("page rule"), "{out}");
        let folder = serde_json::to_string(&dir.path().join("pdf").to_string_lossy()).unwrap();
        assert!(out.contains(folder.trim_matches('"')), "{out}");

        let err = run("skill_load", json!({ "name": "nope" })).await.unwrap_err();
        assert!(err.contains("unknown skill: nope"), "{err}");
        let err = run("skill_load", json!({ "name": "../etc" })).await.unwrap_err();
        assert!(err.contains("unknown skill"), "{err}");
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
