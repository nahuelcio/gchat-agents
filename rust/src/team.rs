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
    pub runs: Vec<AgentRun>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub id: String,
    pub name: String,
    pub status: &'static str,
    pub last_seen_n: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub name: String,
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
}

fn driver_name(_driver: crate::config::AgentDriverKind) -> &'static str {
    "pi"
}

fn model_for(explicit: Option<&str>, _driver: crate::config::AgentDriverKind, models: &crate::settings::Models) -> Option<String> {
    explicit.filter(|s| !s.is_empty()).map(str::to_string).or_else(|| models.pi.clone())
}

pub fn agent_runs(record: &crate::session::SessionRecord, options: &crate::handler::TurnOptions) -> Vec<AgentRun> {
    let mut runs = Vec::new();
    let host_driver = record.driver.unwrap_or(options.default_driver);
    let host_active = record.session_ref.is_some() || record.turns.is_some() || record.driver.is_some() || record.context_tokens.is_some();
    if host_active {
        runs.push(AgentRun {
            name: driver_name(host_driver).into(),
            role: "host",
            driver: Some(driver_name(host_driver).into()),
            model: model_for(record.model.as_deref(), host_driver, &options.default_models),
            session: record.session_ref.clone(),
            context_tokens: record.context_tokens,
            context_window: record.context_window,
            turns: record.turns,
            estimated: record.estimated,
        });
    }
    let mut personas: Vec<_> = record.persona_sessions.as_ref().map(|m| m.iter().collect()).unwrap_or_default();
    personas.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    for (name, session) in personas {
        let persona = options.personas.iter().find(|p| p.name.eq_ignore_ascii_case(name));
        let driver = persona.and_then(|p| p.driver).or(record.driver).unwrap_or(options.default_driver);
        let explicit = persona.and_then(|p| p.model.as_deref()).or_else(|| {
            if persona.and_then(|p| p.driver).is_none() { record.model.as_deref() } else { None }
        });
        runs.push(AgentRun {
            name: name.clone(),
            role: "agent",
            driver: Some(driver_name(driver).into()),
            model: model_for(explicit, driver, &options.default_models),
            session: Some(session.clone()),
            context_tokens: None,
            context_window: None,
            turns: None,
            estimated: None,
        });
    }
    runs
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

pub const GUEST_COMMANDS: &[&str] = &["help", "context", "compact", "clear", "model"];
pub const UPLOAD_LIMIT: usize = 25 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 5;
const MAX_ATTACHMENT_BYTES: usize = 3_500_000;

pub async fn save_attachments(deps: &HandlerDeps, inputs: &[TeamAttachmentInput]) -> Result<(Vec<crate::transcripts::MessageAttachment>, Vec<String>), String> {
    if inputs.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let media = deps.media.as_ref().ok_or("media store unavailable")?;
    if inputs.len() > MAX_ATTACHMENTS {
        return Err(format!("at most {MAX_ATTACHMENTS} attachments"));
    }
    let (mut stored, mut lines) = (Vec::new(), Vec::new());
    for raw in inputs {
        if !raw.content_type.trim().starts_with("image/") {
            return Err("only image attachments are supported".into());
        }
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, raw.data.trim()).map_err(|_| "invalid attachment data".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(format!("each image must be between 1 byte and {MAX_ATTACHMENT_BYTES} bytes"));
        }
        let name = raw.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
        let saved = media.save(&bytes, raw.content_type.trim(), name).await?;
        stored.push(crate::media::to_message_attachment(&saved));
        lines.push(crate::media::attachment_prompt_line(&saved));
    }
    Ok((stored, lines))
}

