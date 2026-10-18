use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentDriverKind {
    #[default]
    Opencode,
    Claude,
    Pi,
}

impl AgentDriverKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "opencode" => Ok(Self::Opencode),
            "claude" => Ok(Self::Claude),
            "pi" => Ok(Self::Pi),
            other => Err(format!(r#"AGENT_DRIVER must be "opencode", "claude" or "pi" (got "{other}")"#)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoConfig {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub token_audience: Option<String>,
    pub tunnel: Option<crate::tunnel::TunnelMode>,
    pub service_account_json: Option<String>,
    pub allowed_spaces: Vec<String>,
    pub agent_driver: AgentDriverKind,
    pub workdir: PathBuf,
    pub opencode_bin: String,
    pub opencode_model: Option<String>,
    pub claude_bin: String,
    pub claude_model: Option<String>,
    pub turn_timeout_ms: u64,
    pub data_dir: PathBuf,
    pub repos: HashMap<String, RepoConfig>,
    pub admin_port: u16,
    pub skip_token_verify: bool,
}

fn env_str(key: &str) -> Option<String> {
    env::var(key).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn load_repos(file: Option<&str>) -> Result<HashMap<String, RepoConfig>, String> {
    let Some(file) = file else {
        return Ok(HashMap::new());
    };
    let raw = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let parsed: HashMap<String, RepoConfig> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    for (name, repo) in &parsed {
        if repo.path.is_empty() {
            return Err(format!(r#"AGENT_REPOS_FILE: repo "{name}" needs a "path""#));
        }
    }
    Ok(parsed)
}

pub fn load_config() -> Result<Config, String> {
    let allowed_spaces = env_str("CHAT_ALLOWED_SPACES")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let turn_timeout_ms = env_str("AGENT_TURN_TIMEOUT_MS")
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(600_000);
    let home = dirs_home();
    let default_workdir = home
        .join(".local")
        .join("share")
        .join("switchboard")
        .join("workspace");
    Ok(Config {
        port: env_str("PORT").and_then(|s| s.parse().ok()).unwrap_or(8080),
        token_audience: env_str("GOOGLE_TOKEN_AUDIENCE"),
        tunnel: env_str("TUNNEL").and_then(|v| crate::tunnel::TunnelMode::parse(&v)),
        service_account_json: env_str("GOOGLE_SERVICE_ACCOUNT_JSON"),
        allowed_spaces,
        agent_driver: AgentDriverKind::parse(env_str("AGENT_DRIVER").as_deref().unwrap_or("opencode"))?,
        workdir: env_str("AGENT_WORKDIR").map(PathBuf::from).unwrap_or(default_workdir),
        opencode_bin: env_str("OPENCODE_BIN").unwrap_or_else(|| "opencode".into()),
        opencode_model: env_str("OPENCODE_MODEL"),
        claude_bin: env_str("CLAUDE_BIN").unwrap_or_else(|| "claude".into()),
        claude_model: env_str("CLAUDE_MODEL"),
        turn_timeout_ms,
        data_dir: env_str("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("./data")),
        admin_port: env_str("ADMIN_PORT").and_then(|s| s.parse().ok()).unwrap_or(8081),
        repos: load_repos(env_str("AGENT_REPOS_FILE").as_deref())?,
        skip_token_verify: env_str("SWITCHBOARD_SKIP_VERIFY").as_deref() == Some("1"),
    })
}

fn dirs_home() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_driver() {
        assert_eq!(AgentDriverKind::parse("opencode").unwrap(), AgentDriverKind::Opencode);
        assert!(AgentDriverKind::parse("nope").is_err());
    }
}
