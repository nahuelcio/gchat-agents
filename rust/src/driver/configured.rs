use std::sync::Arc;

use async_trait::async_trait;

use super::types::{AgentDriver, AgentTurnInput, AgentTurnResult};
use super::{ClaudeDriver, OpenCodeDriver, PiDriver};
use crate::config::AgentDriverKind;
use crate::settings::SettingsStore;

pub struct ConfiguredDriver {
    pub opencode: OpenCodeDriver,
    pub claude: ClaudeDriver,
    pub pi: PiDriver,
    pub settings: Arc<SettingsStore>,
}

#[async_trait]
impl AgentDriver for ConfiguredDriver {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
        let s = self.settings.get();
        match input.driver.unwrap_or(s.agent_driver) {
            AgentDriverKind::Opencode => {
                OpenCodeDriver { model: s.models.opencode, agent: s.agents.opencode, ..self.opencode.clone() }
                    .run_turn(input)
                    .await
            }
            AgentDriverKind::Claude => ClaudeDriver { model: s.models.claude, ..self.claude.clone() }.run_turn(input).await,
            AgentDriverKind::Pi => PiDriver { model: s.models.pi, settings: Some(self.settings.clone()), ..self.pi.clone() }.run_turn(input).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::SettingsDefaults;

    #[tokio::test]
    async fn routes_each_turn_to_the_persona_driver() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-opencode.mjs");
        std::fs::write(
            &script,
            "#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'text',sessionID:'ses_1',part:{type:'text',text:'from opencode '+process.argv.slice(2).join(' ')}}));\n",
        )
        .unwrap();
        let settings = Arc::new(SettingsStore::open(
            dir.path().join("config.json"),
            SettingsDefaults {
                agent_driver: AgentDriverKind::Claude,
                ..Default::default()
            },
        ));
        let driver = ConfiguredDriver {
            opencode: OpenCodeDriver {
                bin: script.to_string_lossy().into_owned(),
                model: None,
                agent: None,
                timeout_ms: 10_000,
                switchboard: None,
            },
            claude: ClaudeDriver {
                bin: "missing-claude-binary".into(),
                model: None,
                timeout_ms: 10_000,
                switchboard: None,
                read_dirs: vec![],
            },
            pi: PiDriver { base_url: "http://127.0.0.1:1".into(), model: None, settings: None, timeout_ms: 1_000, retry_ms: 0 },
            settings,
        };
        let turn = |driver: Option<AgentDriverKind>| AgentTurnInput {
            thread_key: "t".into(),
            session_ref: None,
            text: "hi".into(),
            workdir: dir.path().to_string_lossy().into_owned(),
            model: Some("deepseek/deepseek-chat".into()),
            agent: None,
            driver,
            answer_questions: false,
            request_id: None,
        };
        let out = driver.run_turn(turn(Some(AgentDriverKind::Opencode))).await.unwrap();
        assert!(out.reply.contains("from opencode"));
        assert!(out.reply.contains("deepseek/deepseek-chat"));
        assert!(driver.run_turn(turn(None)).await.is_err());
    }
}
