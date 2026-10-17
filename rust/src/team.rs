use std::sync::Arc;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::handler::{process_message, HandlerDeps, TurnRequest, TEAM_PREFIX};
use crate::personas::{with_agent, with_human, BOT_NAME};
use crate::session::{RoomMember, SessionPatch};
use crate::transcripts::{TranscriptMessage, TranscriptStore};

pub fn thread_id_ok(id: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_-]{1,64}$").unwrap().is_match(id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamAttachmentInput {
    pub content_type: String,
    pub data: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamThreadState {
    pub messages: Vec<TranscriptMessage>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub title: Option<String>,
    pub worktree: Option<String>,
    pub context: Option<String>,
    pub app: AppState,
    pub work_item: Option<serde_json::Value>,
    pub changes: Option<crate::workspace::GitChangeSummary>,
    pub busy: bool,
    pub members: Option<Vec<RoomMember>>,
    pub kicked: Vec<String>,
    pub answering: Vec<String>,
    pub presence: Vec<Presence>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub id: String,
    pub name: String,
    pub status: &'static str,
    pub last_seen_n: Option<u64>,
}

pub fn presence(members: &[RoomMember], speaking: &[String], waiting: bool, seen: Option<&std::collections::HashMap<String, u64>>) -> Vec<Presence> {
    let seen_by = |who: &str| seen.and_then(|m| m.get(who).copied());
    let status = |who: &str, waits: bool| match () {
        _ if speaking.iter().any(|s| s == who) => "speaking",
        _ if waits => "waiting",
        _ => "idle",
    };
    let host = crate::handler::BOT_NAME;
    let mut out = vec![Presence { id: "host".into(), name: host.into(), status: status(host, waiting), last_seen_n: seen_by(host) }];
    for m in members {
        out.push(match m {
            RoomMember::Agent { id, persona, .. } => {
                let who = format!("@{persona}");
                Presence { id: id.clone(), status: status(&who, false), last_seen_n: seen_by(&who), name: who }
            }
            RoomMember::Human { id, name, .. } => Presence { id: id.clone(), name: name.clone(), status: "idle", last_seen_n: None },
        });
    }
    out
}

