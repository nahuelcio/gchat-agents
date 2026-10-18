use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{AgentDriver, AgentTurnInput, AgentTurnResult};
use crate::settings::SettingsStore;

#[derive(Clone)]
pub struct PiDriver {
    pub base_url: String,
    pub model: Option<String>,
    pub settings: Option<Arc<SettingsStore>>,
    pub timeout_ms: u64,
    pub retry_ms: u64,
}

pub fn pi_model(model: &str) -> String {
    match model.split_once('/') {
        Some(("zai-coding-plan", id)) => format!("zai/{id}"),
        _ => model.to_string(),
    }
}

impl PiDriver {
    fn groups(&self, thread_key: &str) -> Option<Vec<String>> {
        let settings = self.settings.as_ref()?.get();
        let persona = crate::google_drive::persona_of(thread_key, &settings.personas)?;
        Some(crate::skills::mcps(persona)).filter(|m| !m.is_empty())
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
            "model": input.model.clone().or_else(|| self.model.clone()).map(|m| pi_model(&m)),
            "mcps": self.groups(&input.thread_key),
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
    fn opencode_zai_names_map_to_pi() {
        assert_eq!(pi_model("zai-coding-plan/glm-5.3-flash"), "zai/glm-5.3-flash");
        assert_eq!(pi_model("anthropic/claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5");
    }
}
