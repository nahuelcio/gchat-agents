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
    fn names_are_lowercase_and_not_builtin() {
        assert!(valid_name("github"));
        assert!(valid_name("my-tools2"));
        assert!(!valid_name("GitHub"));
        assert!(!valid_name("google-drive"));
        assert!(!valid_name(""));
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