#[derive(Debug, Serialize)]
pub struct AppState {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

pub const GUEST_COMMANDS: &[&str] = &["help", "context", "compact", "clear", "model", "agent"];

pub async fn team_send(
    deps: Arc<HandlerDeps>,
    transcripts: Arc<TranscriptStore>,
    thread: &str,
    text: &str,
    name: &str,
    allowed_commands: Option<&[&str]>,
) -> Result<serde_json::Value, String> {
    if !thread_id_ok(thread) {
        return Err("bad thread id".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("thread and text or an image are required".into());
    }
    if let (Some(allowed), Some(cmd)) = (allowed_commands, text.strip_prefix('/')) {
        let cmd = cmd.split_whitespace().next().unwrap_or("");
        if !allowed.contains(&cmd) {
            return Err(format!("/{cmd} is not available on the shared link"));
        }
    }
    let thread_key = format!("{TEAM_PREFIX}{thread}");
    transcripts
        .append(
            &thread_key,
            vec![TranscriptMessage {
                author: name.to_string(),
                text: text.to_string(),
                bot: false,
                at: None,
                questions: None,
                attachments: None,
            }],
        )
        .await?;
    let record = deps.store.get(&thread_key);
    if record.as_ref().map(|r| r.members.is_some()).unwrap_or(true) {
        let members = with_human(&record.and_then(|r| r.members).unwrap_or_default(), name);
        let _ = deps
            .store
            .update(
                &thread_key,
                "team-chat",
                SessionPatch {
                    members: Some(Some(members)),
                    ..Default::default()
                },
            )
            .await;
    }

    let deps2 = deps.clone();
    let transcripts2 = transcripts.clone();
    let thread_key2 = thread_key;
    let prompt = text.to_string();
    let sender = name.to_string();
    tokio::spawn(async move {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let result = process_message(
            TurnRequest {
                thread_key: thread_key2.clone(),
                space_name: "team-chat".into(),
                text: prompt,
                sender: Some(sender),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
            },
            deps2,
        )
        .await;
        match result {
            Ok(_) => {
                let replies = captured.lock().await.clone();
                for reply in replies {
                    let _ = transcripts2
                        .append(
                            &thread_key2,
                            vec![TranscriptMessage {
                                author: BOT_NAME.into(),
                                text: reply,
                                bot: true,
                                at: None,
                                questions: None,
                                attachments: None,
                            }],
                        )
                        .await;
                }
            }
            Err(err) => tracing::error!(%err, "team turn failed"),
        }
    });

    Ok(serde_json::json!({ "ok": true, "replies": [] }))
}

pub async fn team_members(
    deps: Arc<HandlerDeps>,
    thread: &str,
    op: &str,
    member: TeamMemberInput,
) -> Result<Vec<RoomMember>, String> {
    if !thread_id_ok(thread) {
        return Err("bad thread id".into());
    }
    if op != "add" && op != "remove" {
        return Err("op must be \"add\" or \"remove\"".into());
    }
    apply_member_op(&deps, &format!("{TEAM_PREFIX}{thread}"), op, member).await
}

pub fn effective_members(record: Option<&crate::session::SessionRecord>, catalog: &[crate::settings::Persona]) -> Vec<RoomMember> {
    record.and_then(|r| r.members.clone()).unwrap_or_else(|| {
        if record.is_some() {
            catalog.iter().fold(Vec::new(), |m, p| with_agent(&m, &p.name))
        } else {
            Vec::new()
        }
    })
}

pub async fn apply_member_op(deps: &HandlerDeps, thread_key: &str, op: &str, member: TeamMemberInput) -> Result<Vec<RoomMember>, String> {
    let thread_key = thread_key.to_string();
    let catalog = (deps.options)().personas;
    let record = deps.store.get(&thread_key);
    let mut members = effective_members(record.as_ref(), &catalog);
    let label = match &member {
        TeamMemberInput::Agent { persona } => format!("@{}", persona.trim_start_matches('@')),
        TeamMemberInput::Human { name } => name.trim().to_string(),
    };
    match member {
        TeamMemberInput::Agent { persona } => {
            let persona_name = persona.trim_start_matches('@');
            let found = catalog
                .iter()
                .find(|p| p.name.eq_ignore_ascii_case(persona_name))
                .ok_or_else(|| {
                    format!("no agent @{persona_name} in Settings › Agents in chat")
                })?;
            let id = format!("agent:{}", found.name.to_lowercase());
            members = if op == "add" {
                with_agent(&members, &found.name)
            } else {
                members.into_iter().filter(|m| match m {
                    RoomMember::Agent { id: mid, .. } => mid != &id,
                    _ => true,
                }).collect()
            };
            let kicked = record
                .as_ref()
                .and_then(|r| r.kicked.clone())
                .unwrap_or_default()
                .into_iter()
                .filter(|n| !n.eq_ignore_ascii_case(&found.name))
                .collect::<Vec<_>>();
            let kicked = if op == "remove" {
                let mut k = kicked;
                k.push(found.name.clone());
                k
            } else {
                kicked
            };
            deps.store
                .update(
                    &thread_key,
                    record.as_ref().map(|r| r.space.as_str()).unwrap_or("team-chat"),
                    SessionPatch {
                        kicked: Some(Some(kicked)),
                        ..Default::default()
                    },
                )
                .await?;
        }
        TeamMemberInput::Human { name } => {
            let id = format!("human:{}", name.trim().to_lowercase());
            members = if op == "add" {
                with_human(&members, &name)
            } else {
                members.into_iter().filter(|m| match m {
                    RoomMember::Human { id: mid, .. } => mid != &id,
                    _ => true,
                }).collect()
            };
        }
    }
    deps.store
        .update(
            &thread_key,
            record.as_ref().map(|r| r.space.as_str()).unwrap_or("team-chat"),
            SessionPatch {
                members: Some(Some(members.clone())),
                ..Default::default()
            },
        )
        .await?;
    let kind = if op == "add" { "member_add" } else { "member_remove" };
    crate::handler::note(deps, kind, &thread_key, label, "").await;
    Ok(members)
}

#[derive(Debug)]
pub enum TeamMemberInput {
    Agent { persona: String },
    Human { name: String },
}

pub async fn team_thread(
    deps: Arc<HandlerDeps>,
    transcripts: Arc<TranscriptStore>,
    thread: &str,
) -> Result<TeamThreadState, String> {
    if !thread_id_ok(thread) {
        return Err("bad thread id".into());
    }
    let thread_key = format!("{TEAM_PREFIX}{thread}");
    let record = deps.store.get(&thread_key);
    let options = (deps.options)();
    let slug = crate::workspace::slug_for(&thread_key);
    let talking = crate::handler::speaking(&thread_key);
    let ws = deps.workspaces.as_ref();
    let changes = if let (Some(ws), Some(wt)) = (ws, record.as_ref().and_then(|r| r.worktree.as_deref())) {
        ws.changes_in(wt).await
    } else {
        None
    };
    let agent = record.as_ref().and_then(|r| {
        r.driver.map(|d| match d {
            crate::config::AgentDriverKind::Opencode => "opencode".into(),
            crate::config::AgentDriverKind::Claude => "claude".into(),
        })
    });
    Ok(TeamThreadState {
        messages: transcripts.get(&thread_key),
        agent,
        model: record.as_ref().and_then(|r| r.model.clone()),
        repo: record.as_ref().and_then(|r| r.repo.clone()),
        branch: record.as_ref().and_then(|r| r.branch.clone()),
        title: record.as_ref().and_then(|r| r.title.clone()),
        worktree: record.as_ref().and_then(|r| r.worktree.clone()),
        context: record
            .as_ref()
            .map(|r| crate::handler::context_line(r, &options).trim_start_matches('\n').to_string()),
        app: AppState {
            running: ws.map(|w| w.is_up(&slug)).unwrap_or(false),
            port: ws.and_then(|w| w.port(&slug)),
        },
        work_item: record
            .as_ref()
            .and_then(|r| r.work_item_id.map(|id| serde_json::json!({ "id": id }))),
        changes,
        busy: deps.queue.busy(&thread_key).await,
        members: record.as_ref().and_then(|r| r.members.clone()),
        kicked: record.as_ref().and_then(|r| r.kicked.clone()).unwrap_or_default(),
        answering: talking.iter().filter_map(|w| w.strip_prefix('@')).map(String::from).collect(),
        presence: presence(
            &effective_members(record.as_ref(), &options.personas),
            &talking,
            record.as_ref().and_then(|r| r.pending_questions.as_ref()).is_some_and(|q| !q.is_empty()),
            record.as_ref().and_then(|r| r.room_seen.as_ref()),
        ),
    })
}

pub async fn team_delete(
    deps: Arc<HandlerDeps>,
    transcripts: Arc<TranscriptStore>,
    thread: &str,
) -> Result<serde_json::Value, String> {
    let thread_key = format!("{TEAM_PREFIX}{thread}");
    if let Some(record) = deps.store.get(&thread_key) {
        if let (Some(ws), Some(wt)) = (deps.workspaces.as_ref(), record.worktree.as_deref()) {
            let slug = crate::workspace::slug_for(&thread_key);
            ws.down(&slug);
            let _ = ws.remove_thread(wt).await;
            deps.store.delete(&thread_key).await?;
            transcripts.remove(&thread_key).await?;
            return Ok(serde_json::json!({ "ok": true, "branchKept": record.branch }));
        }
    }
    deps.store.delete(&thread_key).await?;
    transcripts.remove(&thread_key).await?;
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod presence_tests {
    use super::*;

    #[test]
    fn derives_speaking_waiting_idle_and_seen() {
        let members = vec![
            RoomMember::Agent { id: "agent:qa".into(), persona: "qa".into(), joined_at: "x".into() },
            RoomMember::Agent { id: "agent:dev".into(), persona: "dev".into(), joined_at: "x".into() },
            RoomMember::Human { id: "human:ana".into(), name: "Ana".into(), joined_at: "x".into() },
        ];
        let seen = std::collections::HashMap::from([("@qa".to_string(), 7u64), (crate::handler::BOT_NAME.to_string(), 9u64)]);
        let p = presence(&members, &["@qa".to_string()], true, Some(&seen));
        let by = |n: &str| p.iter().find(|x| x.name == n).unwrap();
        assert_eq!(by(crate::handler::BOT_NAME).status, "waiting");
        assert_eq!(by(crate::handler::BOT_NAME).last_seen_n, Some(9));
        assert_eq!(by("@qa").status, "speaking");
        assert_eq!(by("@qa").last_seen_n, Some(7));
        assert_eq!(by("@dev").status, "idle");
        assert_eq!(by("Ana").status, "idle");
    }
}
