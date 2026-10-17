use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::atomic::write_atomic;
use crate::google::{PostMessageBody, PostThread};
use crate::handler::{HandlerDeps, TEAM_PREFIX};
use crate::session::SessionPatch;
use crate::transcripts::{TranscriptMessage, TranscriptStore};

const CAP: usize = 2000;
pub const CUT_NOTICE: &str = "The previous turn was cut by a restart and was not run again. Send the message again if you still need it.";
pub const EXPIRED_NOTICE: &str = "The open question expired after a restart. Reply with a new message to continue.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    Accepted,
    Running,
    Posted,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnEntry {
    pub request_id: String,
    pub thread_key: String,
    pub space: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<PostThread>,
    pub state: TurnState,
    pub at: String,
}

pub struct TurnLedger {
    path: PathBuf,
    entries: Mutex<Vec<TurnEntry>>,
    writing: AsyncMutex<()>,
}

impl TurnLedger {
    pub fn open(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let entries = std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
        Self { path, entries: Mutex::new(entries), writing: AsyncMutex::new(()) }
    }

    pub async fn begin(&self, request_id: &str, thread_key: &str, space: &str, thread: Option<PostThread>) -> bool {
        {
            let mut entries = self.entries.lock().unwrap();
            if entries.iter().any(|e| e.request_id == request_id) {
                return false;
            }
            entries.push(TurnEntry {
                request_id: request_id.into(),
                thread_key: thread_key.into(),
                space: space.into(),
                thread,
                state: TurnState::Accepted,
                at: chrono::Utc::now().to_rfc3339(),
            });
            let overflow = entries.len().saturating_sub(CAP);
            entries.drain(..overflow);
        }
        self.save().await;
        true
    }

    pub async fn set(&self, request_id: &str, state: TurnState) {
        if let Some(e) = self.entries.lock().unwrap().iter_mut().find(|e| e.request_id == request_id) {
            e.state = state;
            e.at = chrono::Utc::now().to_rfc3339();
        }
        self.save().await;
    }

    pub fn state(&self, request_id: &str) -> Option<TurnState> {
        self.entries.lock().unwrap().iter().find(|e| e.request_id == request_id).map(|e| e.state)
    }

    pub fn running_for(&self, thread_key: &str) -> Option<String> {
        self.entries.lock().unwrap().iter().rev().find(|e| e.thread_key == thread_key && e.state == TurnState::Running).map(|e| e.request_id.clone())
    }

    pub fn unfinished(&self) -> Vec<TurnEntry> {
        self.entries.lock().unwrap().iter().filter(|e| matches!(e.state, TurnState::Accepted | TurnState::Running)).cloned().collect()
    }

    async fn save(&self) {
        let _guard = self.writing.lock().await;
        let body = serde_json::to_string(&*self.entries.lock().unwrap()).unwrap_or_else(|_| "[]".into());
        let _ = write_atomic(&self.path, &body).await;
    }
}

async fn notify(deps: &HandlerDeps, transcripts: &TranscriptStore, thread_key: &str, space: &str, thread: Option<PostThread>, text: &str) {
    if thread_key.starts_with(TEAM_PREFIX) {
        let message = TranscriptMessage { author: crate::personas::BOT_NAME.into(), text: text.into(), bot: true, at: None, questions: None, attachments: None };
        let _ = transcripts.append(thread_key, vec![message]).await;
    } else {
        let mut body = PostMessageBody::text(text);
        body.thread = thread;
        let _ = deps.chat.post_message(space, &body).await;
    }
}

pub async fn recover(deps: &HandlerDeps, ledger: &TurnLedger, transcripts: &TranscriptStore) -> usize {
    let cut = ledger.unfinished();
    for e in &cut {
        ledger.set(&e.request_id, TurnState::Failed).await;
        notify(deps, transcripts, &e.thread_key, &e.space, e.thread.clone(), CUT_NOTICE).await;
        crate::handler::note(deps, "turn_fail", &e.thread_key, "Turn cut by a restart", e.request_id.clone()).await;
    }
    for (key, record) in deps.store.all() {
        if record.pending_questions.as_ref().is_some_and(|q| !q.is_empty()) {
            let _ = deps.store.update(&key, &record.space, SessionPatch { pending_questions: Some(None), ..Default::default() }).await;
            let thread = (!key.starts_with(TEAM_PREFIX)).then(|| PostThread { name: Some(key.clone()), thread_key: None });
            notify(deps, transcripts, &key, &record.space, thread, EXPIRED_NOTICE).await;
        }
    }
    cut.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplicates_are_refused_and_unfinished_turns_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("turns.json");
        let ledger = TurnLedger::open(&path);
        assert!(ledger.begin("m1", "spaces/a/threads/t", "spaces/a", None).await);
        assert!(!ledger.begin("m1", "spaces/a/threads/t", "spaces/a", None).await);
        assert!(ledger.begin("m2", "share/x", "team-chat", None).await);
        ledger.set("m1", TurnState::Running).await;
        ledger.set("m2", TurnState::Posted).await;
        let reopened = TurnLedger::open(&path);
        assert_eq!(reopened.unfinished().iter().map(|e| e.request_id.as_str()).collect::<Vec<_>>(), vec!["m1"]);
        assert!(!reopened.begin("m2", "share/x", "team-chat", None).await);
    }
}
