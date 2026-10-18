use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{AgentDriver, AgentTurnInput, AgentTurnResult};
use crate::settings::SettingsStore;

const CODING: &[&str] = &["read", "write", "edit", "bash"];
const DRIVE: &[&str] = &["create_xlsx", "list_spreadsheets"];

#[derive(Clone)]
pub struct PiDriver {
    pub base_url: String,
    pub model: Option<String>,
    pub settings: Option<Arc<SettingsStore>>,
    pub timeout_ms: u64,
    pub retry_ms: u64,
}

pub fn tools_for(mcps: Option<Vec<String>>) -> Vec<&'static str> {
    let Some(mcps) = mcps.filter(|m| !m.is_empty()) else {
        return CODING.iter().chain(DRIVE).copied().collect();
    };
    let mut tools = Vec::new();
    if mcps.iter().any(|m| m == "coding") {
        tools.extend(CODING);
    }
    if mcps.iter().any(|m| m == "google-drive") {
        tools.extend(DRIVE);
    }
    tools
}

impl PiDriver {
    fn tools(&self, thread_key: &str) -> Vec<&'static str> {
        let settings = self.settings.as_ref().map(|s| s.get());
        let mcps = settings
            .as_ref()
            .and_then(|s| crate::google_drive::persona_of(thread_key, &s.personas))
            .map(crate::skills::mcps);
        tools_for(mcps)
    }
}

#[async_trait]
impl AgentDriver for PiDriver {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
        let body = json!({
            "conversationId": input.session_ref,
            "threadKey": input.thread_key,
            "requestId": input.request_id.clone().unwrap_or_else(|| format!("{}:{}", input.thread_key, uuid::Uuid::new_v4())),
            "text": input.text,
            "cwd": input.workdir,
            "model": input.model.clone().or_else(|| self.model.clone()),
            "tools": self.tools(&input.thread_key),
        });
        let url = format!("{}/turn", self.base_url.trim_end_matches('/'));
        let deadline = std::time::Instant::now() + Duration::from_millis(self.retry_ms);
        let res = loop {
            match reqwest::Client::new().post(&url).json(&body).timeout(Duration::from_millis(self.timeout_ms)).send().await {
                Ok(res) => break res,
                Err(e) if (e.is_connect() || e.is_request()) && std::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(e) if e.is_connect() => return Err("the Pi harness is not running".into()),
                Err(e) => return Err(e.to_string()),
            }
        };
        let out: Value = res.json().await.map_err(|e| e.to_string())?;
        if let Some(err) = out.get("error") {
            return Err(err.as_str().map(String::from).unwrap_or_else(|| err.to_string()));
        }
        Ok(AgentTurnResult {
            reply: out["reply"].as_str().unwrap_or_default().to_string(),
            session_ref: out["conversationId"].as_str().map(String::from),
            usage: None,
            pending: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_follow_the_agent_mcps() {
        assert_eq!(tools_for(None), vec!["read", "write", "edit", "bash", "create_xlsx", "list_spreadsheets"]);
        assert_eq!(tools_for(Some(vec!["google-drive".into()])), vec!["create_xlsx", "list_spreadsheets"]);
        assert_eq!(tools_for(Some(vec!["coding".into()])), vec!["read", "write", "edit", "bash"]);
    }
}
