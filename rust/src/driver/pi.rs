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

pub const DEFAULT_HOST_MCPS: &[&str] = &["coding", "switchboard", "engram", "agents", "google-drive"];

pub const DEFAULT_HOST_SKILLS: &[&str] = &["artifacts"];

fn host_persona(settings: &crate::settings::Settings) -> crate::settings::Persona {
    let skills = if settings.host_skills.is_empty() {
        DEFAULT_HOST_SKILLS.iter().map(|s| (*s).to_string()).collect()
    } else {
        settings.host_skills.clone()
    };
    crate::settings::Persona {
        name: "host".into(),
        prompt: settings.host_prompt.clone().unwrap_or_default(),
        driver: None,
        model: None,
        agent: None,
        listen: None,
        respond_to: None,
        skills,
        mcps: settings.host_mcps.clone().unwrap_or_default(),
        delegates: vec![],
        avatar: None,
    }
}

impl PiDriver {
    fn persona(&self, thread_key: &str) -> Option<crate::settings::Persona> {
        let settings = self.settings.as_ref()?.get();
        crate::google_drive::persona_of(thread_key, &settings.personas).cloned()
    }

    fn groups(&self, thread_key: &str) -> Option<Vec<String>> {
        match self.persona(thread_key) {
            Some(p) => Some(crate::skills::mcps(&p)).filter(|m| !m.is_empty()),
            None => match self.settings.as_ref() {
                Some(store) => {
                    let s = store.get();
                    match &s.host_mcps {
                        None => None,
                        Some(m) if m.is_empty() => None,
                        Some(_) => Some(crate::skills::mcps(&host_persona(&s))).filter(|m| !m.is_empty()),
                    }
                }
                None => None,
            },
        }
    }

    fn wants_engram(&self, thread_key: &str) -> bool {
        let registered = self
            .settings
            .as_ref()
            .is_some_and(|s| crate::mcp::engram_registered(&s.get()));
        if !registered {
            return false;
        }
        match self.groups(thread_key) {
            None => true,
            Some(g) => g.iter().any(|m| m == crate::mcp_client::ENGRAM_NAME),
        }
    }

    fn instructions(&self, thread_key: &str) -> Option<String> {
        let mut parts = Vec::new();
        if let Some(p) = self.persona(thread_key) {
            if !p.prompt.trim().is_empty() {
                parts.push(p.prompt.trim().to_string());
            }
            let skills = crate::skills::instructions(&p);
            if !skills.is_empty() {
                parts.push(skills);
            }
        } else if let Some(store) = &self.settings {
            let host = host_persona(&store.get());
            let skills = crate::skills::instructions(&host);
            if !skills.is_empty() {
                parts.push(skills);
            }
        }
        if self.wants_engram(thread_key) {
            parts.push(crate::mcp::ENGRAM_HINT.to_string());
        }
        Some(parts.join("\n\n")).filter(|s| !s.is_empty())
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
                    let usage = out.get("usage").and_then(|u| {
                        let context_tokens = u.get("contextTokens").and_then(|v| v.as_u64()).or_else(|| u.get("context_tokens").and_then(|v| v.as_u64()))?;
                        let context_window = u
                            .get("contextWindow")
                            .and_then(|v| v.as_u64())
                            .or_else(|| u.get("context_window").and_then(|v| v.as_u64()));
                        Some(crate::driver::types::ContextUsage { context_tokens, context_window })
                    });
                    return Ok(Some(AgentTurnResult {
                        reply: out["reply"].as_str().unwrap_or_default().to_string(),
                        session_ref: session,
                        usage,
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
                "mcps": input.mcps_override.clone().or_else(|| self.groups(&input.thread_key)),
                "instructions": input.instructions_override.clone().or_else(|| self.instructions(&input.thread_key)),
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
    fn zai_provider_names_map_to_pi() {
        assert_eq!(pi_model("zai-coding-plan/glm-5.3-flash"), "zai/glm-5.3-flash");
        assert_eq!(pi_model("anthropic/claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5");
    }

    #[test]
    fn a_thread_without_persona_gets_every_host_tool() {
        let driver = PiDriver { base_url: String::new(), model: None, settings: None, timeout_ms: 0, retry_ms: 0 };
        assert_eq!(driver.groups("dm/1"), None);
    }

    #[test]
    fn engram_protocol_is_injected_when_registered() {
        let dir = tempfile::tempdir().unwrap();
        let settings = std::sync::Arc::new(crate::settings::SettingsStore::open(
            dir.path().join("config.json"),
            crate::settings::SettingsDefaults::default(),
        ));
        let without = PiDriver {
            base_url: String::new(),
            model: None,
            settings: Some(settings.clone()),
            timeout_ms: 0,
            retry_ms: 0,
        };
        assert!(without.instructions("dm/1").is_none());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            settings
                .update(crate::settings::SettingsPatch {
                    mcp_servers: Some(vec![crate::mcp_client::default_engram()]),
                    ..Default::default()
                })
                .await
                .unwrap();
        });
        let with = PiDriver {
            base_url: String::new(),
            model: None,
            settings: Some(settings),
            timeout_ms: 0,
            retry_ms: 0,
        };
        let hint = with.instructions("dm/1").unwrap();
        assert!(hint.contains("engram__mem_save"), "{hint}");
        assert!(hint.contains("proactively"), "{hint}");
    }
}
