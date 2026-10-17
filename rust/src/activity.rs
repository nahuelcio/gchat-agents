use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::atomic::write_atomic;

const CAP: usize = 500;
const TEAM_PREFIX: &str = "share/";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub thread_key: String,
    pub title: String,
    pub detail: String,
    pub href: String,
}

pub struct ActivityLog {
    path: PathBuf,
    events: Mutex<VecDeque<ActivityEvent>>,
    writing: AsyncMutex<()>,
}

pub fn href_for(thread_key: &str) -> String {
    if let Some(id) = thread_key.strip_prefix(TEAM_PREFIX) {
        format!("#team/{}", id.split('#').next().unwrap_or(id))
    } else if thread_key.starts_with("schedule/") {
        "#schedules".into()
    } else {
        "#overview".into()
    }
}

impl ActivityLog {
    pub fn open(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let events: VecDeque<ActivityEvent> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { path, events: Mutex::new(events), writing: AsyncMutex::new(()) }
    }

    pub async fn record(&self, kind: &str, thread_key: &str, title: impl Into<String>, detail: impl Into<String>) {
        let event = ActivityEvent {
            id: uuid::Uuid::new_v4().to_string(),
            at: chrono::Utc::now().to_rfc3339(),
            kind: kind.into(),
            thread_key: thread_key.into(),
            title: title.into(),
            detail: detail.into().chars().take(300).collect(),
            href: href_for(thread_key),
        };
        let _guard = self.writing.lock().await;
        let snapshot = {
            let mut events = self.events.lock().unwrap();
            events.push_back(event);
            while events.len() > CAP {
                events.pop_front();
            }
            serde_json::to_string(&*events).unwrap_or_else(|_| "[]".into())
        };
        let _ = write_atomic(&self.path, &snapshot).await;
    }

    pub fn recent(&self, limit: usize, kinds: &[&str]) -> Vec<ActivityEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .filter(|e| kinds.is_empty() || kinds.contains(&e.kind.as_str()))
            .take(limit)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn keeps_the_latest_events_and_filters_by_kind() {
        let dir = tempfile::tempdir().unwrap();
        let log = ActivityLog::open(dir.path().join("activity.json"));
        for i in 0..CAP + 5 {
            log.record(if i % 2 == 0 { "turn_ok" } else { "turn_fail" }, "share/t1", format!("n{i}"), "").await;
        }
        let all = log.recent(1000, &[]);
        assert_eq!(all.len(), CAP);
        assert_eq!(all[0].title, format!("n{}", CAP + 4));
        assert!(log.recent(50, &["turn_fail"]).iter().all(|e| e.kind == "turn_fail"));
        assert_eq!(all[0].href, "#team/t1");
        let reopened = ActivityLog::open(dir.path().join("activity.json"));
        assert_eq!(reopened.recent(1000, &[]).len(), CAP);
    }

    #[test]
    fn links_point_to_the_right_view() {
        assert_eq!(href_for("share/abc#qa"), "#team/abc");
        assert_eq!(href_for("schedule/j1"), "#schedules");
        assert_eq!(href_for("spaces/x/threads/y"), "#overview");
    }
}