pub async fn team_send(
    deps: Arc<HandlerDeps>,
    transcripts: Arc<TranscriptStore>,
    thread: &str,
    text: &str,
    name: &str,
    allowed_commands: Option<&[&str]>,
    attachments: &[TeamAttachmentInput],
) -> Result<serde_json::Value, String> {
    if !thread_id_ok(thread) {
        return Err("bad thread id".into());
    }
    let text = text.trim();
    if text.is_empty() && attachments.is_empty() {
        return Err("thread and text or an image are required".into());
    }
    if let (Some(allowed), Some(cmd)) = (allowed_commands, text.strip_prefix('/')) {
        let cmd = cmd.split_whitespace().next().unwrap_or("");
        if !allowed.contains(&cmd) {
            return Err(format!("/{cmd} is not available on the shared link"));
        }
    }
    let thread_key = format!("{TEAM_PREFIX}{thread}");
    let (stored, lines) = save_attachments(&deps, attachments).await?;
    let prompt_text = std::iter::once(text.to_string()).chain(lines).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n\n");
    transcripts
        .append(
            &thread_key,
            vec![TranscriptMessage {
                author: name.to_string(),
                text: if text.is_empty() { "(image)".into() } else { text.to_string() },
                bot: false,
                at: None,
                questions: None,
                attachments: Some(stored).filter(|s| !s.is_empty()),
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
    let prompt = prompt_text;
    let sender = name.to_string();
    let request_id = uuid::Uuid::new_v4().to_string();
    if let Some(ledger) = &deps.ledger {
        ledger.begin(&request_id, &thread_key2, "team-chat", None).await;
        ledger.remember_prompt(&request_id, &format!("{name}: {prompt}")).await;
    }
    tokio::spawn(async move {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let deps3 = deps2.clone();
        let request = TurnRequest {
            thread_key: thread_key2.clone(),
            space_name: "team-chat".into(),
            text: prompt,
            sender: Some(sender),
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: Some(captured.clone()),
            request_id: Some(request_id.clone()),
        };
        let Some(request) = crate::handler::debounce(&deps3, request).await else { return };
        let result = crate::handler::tracked(&deps3, Some(&request_id), process_message(request, deps2)).await;
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
    let agent = record.as_ref().and_then(|r| r.driver.map(|_| "pi".into()));
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
        runs: record.as_ref().map(|r| agent_runs(r, &options)).unwrap_or_default(),
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

    #[test]
    fn runs_list_the_host_and_each_persona_session() {
        use crate::config::AgentDriverKind;
        use crate::session::SessionRecord;
        use crate::settings::{Models, Persona};

        let record = SessionRecord {
            session_ref: Some("ses_eb824e33cffeFvucvJEhbMQBqd".into()),
            driver: Some(AgentDriverKind::Pi),
            context_tokens: Some(1301),
            context_window: Some(128_000),
            turns: Some(4),
            persona_sessions: Some(std::collections::HashMap::from([("architect".into(), "ses_eb8240236ffe9MtMpfyzlBVgko".into())])),
            ..Default::default()
        };
        let options = crate::handler::TurnOptions {
            context_footer: crate::settings::ContextFooter::Never,
            auto_compact_at: 0,
            debounce_ms: 0,
            default_model: Some("zai/glm-5.3-flash".into()),
            default_driver: AgentDriverKind::Pi,
            default_models: Models { pi: Some("zai/glm-5.3-flash".into()), ..Default::default() },
            personas: vec![Persona {
                name: "architect".into(),
                prompt: "a".into(),
                driver: None,
                model: Some("opus".into()),
                agent: None,
                listen: None,
                respond_to: None,
                skills: vec![],
                mcps: vec![],
                delegates: vec![],
            }],
        };
        let runs = agent_runs(&record, &options);
        assert_eq!(runs[0].name, "pi");
        assert_eq!(runs[0].role, "host");
        assert_eq!(runs[0].model.as_deref(), Some("zai/glm-5.3-flash"));
        assert_eq!(runs[0].context_tokens, Some(1301));
        assert_eq!(runs[0].context_window, Some(128_000));
        assert_eq!(runs[1].name, "architect");
        assert_eq!(runs[1].driver.as_deref(), Some("pi"));
        assert_eq!(runs[1].model.as_deref(), Some("opus"));
        assert_eq!(runs[1].session.as_deref(), Some("ses_eb8240236ffe9MtMpfyzlBVgko"));
        assert!(runs[1].context_tokens.is_none());
    }
}
