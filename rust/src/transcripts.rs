use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::atomic::write_atomic;
use crate::driver::types::AgentQuestion;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MessageAttachment {
    pub id: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptMessage {
    pub author: String,
    pub text: String,
    pub bot: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<AgentQuestion>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSummary {
    pub key: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub count: usize,
}

pub struct TranscriptStore {
    dir: PathBuf,
    max: usize,
    cache: Mutex<HashMap<String, Vec<TranscriptMessage>>>,
    archived: Mutex<HashSet<String>>,
    writing: AsyncMutex<()>,
}

impl TranscriptStore {
    pub fn open(dir: impl AsRef<Path>, max: usize) -> Self {
        let dir = dir.as_ref().to_path_buf();
        let _ = std::fs::create_dir_all(&dir);
        let archived = load_archived(&dir.join(".archived"));
        Self {
            dir,
            max,
            cache: Mutex::new(HashMap::new()),
            archived: Mutex::new(archived),
            writing: AsyncMutex::new(()),
        }
    }

    pub fn file_for(&self, thread_key: &str) -> PathBuf {
        let safe: String = thread_key
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        self.dir.join(format!("{safe}.json"))
    }

    pub fn get(&self, thread_key: &str) -> Vec<TranscriptMessage> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(m) = cache.get(thread_key) {
            return m.clone();
        }
        let messages: Vec<TranscriptMessage> = std::fs::read_to_string(self.file_for(thread_key))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        cache.insert(thread_key.to_string(), messages.clone());
        messages
    }

    pub fn list(&self, prefix: &str, archived: bool) -> Vec<TranscriptSummary> {
        let file_prefix: String = prefix
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let archived_set = self.archived.lock().unwrap().clone();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(&file_prefix) || !name.ends_with(".json") {
                continue;
            }
            let key = format!("{prefix}{}", &name[file_prefix.len()..name.len() - 5]);
            if archived_set.contains(&key) != archived {
                continue;
            }
            let messages = self.get(&key);
            let title = messages
                .iter()
                .find(|m| !m.bot)
                .map(|m| m.text.chars().take(60).collect())
                .unwrap_or_else(|| "New thread".into());
            out.push(TranscriptSummary {
                key,
                title,
                updated_at: messages.last().and_then(|m| m.at.clone()),
                count: messages.len(),
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    pub async fn append(&self, thread_key: &str, messages: Vec<TranscriptMessage>) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let next = {
            let mut current = self.get(thread_key);
            for mut m in messages {
                if m.at.is_none() {
                    m.at = Some(now.clone());
                }
                current.push(m);
            }
            if current.len() > self.max {
                let drop_n = current.len() - self.max;
                current.drain(0..drop_n);
            }
            current
        };
        self.cache.lock().unwrap().insert(thread_key.to_string(), next.clone());
        let _guard = self.writing.lock().await;
        let body = serde_json::to_string(&next).map_err(|e| e.to_string())?;
        write_atomic(&self.file_for(thread_key), &body).await.map_err(|e| e.to_string())
    }

    pub async fn archive(&self, thread_key: &str, archived: bool) -> Result<(), String> {
        {
            let mut set = self.archived.lock().unwrap();
            if archived {
                set.insert(thread_key.to_string());
            } else {
                set.remove(thread_key);
            }
            save_archived(&self.dir.join(".archived"), &set)?;
        }
        Ok(())
    }

    pub async fn remove(&self, thread_key: &str) -> Result<(), String> {
        self.cache.lock().unwrap().remove(thread_key);
        self.archived.lock().unwrap().remove(thread_key);
        let _ = tokio::fs::remove_file(self.file_for(thread_key)).await;
        Ok(())
    }
}

fn load_archived(path: &Path) -> HashSet<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_archived(path: &Path, set: &HashSet<String>) -> Result<(), String> {
    let body = serde_json::to_string(set).map_err(|e| e.to_string())?;
    write_atomic_sync_path(path, &body)
}

fn write_atomic_sync_path(path: &Path, body: &str) -> Result<(), String> {
    crate::atomic::write_atomic_sync(path, body).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn append_and_list() {
        let dir = tempdir().unwrap();
        let store = TranscriptStore::open(dir.path(), 100);
        store
            .append(
                "share/t1",
                vec![TranscriptMessage {
                    author: "a".into(),
                    text: "hello".into(),
                    bot: false,
                    at: None,
                    questions: None,
                    attachments: None,
                }],
            )
            .await
            .unwrap();
        assert_eq!(store.get("share/t1").len(), 1);
        let list = store.list("share/", false);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].count, 1);
    }
}
