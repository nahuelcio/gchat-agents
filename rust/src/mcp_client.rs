use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

pub const BUILTIN_GROUPS: &[&str] = &["coding", "switchboard", "google-drive", "agents"];

pub const ENGRAM_NAME: &str = "engram";

pub const DEFAULT_PERSONA_MCPS: &[&str] = &[ENGRAM_NAME];

pub fn with_default_persona_mcps(mcps: Option<Vec<String>>) -> Vec<String> {
    match mcps {
        Some(m) if !m.is_empty() => m,
        _ => DEFAULT_PERSONA_MCPS.iter().map(|s| (*s).to_string()).collect(),
    }
}

pub fn default_engram() -> McpServer {
    McpServer {
        name: ENGRAM_NAME.into(),
        command: "engram".into(),
        args: vec!["mcp".into(), "--tools=agent".into()],
        env: BTreeMap::new(),
    }
}

pub async fn engram_installed() -> bool {
    Command::new(crate::driver::spawn::resolve_bin("engram"))
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !BUILTIN_GROUPS.contains(&name)
}

struct Io {
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next: u64,
}

pub struct McpChild {
    pub server: McpServer,
    _child: Child,
    io: Mutex<Io>,
}

impl McpChild {
    pub async fn start(server: McpServer) -> Result<Self, String> {
        let mut child = Command::new(crate::driver::spawn::resolve_bin(&server.command))
            .args(&server.args)
            .envs(&server.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("could not start MCP {}: {e}", server.name))?;
        let stdin = child.stdin.take().ok_or("missing stdin")?;
        let lines = BufReader::new(child.stdout.take().ok_or("missing stdout")?).lines();
        let me = Self { server, _child: child, io: Mutex::new(Io { stdin, lines, next: 1 }) };
        me.request("initialize", json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "switchboard", "version": "0.1.0" } }))
            .await?;
        me.notify("notifications/initialized").await?;
        Ok(me)
    }

    async fn notify(&self, method: &str) -> Result<(), String> {
        let mut io = self.io.lock().await;
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "method": method }));
        io.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut io = self.io.lock().await;
        let id = io.next;
        io.next += 1;
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        io.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        io.stdin.flush().await.map_err(|e| e.to_string())?;
        let wait = async {
            loop {
                let Some(raw) = io.lines.next_line().await.map_err(|e| e.to_string())? else {
                    return Err(format!("MCP {} closed", self.server.name));
                };
                let Ok(msg) = serde_json::from_str::<Value>(&raw) else { continue };
                if msg.get("id").and_then(|v| v.as_u64()) != Some(id) {
                    continue;
                }
                if let Some(err) = msg.get("error") {
                    return Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("MCP error").to_string());
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
        };
        tokio::time::timeout(Duration::from_secs(120), wait).await.map_err(|_| format!("MCP {} did not answer", self.server.name))?
    }

    pub async fn tools(&self) -> Result<Vec<Value>, String> {
        let listed = self.request("tools/list", json!({})).await?;
        Ok(listed.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default())
    }

    pub async fn call(&self, tool: &str, args: Value) -> Result<Value, String> {
        self.request("tools/call", json!({ "name": tool, "arguments": args })).await
    }
}

pub fn prefixed(server: &str, tool: &str) -> String {
    format!("{server}__{tool}")
}

#[derive(Debug)]
pub struct McpImport {
    pub servers: Vec<McpServer>,
    pub skipped: Vec<String>,
}

pub fn parse_mcp_config(raw: &str) -> Result<McpImport, String> {
    let value: Value = serde_json::from_str(raw.trim()).map_err(|e| format!("that is not JSON ({e})"))?;
    let mut servers = Vec::new();
    let mut skipped = Vec::new();
    if let Some(map) = value.get("mcpServers").and_then(|v| v.as_object()) {
        read_server_map(map, &mut servers, &mut skipped)?;
    } else if let Some(obj) = value.as_object() {
        if obj.contains_key("command") || obj.contains_key("url") || obj.contains_key("args") {
            let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("server");
            push_server(name, &value, &mut servers, &mut skipped)?;
        } else {
            read_server_map(obj, &mut servers, &mut skipped)?;
        }
    } else {
        return Err("expected an object of MCP servers".into());
    }
    if servers.is_empty() {
        return Err(if skipped.is_empty() {
            "no MCP servers in that JSON".into()
        } else {
            format!("only remote MCP servers ({}); this app runs stdio commands", skipped.join(", "))
        });
    }
    Ok(McpImport { servers, skipped })
}

