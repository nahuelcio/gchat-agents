use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
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
                prompt: String::new(),
                persona: None,
            });
            let overflow = entries.len().saturating_sub(CAP);
            entries.drain(..overflow);
        }
        self.save().await;
        true
    }

    pub async fn remember_prompt(&self, request_id: &str, prompt: &str) {
        if let Some(e) = self.entries.lock().unwrap().iter_mut().find(|e| e.request_id == request_id) {
            e.prompt = prompt.to_string();
        }
        self.save().await;
    }

    pub async fn begin_persona(&self, request_id: &str, base: &str, persona: &str, space: &str, thread: Option<PostThread>, prompt: &str) {
        if self.begin(request_id, base, space, thread).await {
            if let Some(e) = self.entries.lock().unwrap().iter_mut().find(|e| e.request_id == request_id) {
                e.persona = Some(persona.to_string());
                e.prompt = prompt.to_string();
                e.state = TurnState::Running;
            }
            self.save().await;
        }
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

async fn resume_on_pi(deps: Arc<HandlerDeps>, ledger: Arc<TurnLedger>, transcripts: Arc<TranscriptStore>, e: TurnEntry) {
    let pi = crate::driver::PiDriver {
        base_url: format!("http://127.0.0.1:{}", crate::pi_sidecar::port()),
        model: None,
        settings: None,
        timeout_ms: 0,
        retry_ms: 0,
    };
    let record = deps.store.get(&e.thread_key);
    let key = match &e.persona {
        Some(p) => format!("{}#{p}", e.thread_key),
        None => e.thread_key.clone(),
    };
    let session = match &e.persona {
        Some(p) => record.as_ref().and_then(|r| r.persona_sessions.as_ref()).and_then(|m| m.get(p).cloned()),
        None => record.as_ref().and_then(|r| r.session_ref.clone()),
    };
    let outcome = match pi.wait(&e.request_id).await {
        Ok(Some(out)) => Ok(Some(out)),
        Ok(None) if !e.prompt.trim().is_empty() => deps
            .driver
            .run_turn(crate::driver::types::AgentTurnInput {
                thread_key: key.clone(),
                session_ref: session,
                text: e.prompt.clone(),
                workdir: record.as_ref().and_then(|r| r.worktree.clone()).unwrap_or_else(|| deps.config.lock().unwrap().workdir.clone()),
                model: None,
                agent: None,
                driver: Some(crate::config::AgentDriverKind::Pi),
                answer_questions: false,
                request_id: Some(e.request_id.clone()),
                mcps_override: None,
                instructions_override: None,
            })
            .await
            .map(Some),
        Ok(None) => Ok(None),
        Err(err) => Err(err),
    };
    match outcome {
        Ok(Some(out)) => {
            let patch = match &e.persona {
                Some(p) => {
                    let mut sessions = record.as_ref().and_then(|r| r.persona_sessions.clone()).unwrap_or_default();
                    if let Some(session) = out.session_ref.clone() {
                        sessions.insert(p.clone(), session);
                    }
                    let mut usage = record.as_ref().and_then(|r| r.persona_usage.clone()).unwrap_or_default();
                    let prev = usage.get(p).cloned();
                    usage.insert(
                        p.clone(),
                        crate::session::persona_usage_after(prev.as_ref(), out.usage.as_ref(), e.prompt.len(), out.reply.len()),
                    );
                    SessionPatch {
                        persona_sessions: Some(if sessions.is_empty() { None } else { Some(sessions) }),
                        persona_usage: Some(Some(usage)),
                        ..Default::default()
                    }
                }
                None => {
                    let (context_tokens, context_window, estimated) = match &out.usage {
                        Some(u) => (Some(Some(u.context_tokens)), u.context_window.map(Some), Some(Some(false))),
                        None => (None, None, None),
                    };
                    SessionPatch {
                        session_ref: out.session_ref.clone().map(Some),
                        context_tokens,
                        context_window,
                        estimated,
                        cost_usd: out.usage.as_ref().and_then(|u| u.cost_usd).map(Some),
                        ..Default::default()
                    }
                }
            };
            let _ = deps.store.update(&e.thread_key, &e.space, patch).await;
            let text = match &e.persona {
                Some(p) => format!("*@{p}*\n{}", out.reply),
                None => out.reply.clone(),
            };
            notify(&deps, &transcripts, &e.thread_key, &e.space, e.thread.clone(), &text).await;
            ledger.set(&e.request_id, TurnState::Posted).await;
            crate::handler::note(&deps, "turn_ok", &e.thread_key, "Turn resumed after a restart", e.request_id.clone()).await;
        }
        Ok(None) | Err(_) => {
            ledger.set(&e.request_id, TurnState::Failed).await;
            notify(&deps, &transcripts, &e.thread_key, &e.space, e.thread.clone(), CUT_NOTICE).await;
            crate::handler::note(&deps, "turn_fail", &e.thread_key, "Turn could not resume", e.request_id.clone()).await;
        }
    }
}

pub async fn recover(deps: Arc<HandlerDeps>, ledger: Arc<TurnLedger>, transcripts: Arc<TranscriptStore>) -> usize {
    let cut = ledger.unfinished();
    for e in &cut {
        ledger.set(&e.request_id, TurnState::Running).await;
        tokio::spawn(resume_on_pi(deps.clone(), ledger.clone(), transcripts.clone(), e.clone()));
    }
    let deps = &*deps;
    let transcripts = &*transcripts;
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
