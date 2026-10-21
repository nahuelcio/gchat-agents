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
    #[serde(rename = "replyTo", default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Quote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Quote {
    pub author: String,
    pub text: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub thread_key: String,
    pub title: String,
    pub author: String,
    pub at: Option<String>,
    pub snippet: String,
    pub href: String,
}

fn snippet(text: &str, needle: &[char]) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let at = lower.windows(needle.len()).position(|w| w == needle)?;
    let start = at.saturating_sub(40);
    let end = (at + needle.len() + 40).min(chars.len());
    let body: String = chars[start..end].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!("{}{body}{}", if start > 0 { "…" } else { "" }, if end < chars.len() { "…" } else { "" }))
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
        self.with(thread_key, |m| m.to_vec())
    }

    fn with<R>(&self, thread_key: &str, f: impl FnOnce(&[TranscriptMessage]) -> R) -> R {
        let mut cache = self.cache.lock().unwrap();
        let messages = cache.entry(thread_key.to_string()).or_insert_with(|| {
            std::fs::read_to_string(self.file_for(thread_key))
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default()
        });
        f(messages)
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
            let (title, updated_at, count) = self.with(&key, |messages| {
                (
                    messages
                        .iter()
                        .find(|m| !m.bot)
                        .map(|m| m.text.chars().take(60).collect())
                        .unwrap_or_else(|| "New thread".into()),
                    messages.last().and_then(|m| m.at.clone()),
                    messages.len(),
                )
            });
            out.push(TranscriptSummary { key, title, updated_at, count });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let needle: Vec<char> = query.to_lowercase().chars().collect();
        let mut hits = Vec::new();
        let threads = ["share/", "schedule/"]
            .iter()
            .flat_map(|p| [self.list(p, false), self.list(p, true)])
            .flatten()
            .take(200);
        for t in threads {
            for m in self.get(&t.key).iter().rev() {
                let Some(snippet) = snippet(&format!("{}: {}", m.author, m.text), &needle) else { continue };
                hits.push(SearchHit {
                    href: crate::activity::href_for(&t.key),
                    thread_key: t.key.clone(),
                    title: t.title.clone(),
                    author: m.author.clone(),
                    at: m.at.clone(),
                    snippet,
                });
                if hits.len() >= limit {
                    return hits;
                }
            }
        }
        hits
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
                    reply_to: None,
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

#[cfg(test)]
mod search_tests {
    use super::*;

    fn msg(author: &str, text: &str) -> TranscriptMessage {
        TranscriptMessage { author: author.into(), text: text.into(), bot: false, at: None, questions: None, attachments: None, reply_to: None }
    }

    #[tokio::test]
    async fn finds_the_right_thread_with_a_snippet() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::open(dir.path(), 100);
        store.append("share/uno", vec![msg("Ana", "el token de Meta vence hoy"), msg("Beto", "ok")]).await.unwrap();
        store.append("share/dos", vec![msg("Lucia", "revisemos el webhook de WhatsApp")]).await.unwrap();
        let hits = store.search("TOKEN de meta", 30);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thread_key, "share/uno");
        assert_eq!(hits[0].href, "#team/uno");
        assert!(hits[0].snippet.contains("token de Meta"));
        assert!(store.search("inexistente", 30).is_empty());
    }

    #[test]
    fn snippet_trims_long_text() {
        let long = format!("{}aguja{}", "a".repeat(100), "b".repeat(100));
        let s = snippet(&long, &"aguja".chars().collect::<Vec<_>>()).unwrap();
        assert!(s.starts_with('…') && s.ends_with('…') && s.contains("aguja"));
        assert!(s.chars().count() < 100);
    }
}
