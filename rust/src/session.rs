use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::atomic::write_atomic;
use crate::config::AgentDriverKind;
use crate::driver::types::{AgentQuestion, ContextUsage};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RoomMember {
    Human {
        id: String,
        name: String,
        #[serde(rename = "joinedAt")]
        joined_at: String,
    },
    Agent {
        id: String,
        persona: String,
        #[serde(rename = "joinedAt")]
        joined_at: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoomEntry {
    pub n: u64,
    pub author: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersonaUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<u64>,
}

pub fn persona_usage_after(prev: Option<&PersonaUsage>, usage: Option<&ContextUsage>, text_len: usize, reply_len: usize) -> PersonaUsage {
    let turns = prev.and_then(|p| p.turns).unwrap_or(0) + 1;
    match usage {
        Some(u) => PersonaUsage {
            context_tokens: Some(u.context_tokens),
            context_window: u.context_window,
            estimated: Some(false),
            turns: Some(turns),
        },
        None => {
            let prev_tokens = prev.filter(|p| p.estimated != Some(false)).and_then(|p| p.context_tokens).unwrap_or(0);
            let add = ((text_len + reply_len).div_ceil(4)) as u64;
            PersonaUsage {
                context_tokens: Some(prev_tokens + add),
                context_window: prev.and_then(|p| p.context_window),
                estimated: Some(true),
                turns: Some(turns),
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
    pub space: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<AgentDriverKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_questions: Option<Vec<AgentQuestion>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_sessions: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_usage: Option<HashMap<String, PersonaUsage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_roster: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_roster: Option<HashMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<Vec<RoomEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_seen: Option<HashMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<RoomMember>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kicked: Option<Vec<String>>,
}

pub struct SessionStore {
    file_path: PathBuf,
    entries: Mutex<HashMap<String, SessionRecord>>,
    writing: AsyncMutex<()>,
}

impl SessionStore {
    pub fn open(file_path: impl AsRef<Path>) -> Self {
        let file_path = file_path.as_ref().to_path_buf();
        let mut entries = HashMap::new();
        if let Ok(raw) = std::fs::read_to_string(&file_path) {
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, SessionRecord>>(&raw) {
                entries = parsed;
            }
        }
        Self {
            file_path,
            entries: Mutex::new(entries),
            writing: AsyncMutex::new(()),
        }
    }

    pub fn all(&self) -> Vec<(String, SessionRecord)> {
        self.entries.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn get(&self, thread_key: &str) -> Option<SessionRecord> {
        self.entries.lock().unwrap().get(thread_key).cloned()
    }

    pub async fn update(&self, thread_key: &str, space: &str, patch: SessionPatch) -> Result<(), String> {
        let mut next = self.get(thread_key).unwrap_or(SessionRecord {
            space: space.to_string(),
            updated_at: String::new(),
            ..Default::default()
        });
        patch.apply(&mut next);
        next.space = space.to_string();
        next.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.set(thread_key, next).await
    }

    pub async fn set(&self, thread_key: &str, record: SessionRecord) -> Result<(), String> {
        {
            let mut entries = self.entries.lock().unwrap();
            entries.insert(thread_key.to_string(), record);
        }
        self.persist().await
    }

    pub async fn delete(&self, thread_key: &str) -> Result<(), String> {
        self.entries.lock().unwrap().remove(thread_key);
        self.persist().await
    }

    async fn persist(&self) -> Result<(), String> {
        let _guard = self.writing.lock().await;
        let snapshot = self.entries.lock().unwrap().clone();
        let body = format!("{}\n", serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?);
        write_atomic(&self.file_path, &body).await.map_err(|e| e.to_string())
    }
}

#[derive(Debug, Default, Clone)]
pub struct SessionPatch {
    pub session_ref: Option<Option<String>>,
    pub repo: Option<Option<String>>,
    pub worktree: Option<Option<String>>,
    pub branch: Option<Option<String>>,
    pub title: Option<Option<String>>,
    pub model: Option<Option<String>>,
    pub driver: Option<Option<AgentDriverKind>>,
    pub work_item_id: Option<Option<i64>>,
    pub summary: Option<Option<String>>,
    pub context_tokens: Option<Option<u64>>,
    pub context_window: Option<Option<u64>>,
    pub estimated: Option<Option<bool>>,
    pub cost_usd: Option<Option<f64>>,
    pub turns: Option<Option<u64>>,
    pub pending_questions: Option<Option<Vec<AgentQuestion>>>,
    pub persona_sessions: Option<Option<HashMap<String, String>>>,
    pub persona_usage: Option<Option<HashMap<String, PersonaUsage>>>,
    pub host_roster: Option<Option<Vec<String>>>,
    pub persona_roster: Option<Option<HashMap<String, Vec<String>>>>,
    pub room: Option<Option<Vec<RoomEntry>>>,
    pub room_seen: Option<Option<HashMap<String, u64>>>,
    pub members: Option<Option<Vec<RoomMember>>>,
    pub kicked: Option<Option<Vec<String>>>,
}

impl SessionPatch {
    fn apply(self, record: &mut SessionRecord) {
        if let Some(v) = self.session_ref {
            record.session_ref = v;
        }
        if let Some(v) = self.repo {
            record.repo = v;
        }
        if let Some(v) = self.worktree {
            record.worktree = v;
        }
        if let Some(v) = self.branch {
            record.branch = v;
        }
        if let Some(v) = self.title {
            record.title = v;
        }
        if let Some(v) = self.model {
            record.model = v;
        }
        if let Some(v) = self.driver {
            record.driver = v;
        }
        if let Some(v) = self.work_item_id {
            record.work_item_id = v;
        }
        if let Some(v) = self.summary {
            record.summary = v;
        }
        if let Some(v) = self.context_tokens {
            record.context_tokens = v;
        }
        if let Some(v) = self.context_window {
            record.context_window = v;
        }
        if let Some(v) = self.estimated {
            record.estimated = v;
        }
        if let Some(v) = self.cost_usd {
            record.cost_usd = v;
        }
        if let Some(v) = self.turns {
            record.turns = v;
        }
        if let Some(v) = self.pending_questions {
            record.pending_questions = v;
        }
        if let Some(v) = self.persona_sessions {
            record.persona_sessions = v;
        }
        if let Some(v) = self.persona_usage {
            record.persona_usage = v;
        }
        if let Some(v) = self.host_roster {
            record.host_roster = v;
        }
        if let Some(v) = self.persona_roster {
            record.persona_roster = v;
        }
        if let Some(v) = self.room {
            record.room = v;
        }
        if let Some(v) = self.room_seen {
            record.room_seen = v;
        }
        if let Some(v) = self.members {
            record.members = v;
        }
        if let Some(v) = self.kicked {
            record.kicked = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::types::ContextUsage;
    use tempfile::tempdir;

    #[test]
    fn persona_usage_tracks_real_and_estimated_tokens() {
        let real = persona_usage_after(None, Some(&ContextUsage { context_tokens: 225, context_window: Some(200_000), cost_usd: None }), 10, 20);
        assert_eq!(real.context_tokens, Some(225));
        assert_eq!(real.context_window, Some(200_000));
        assert_eq!(real.estimated, Some(false));
        assert_eq!(real.turns, Some(1));
        let next = persona_usage_after(Some(&real), None, 40, 40);
        assert_eq!(next.context_tokens, Some(20));
        assert_eq!(next.estimated, Some(true));
        assert_eq!(next.turns, Some(2));
    }

    #[tokio::test]
    async fn atomic_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let store = SessionStore::open(&path);
        store
            .update(
                "spaces/x/threads/y",
                "spaces/x",
                SessionPatch {
                    session_ref: Some(Some("ses_1".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let again = SessionStore::open(&path);
        let rec = again.get("spaces/x/threads/y").unwrap();
        assert_eq!(rec.session_ref.as_deref(), Some("ses_1"));
        assert_eq!(rec.space, "spaces/x");
    }
}
