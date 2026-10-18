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
    #[serde(default, skip_serializing)]
    pub driver: Option<AgentDriverKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing)]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(rename = "respondTo", skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcps: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delegates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersonaTemplate {
    pub id: String,
    pub name: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(rename = "respondTo", skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcps: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delegates: Vec<String>,
}

impl PersonaTemplate {
    pub fn from_persona(id: String, p: &Persona) -> Self {
        Self {
            id,
            name: p.name.clone(),
            prompt: p.prompt.clone(),
            model: p.model.clone(),
            listen: p.listen.clone(),
            respond_to: p.respond_to.clone(),
            skills: p.skills.clone(),
            mcps: p.mcps.clone(),
            delegates: p.delegates.clone(),
        }
    }

    pub fn to_persona(&self) -> Persona {
        Persona {
            name: self.name.clone(),
            prompt: self.prompt.clone(),
            driver: None,
            model: self.model.clone(),
            agent: None,
            listen: self.listen.clone(),
            respond_to: self.respond_to.clone(),
            skills: self.skills.clone(),
            mcps: self.mcps.clone(),
            delegates: self.delegates.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub agent_driver: AgentDriverKind,
    pub models: Models,
    pub repos: HashMap<String, RepoConfig>,
    pub allowed_spaces: Vec<String>,
    pub context_footer: ContextFooter,
    pub auto_compact_at: u32,
    #[serde(default)]
    pub debounce_ms: u32,
    pub personas: Vec<Persona>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub templates: Vec<PersonaTemplate>,
    /// Extra system prompt for the host (Switchboard / Pi) — appended to the built-in host preamble.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_prompt: Option<String>,
    /// Tool groups for the host. `None` = default (coding, switchboard, engram). Empty = every tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_mcps: Option<Vec<String>>,
    /// Skill packs attached to the host.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub host_skills: Vec<String>,
    #[serde(default)]
    pub tunnel: TunnelMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_drive_folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<crate::mcp_client::McpServer>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Models {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsDefaults {
    pub agent_driver: AgentDriverKind,
    pub models: Models,
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
        let mut personas = saved.personas.or(defaults.personas).unwrap_or_default();
        for p in &mut personas {
            p.driver = None;
            p.agent = None;
        }
        let current = Settings {
            agent_driver: AgentDriverKind::Pi,
            models: Models {
                pi: saved.models.as_ref().and_then(|m| m.pi.clone()).or(defaults.models.pi),
            },
            repos: saved.repos.unwrap_or(defaults.repos),
            allowed_spaces: saved.allowed_spaces.unwrap_or(defaults.allowed_spaces),
            context_footer: saved
                .context_footer
                .or(defaults.context_footer)
                .unwrap_or(ContextFooter::Every5),
            auto_compact_at: saved.auto_compact_at.or(defaults.auto_compact_at).unwrap_or(85),
            debounce_ms: saved.debounce_ms.unwrap_or(0),
            personas,
            templates: saved.templates.unwrap_or_default(),
            host_prompt: saved
                .host_prompt
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            host_mcps: saved.host_mcps,
            host_skills: saved.host_skills.unwrap_or_default(),
            tunnel: saved.tunnel.unwrap_or_default(),
            google_drive_folder_id: saved.google_drive_folder_id,
            mcp_servers: saved.mcp_servers.unwrap_or_default(),
        };
        let _ = defaults.agent_driver;
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
        let had_engram = self.inner.lock().unwrap().mcp_servers.iter().any(|m| m.name == crate::mcp_client::ENGRAM_NAME);
        let patched_mcps = patch.mcp_servers.is_some();
        let next = {
            let mut current = self.inner.lock().unwrap().clone();
            current.agent_driver = AgentDriverKind::Pi;
            if let Some(v) = patch.models {
                current.models = Models { pi: v.pi };
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
            if let Some(v) = patch.debounce_ms {
                current.debounce_ms = v.min(30_000);
            }
            if let Some(mut v) = patch.personas {
                for p in &mut v {
                    p.driver = None;
                    p.agent = None;
                }
                current.personas = v;
            }
            if let Some(v) = patch.templates {
                current.templates = v;
            }
            if let Some(v) = patch.host_prompt {
                current.host_prompt = Some(v.trim().to_string()).filter(|s| !s.is_empty());
            }
            if let Some(v) = patch.host_mcps {
                current.host_mcps = Some(v);
            }
            if let Some(v) = patch.host_skills {
                current.host_skills = v;
            }
            if let Some(v) = patch.tunnel {
                current.tunnel = v;
            }
            if let Some(v) = patch.mcp_servers {
                current.mcp_servers = v;
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
        if patched_mcps {
            let has_engram = next.mcp_servers.iter().any(|m| m.name == crate::mcp_client::ENGRAM_NAME);
            if had_engram && !has_engram {
                self.set_engram_declined(true);
            } else if has_engram {
                self.set_engram_declined(false);
            }
        }
        for listener in self.listeners.lock().unwrap().iter() {
            listener(&next);
        }
        Ok(next)
    }

    pub async fn ensure_default_engram(&self) {
        if self.engram_declined() {
            return;
        }
        if self.get().mcp_servers.iter().any(|m| m.name == crate::mcp_client::ENGRAM_NAME) {
            return;
        }
        if !crate::mcp_client::engram_installed().await {
            return;
        }
        let mut servers = self.get().mcp_servers;
        servers.push(crate::mcp_client::default_engram());
        if let Err(err) = self
            .update(SettingsPatch {
                mcp_servers: Some(servers),
                ..Default::default()
            })
            .await
        {
            tracing::warn!("could not enable Engram by default: {err}");
        } else {
            tracing::info!("Engram detected — registered as default MCP server");
        }
    }

    fn engram_declined_path(&self) -> Option<PathBuf> {
        self.file_path.parent().map(|d| d.join("engram.declined"))
    }

    fn engram_declined(&self) -> bool {
        self.engram_declined_path().is_some_and(|p| p.is_file())
    }

    fn set_engram_declined(&self, declined: bool) {
        let Some(path) = self.engram_declined_path() else {
            return;
        };
        if declined {
            let _ = std::fs::write(&path, b"");
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialSettings {
    #[allow(dead_code)]
    agent_driver: Option<AgentDriverKind>,
    models: Option<Models>,
    repos: Option<HashMap<String, RepoConfig>>,
    allowed_spaces: Option<Vec<String>>,
    context_footer: Option<ContextFooter>,
    auto_compact_at: Option<u32>,
    debounce_ms: Option<u32>,
    personas: Option<Vec<Persona>>,
    templates: Option<Vec<PersonaTemplate>>,
    host_prompt: Option<String>,
    host_mcps: Option<Vec<String>>,
    host_skills: Option<Vec<String>>,
    tunnel: Option<TunnelMode>,
    google_drive_folder_id: Option<String>,
    mcp_servers: Option<Vec<crate::mcp_client::McpServer>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub agent_driver: Option<AgentDriverKind>,
    pub models: Option<Models>,
    pub repos: Option<HashMap<String, RepoConfig>>,
    pub allowed_spaces: Option<Vec<String>>,
    pub context_footer: Option<ContextFooter>,
    pub auto_compact_at: Option<u32>,
    pub debounce_ms: Option<u32>,
    pub personas: Option<Vec<Persona>>,
    pub templates: Option<Vec<PersonaTemplate>>,
    pub host_prompt: Option<String>,
    pub host_mcps: Option<Vec<String>>,
    pub host_skills: Option<Vec<String>>,
    pub tunnel: Option<TunnelMode>,
    pub google_drive_folder_id: Option<String>,
    pub mcp_servers: Option<Vec<crate::mcp_client::McpServer>>,
}

fn validate(s: &Settings) -> Result<(), String> {
    if s.host_prompt.as_ref().is_some_and(|p| p.chars().count() > 12_000) {
        return Err("hostPrompt is too long (max 12000 characters)".into());
    }
    let mut seen = std::collections::HashSet::new();
    for m in &s.mcp_servers {
        if !crate::mcp_client::valid_name(&m.name) {
            return Err(format!("MCP server name \"{}\" must be lowercase letters, digits or - and not a built-in name", m.name));
        }
        if m.command.trim().is_empty() {
            return Err(format!("MCP server {} needs a command", m.name));
        }
        if !seen.insert(m.name.clone()) {
            return Err(format!("MCP server {} is listed twice", m.name));
        }
    }
    let repo_name = Regex::new(r"^[a-zA-Z0-9._-]+$").unwrap();
    let persona_name = Regex::new(r"(?i)^[a-z0-9][a-z0-9_-]{0,31}$").unwrap();
    let space_re = Regex::new(r"^spaces/[^/\s]+$").unwrap();
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
    let template_id = Regex::new(r"^[a-z0-9][a-z0-9_-]{0,47}$").unwrap();
    let mut template_ids = std::collections::HashSet::new();
    for t in &s.templates {
        if !template_id.is_match(&t.id) {
            return Err(format!(
                r#"template "{}": id must be lowercase letters, digits, - or _ (max 48)"#,
                t.id
            ));
        }
        if !template_ids.insert(t.id.clone()) {
            return Err(format!("template id \"{}\" is listed twice", t.id));
        }
        if !persona_name.is_match(&t.name) {
            return Err(format!(
                r#"template "{}": suggested name must use letters, digits, - or _ (no spaces, max 32)"#,
                t.id
            ));
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
                agent_driver: AgentDriverKind::Pi,
                allowed_spaces: vec!["spaces/abc".into()],
                ..Default::default()
            },
        );
        assert_eq!(store.get().allowed_spaces, vec!["spaces/abc".to_string()]);
        assert_eq!(store.get().agent_driver, AgentDriverKind::Pi);
        store
            .update(SettingsPatch {
                context_footer: Some(ContextFooter::Never),
                ..Default::default()
            })
            .await
            .unwrap();
        let again = SettingsStore::open(&path, SettingsDefaults::default());
        assert_eq!(again.get().context_footer, ContextFooter::Never);
        assert_eq!(again.get().agent_driver, AgentDriverKind::Pi);
    }

    #[tokio::test]
    async fn removing_engram_opts_out_of_auto_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = SettingsStore::open(&path, SettingsDefaults::default());
        store
            .update(SettingsPatch {
                mcp_servers: Some(vec![crate::mcp_client::default_engram()]),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!dir.path().join("engram.declined").is_file());
        store
            .update(SettingsPatch {
                mcp_servers: Some(vec![]),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(dir.path().join("engram.declined").is_file());
        store.ensure_default_engram().await;
        assert!(store.get().mcp_servers.is_empty());
    }

    #[test]
    fn open_coerces_legacy_driver_and_strips_persona_runtime() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{
              "agentDriver": "opencode",
              "models": { "opencode": "x", "pi": "zai/glm" },
              "agents": { "opencode": "build" },
              "personas": [{ "name": "qa", "prompt": "p", "driver": "claude", "agent": "build" }]
            }"#,
        )
        .unwrap();
        let store = SettingsStore::open(&path, SettingsDefaults::default());
        let s = store.get();
        assert_eq!(s.agent_driver, AgentDriverKind::Pi);
        assert_eq!(s.models.pi.as_deref(), Some("zai/glm"));
        assert!(s.personas[0].driver.is_none());
        assert!(s.personas[0].agent.is_none());
    }

    fn sample_persona(name: &str) -> Persona {
        Persona {
            name: name.into(),
            prompt: "role".into(),
            driver: None,
            model: Some("haiku".into()),
            agent: None,
            listen: Some("all".into()),
            respond_to: Some("people".into()),
            skills: vec!["finanzas".into()],
            mcps: vec!["google-drive".into()],
            delegates: vec!["qa".into()],
        }
    }

    #[test]
    fn templates_serialize_roundtrip() {
        let t = PersonaTemplate::from_persona("tpl-ventas".into(), &sample_persona("ventas"));
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["id"], "tpl-ventas");
        assert_eq!(json["name"], "ventas");
        assert_eq!(json["respondTo"], "people");
        assert_eq!(json["skills"], serde_json::json!(["finanzas"]));
        let back: PersonaTemplate = serde_json::from_value(json).unwrap();
        assert_eq!(back, t);
        assert_eq!(back.to_persona().name, "ventas");
        assert_eq!(back.to_persona().skills, vec!["finanzas"]);
    }

    #[tokio::test]
    async fn templates_persist_and_name_may_match_persona() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = SettingsStore::open(&path, SettingsDefaults::default());
        let persona = sample_persona("ventas");
        let template = PersonaTemplate::from_persona("ventas-pack".into(), &persona);
        store
            .update(SettingsPatch {
                personas: Some(vec![persona.clone()]),
                templates: Some(vec![template.clone()]),
                ..Default::default()
            })
            .await
            .unwrap();
        let again = SettingsStore::open(&path, SettingsDefaults::default());
        assert_eq!(again.get().templates, vec![template]);
        assert_eq!(again.get().personas[0].name, "ventas");
    }

    #[tokio::test]
    async fn templates_reject_duplicate_or_bad_ids() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = SettingsStore::open(&path, SettingsDefaults::default());
        let base = PersonaTemplate::from_persona("ok".into(), &sample_persona("qa"));
        let dup = store
            .update(SettingsPatch {
                templates: Some(vec![base.clone(), PersonaTemplate { id: "ok".into(), ..base.clone() }]),
                ..Default::default()
            })
            .await;
        assert!(dup.unwrap_err().contains("listed twice"));
        let bad = store
            .update(SettingsPatch {
                templates: Some(vec![PersonaTemplate { id: "Bad Id".into(), ..base }]),
                ..Default::default()
            })
            .await;
        assert!(bad.unwrap_err().contains("id must be"));
    }
}
