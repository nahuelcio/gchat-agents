use crate::tunnel::TunnelMode;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::atomic::write_atomic;
use crate::config::{AgentDriverKind, RepoConfig};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContextFooter {
    Every,
    Every5,
    Above60,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Persona {
    pub name: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<AgentDriverKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(rename = "respondTo", skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub agent_driver: AgentDriverKind,
    pub models: Models,
    pub agents: Agents,
    pub repos: HashMap<String, RepoConfig>,
    pub allowed_spaces: Vec<String>,
    pub context_footer: ContextFooter,
    pub auto_compact_at: u32,
    pub personas: Vec<Persona>,
    #[serde(default)]
    pub tunnel: TunnelMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_drive_folder_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Models {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Agents {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsDefaults {
    pub agent_driver: AgentDriverKind,
    pub models: Models,
    pub agents: Agents,
    pub repos: HashMap<String, RepoConfig>,
    pub allowed_spaces: Vec<String>,
    pub context_footer: Option<ContextFooter>,
    pub auto_compact_at: Option<u32>,
    pub personas: Option<Vec<Persona>>,
}
type Listener = Arc<dyn Fn(&Settings) + Send + Sync>;


pub struct SettingsStore {
    file_path: PathBuf,
    inner: Mutex<Settings>,
    listeners: Mutex<Vec<Listener>>,
}

impl SettingsStore {
    pub fn open(file_path: impl AsRef<Path>, defaults: SettingsDefaults) -> Self {
        let file_path = file_path.as_ref().to_path_buf();
        let saved: PartialSettings = std::fs::read_to_string(&file_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let current = Settings {
            agent_driver: saved.agent_driver.unwrap_or(defaults.agent_driver),
            models: Models {
                opencode: saved.models.as_ref().and_then(|m| m.opencode.clone()).or(defaults.models.opencode),
                claude: saved.models.as_ref().and_then(|m| m.claude.clone()).or(defaults.models.claude),
                pi: saved.models.as_ref().and_then(|m| m.pi.clone()).or(defaults.models.pi),
            },
            agents: Agents {
                opencode: saved
                    .agents
                    .as_ref()
                    .and_then(|a| a.opencode.clone())
                    .or(defaults.agents.opencode),
            },
            repos: saved.repos.unwrap_or(defaults.repos),
            allowed_spaces: saved.allowed_spaces.unwrap_or(defaults.allowed_spaces),
            context_footer: saved
                .context_footer
                .or(defaults.context_footer)
                .unwrap_or(ContextFooter::Every5),
            auto_compact_at: saved.auto_compact_at.or(defaults.auto_compact_at).unwrap_or(85),
            personas: saved.personas.or(defaults.personas).unwrap_or_default(),
            tunnel: saved.tunnel.unwrap_or_default(),
            google_drive_folder_id: saved.google_drive_folder_id,
        };
        Self {
            file_path,
            inner: Mutex::new(current),
            listeners: Mutex::new(Vec::new()),
        }
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }

    pub fn on_change(&self, listener: Arc<dyn Fn(&Settings) + Send + Sync>) {
        self.listeners.lock().unwrap().push(listener);
    }

    pub async fn update(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let next = {
            let mut current = self.inner.lock().unwrap().clone();
            if let Some(v) = patch.agent_driver {
                current.agent_driver = v;
            }
            if let Some(v) = patch.models {
                current.models = v;
            }
            if let Some(v) = patch.agents {
                current.agents = v;
            }
            if let Some(v) = patch.repos {
                current.repos = v;
            }
            if let Some(v) = patch.allowed_spaces {
                current.allowed_spaces = v;
            }
            if let Some(v) = patch.context_footer {
                current.context_footer = v;
            }
            if let Some(v) = patch.auto_compact_at {
                current.auto_compact_at = v;
            }
            if let Some(v) = patch.personas {
                current.personas = v;
            }
            if let Some(v) = patch.tunnel {
                current.tunnel = v;
            }
            if let Some(v) = patch.google_drive_folder_id {
                current.google_drive_folder_id = Some(v.trim().to_string()).filter(|f| !f.is_empty());
            }
            validate(&current)?;
            current
        };
        let body = format!("{}\n", serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?);
        write_atomic(&self.file_path, &body).await.map_err(|e| e.to_string())?;
        *self.inner.lock().unwrap() = next.clone();
        for listener in self.listeners.lock().unwrap().iter() {
            listener(&next);
        }
        Ok(next)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialSettings {
    agent_driver: Option<AgentDriverKind>,
    models: Option<Models>,
    agents: Option<Agents>,
    repos: Option<HashMap<String, RepoConfig>>,
    allowed_spaces: Option<Vec<String>>,
    context_footer: Option<ContextFooter>,
    auto_compact_at: Option<u32>,
    personas: Option<Vec<Persona>>,
    tunnel: Option<TunnelMode>,
    google_drive_folder_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub agent_driver: Option<AgentDriverKind>,
    pub models: Option<Models>,
    pub agents: Option<Agents>,
    pub repos: Option<HashMap<String, RepoConfig>>,
    pub allowed_spaces: Option<Vec<String>>,
    pub context_footer: Option<ContextFooter>,
    pub auto_compact_at: Option<u32>,
    pub personas: Option<Vec<Persona>>,
    pub tunnel: Option<TunnelMode>,
    pub google_drive_folder_id: Option<String>,
}

fn validate(s: &Settings) -> Result<(), String> {
    let repo_name = Regex::new(r"^[a-zA-Z0-9._-]+$").unwrap();
    let persona_name = Regex::new(r"(?i)^[a-z0-9][a-z0-9_-]{0,31}$").unwrap();
    let space_re = Regex::new(r"^spaces/[^/\s]+$").unwrap();
    let agent_id = Regex::new(r"^[\w.-]+$").unwrap();
    if let Some(id) = &s.agents.opencode {
        if !agent_id.is_match(id) {
            return Err("agents.opencode must be a simple agent id (letters, digits, . _ -)".into());
        }
    }
    for (name, repo) in &s.repos {
        if !repo_name.is_match(name) {
            return Err(format!(r#""{name}" is not a valid repo name (letters, digits, . _ -)"#));
        }
        let path = Path::new(&repo.path);
        if !path.is_absolute() {
            return Err(format!(r#"repo "{name}": path must be an absolute directory"#));
        }
        if !path.is_dir() {
            return Err(format!(r#"repo "{name}": {} does not exist"#, repo.path));
        }
    }
    if s.auto_compact_at > 100 {
        return Err("autoCompactAt must be 0-100".into());
    }
    let mut names = std::collections::HashSet::new();
    for p in &s.personas {
        if !persona_name.is_match(&p.name) {
            return Err(format!(
                r#"agent "{}": use letters, digits, - or _ (no spaces, max 32)"#,
                p.name
            ));
        }
        let key = p.name.to_lowercase();
        if !names.insert(key) {
            return Err(format!("agent @{} is defined twice", p.name));
        }
    }
    for space in &s.allowed_spaces {
        if !space_re.is_match(space) {
            return Err(format!(r#""{space}" is not a space name (spaces/XXXX)"#));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn load_update_persist() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = SettingsStore::open(
            &path,
            SettingsDefaults {
                agent_driver: AgentDriverKind::Opencode,
                allowed_spaces: vec!["spaces/abc".into()],
                ..Default::default()
            },
        );
        assert_eq!(store.get().allowed_spaces, vec!["spaces/abc".to_string()]);
        store
            .update(SettingsPatch {
                context_footer: Some(ContextFooter::Never),
                ..Default::default()
            })
            .await
            .unwrap();
        let again = SettingsStore::open(&path, SettingsDefaults::default());
        assert_eq!(again.get().context_footer, ContextFooter::Never);
        assert_eq!(again.get().allowed_spaces, vec!["spaces/abc".to_string()]);
    }
}
