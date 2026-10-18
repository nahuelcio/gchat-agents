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

const WITHOUT_PERSONA: &[&str] = &["coding", "switchboard"];

impl PiDriver {
    fn persona(&self, thread_key: &str) -> Option<crate::settings::Persona> {
        let settings = self.settings.as_ref()?.get();
        crate::google_drive::persona_of(thread_key, &settings.personas).cloned()
    }

    fn groups(&self, thread_key: &str) -> Option<Vec<String>> {
        match self.persona(thread_key) {
            Some(p) => Some(crate::skills::mcps(&p)).filter(|m| !m.is_empty()),
            None => Some(WITHOUT_PERSONA.iter().map(|g| g.to_string()).collect()),
        }
    }

    fn instructions(&self, thread_key: &str) -> Option<String> {
        let p = self.persona(thread_key)?;
        let skills = crate::skills::instructions(&p);
        Some([p.prompt.trim().to_string(), skills].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")).filter(|s| !s.is_empty())
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}{path}", self.base_url.trim_end_matches('/'));
        let deadline = std::time::Instant::now() + Duration::from_millis(self.retry_ms);
        loop {
            match reqwest::Client::new().post(&url).json(body).timeout(Duration::from_secs(70)).send().await {
                Ok(res) => {
                    let out: Value = res.json().await.map_err(|e| e.to_string())?;
                    return match out.get("error").filter(|_| out.get("status").is_none()) {
                        Some(err) => Err(err.as_str().map(String::from).unwrap_or_else(|| err.to_string())),
                        None => Ok(out),
                    };
                }
                Err(e) if (e.is_connect() || e.is_request()) && std::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(e) if e.is_connect() => return Err("the Pi harness is not running".into()),
                Err(e) => return Err(e.to_string()),
            }
        }
    }

    pub async fn wait(&self, request_id: &str) -> Result<Option<AgentTurnResult>, String> {
        loop {
            let out = self.post("/wait", &json!({ "requestId": request_id, "timeoutMs": self.timeout_ms.clamp(500, 50_000) })).await?;
            let session = out["conversationId"].as_str().map(String::from);
            match out["status"].as_str() {
                Some("running") => continue,
                Some("unknown") => return Ok(None),
                Some("done") => {
                    return Ok(Some(AgentTurnResult {
                        reply: out["reply"].as_str().unwrap_or_default().to_string(),
                        session_ref: session,
                        usage: None,
                        pending: None,
                    }))
                }
                _ => return Err(out["error"].as_str().unwrap_or("Pi did not answer").to_string()),
            }
        }
    }
}

#[async_trait]
impl AgentDriver for PiDriver {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
        let request_id = input.request_id.clone().unwrap_or_else(|| format!("{}:{}", input.thread_key, uuid::Uuid::new_v4()));
        self.post(
            "/submit",
            &json!({
                "conversationId": input.session_ref,
                "threadKey": input.thread_key,
                "requestId": request_id,
                "text": input.text,
                "cwd": input.workdir,
                "model": input.model.clone().or_else(|| self.model.clone()).map(|m| pi_model(&m)),
                "mcps": self.groups(&input.thread_key),
                "instructions": self.instructions(&input.thread_key),
            }),
        )
        .await?;
        self.wait(&request_id).await?.ok_or_else(|| "Pi lost the request".to_string())
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

    #[test]
    fn a_thread_without_persona_gets_no_drive() {
        let driver = PiDriver { base_url: String::new(), model: None, settings: None, timeout_ms: 0, retry_ms: 0 };
        assert_eq!(driver.groups("dm/1"), Some(vec!["coding".to_string(), "switchboard".to_string()]));
    }
}