fn read_server_map(map: &serde_json::Map<String, Value>, servers: &mut Vec<McpServer>, skipped: &mut Vec<String>) -> Result<(), String> {
    for (name, spec) in map {
        if name == "mcpServers" || !spec.is_object() {
            continue;
        }
        push_server(name, spec, servers, skipped)?;
    }
    Ok(())
}

fn push_server(name: &str, spec: &Value, servers: &mut Vec<McpServer>, skipped: &mut Vec<String>) -> Result<(), String> {
    let command = spec.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if command.is_empty() {
        if spec.get("url").is_some() {
            skipped.push(slug_name(name));
            return Ok(());
        }
        return Err(format!("MCP server \"{name}\" has no command"));
    }
    let name = slug_name(name);
    if !valid_name(&name) {
        return Err(format!("MCP server name \"{name}\" must be lowercase letters, digits or - and not a built-in name"));
    }
    if servers.iter().any(|s| s.name == name) {
        return Err(format!("MCP server {name} is listed twice"));
    }
    let args = match spec.get("args") {
        Some(Value::Array(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        Some(Value::String(s)) => s.split_whitespace().map(str::to_string).collect(),
        _ => Vec::new(),
    };
    let mut env = BTreeMap::new();
    if let Some(obj) = spec.get("env").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            let value = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            if !k.trim().is_empty() {
                env.insert(k.clone(), value);
            }
        }
    }
    servers.push(McpServer { name, command, args, env });
    Ok(())
}

fn slug_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if (c == '-' || c == '_' || c == ' ') && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(32).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const FAKE_MCP: &str = r#"import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } });
  if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'shout', description: 'Uppercase', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.arguments.text.toUpperCase() }] } });
});
"#;

    #[test]
    fn claude_and_cursor_json_become_stdio_servers() {
        let raw = r#"{
          "mcpServers": {
            "GitHub": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_x" } },
            "docs": { "url": "https://example.com/mcp" }
          }
        }"#;
        let got = parse_mcp_config(raw).unwrap();
        assert_eq!(got.servers.len(), 1);
        assert_eq!(got.servers[0].name, "github");
        assert_eq!(got.servers[0].command, "npx");
        assert_eq!(got.servers[0].args, vec!["-y", "@modelcontextprotocol/server-github"]);
        assert_eq!(got.servers[0].env.get("GITHUB_PERSONAL_ACCESS_TOKEN").map(String::as_str), Some("ghp_x"));
        assert_eq!(got.skipped, vec!["docs"]);
        let bare = parse_mcp_config(r#"{ "memory": { "command": "npx", "args": "-y @modelcontextprotocol/server-memory" } }"#).unwrap();
        assert_eq!(bare.servers[0].args, vec!["-y", "@modelcontextprotocol/server-memory"]);
        assert!(parse_mcp_config(r#"{ "mcpServers": { "remote": { "url": "https://x" } } }"#).unwrap_err().contains("stdio"));
        assert!(parse_mcp_config("not json").unwrap_err().contains("not JSON"));
    }

    #[test]
    fn names_are_lowercase_and_not_builtin() {
        assert!(valid_name("github"));
        assert!(valid_name("my-tools2"));
        assert!(valid_name("engram"));
        assert!(!valid_name("GitHub"));
        assert!(!valid_name("google-drive"));
        assert!(!valid_name(""));
    }

    #[test]
    fn default_engram_uses_agent_tools() {
        let s = default_engram();
        assert_eq!(s.name, "engram");
        assert_eq!(s.command, "engram");
        assert_eq!(s.args, vec!["mcp", "--tools=agent"]);
    }

    #[test]
    fn draft_mcps_default_to_engram_when_empty() {
        assert_eq!(with_default_persona_mcps(None), vec!["engram".to_string()]);
        assert_eq!(with_default_persona_mcps(Some(vec![])), vec!["engram".to_string()]);
        assert_eq!(
            with_default_persona_mcps(Some(vec!["google-drive".into()])),
            vec!["google-drive".to_string()]
        );
    }

    #[tokio::test]
    async fn talks_to_a_stdio_mcp_server() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-mcp.mjs");
        std::fs::write(
            &script,
            FAKE_MCP,
        )
        .unwrap();
        let child = McpChild::start(McpServer { name: "fake".into(), command: "node".into(), args: vec![script.to_string_lossy().into_owned()], env: BTreeMap::new() })
            .await
            .unwrap();
        let tools = child.tools().await.unwrap();
        assert_eq!(tools[0]["name"], "shout");
        let out = child.call("shout", json!({ "text": "hola" })).await.unwrap();
        assert_eq!(out["content"][0]["text"], "HOLA");
    }
}
