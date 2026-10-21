use std::sync::Arc;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::handler::{process_message, HandlerDeps, TurnRequest, TEAM_PREFIX};
use crate::personas::{with_agent, with_human, BOT_NAME};
use crate::session::{RoomMember, SessionPatch};
use crate::transcripts::{Quote, TranscriptMessage, TranscriptStore};

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
    pub upcoming: Vec<String>,
    pub presence: Vec<Presence>,
    pub runs: Vec<AgentRun>,
    pub debounce: Option<Debounce>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Debounce {
    pub count: usize,
    pub ms_left: u64,
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
        let usage = record.persona_usage.as_ref().and_then(|m| m.get(name.as_str()));
        runs.push(AgentRun {
            name: name.clone(),
            role: "agent",
            driver: Some(driver_name(driver).into()),
            model: model_for(explicit, driver, &options.default_models),
            session: Some(session.clone()),
            context_tokens: usage.and_then(|u| u.context_tokens),
            context_window: usage.and_then(|u| u.context_window),
            turns: usage.and_then(|u| u.turns),
            estimated: usage.and_then(|u| u.estimated),
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
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, raw.data.trim()).map_err(|_| "invalid attachment data".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(format!("each attachment must be between 1 byte and {MAX_ATTACHMENT_BYTES} bytes"));
        }
        let name = raw.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
        let saved = media.save(&bytes, raw.content_type.trim(), name).await?;
        stored.push(crate::media::to_message_attachment(&saved));
        lines.push(crate::media::attachment_prompt_line(&saved));
    }
    Ok((stored, lines))
}

pub fn bot_line(text: &str) -> TranscriptMessage {
    TranscriptMessage {
        author: crate::handler::BOT_NAME.to_string(),
        text: text.to_string(),
        bot: true,
        at: None,
        questions: None,
        attachments: None,
        reply_to: None,
    }
}

pub async fn team_send(
    deps: Arc<HandlerDeps>,
    transcripts: Arc<TranscriptStore>,
    thread: &str,
    text: &str,
    name: &str,
    allowed_commands: Option<&[&str]>,
    attachments: &[TeamAttachmentInput],
    reply_to: Option<Quote>,
) -> Result<serde_json::Value, String> {
    if !thread_id_ok(thread) {
        return Err("bad thread id".into());
    }
    let text = text.trim();
    if text.is_empty() && attachments.is_empty() {
        return Err("thread and text or an image are required".into());
    }
    if let (Some(allowed), Some(cmd)) = (allowed_commands, crate::handler::command_of(text)) {
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
                text: if text.is_empty() { "(attachment)".into() } else { text.to_string() },
                bot: false,
                at: None,
                questions: None,
                attachments: Some(stored).filter(|s| !s.is_empty()),
                reply_to,
            }],
        )
        .await?;
    if let Some((id, approve)) = crate::handler::gate_command(text) {
        let reply = match crate::gate::decide(&id, approve) {
            Some(info) => crate::gate::decided_text(&info, approve, Some(name)),
            None => format!("No pending approval {id}."),
        };
        transcripts.append(&thread_key, vec![bot_line(&reply)]).await?;
        return Ok(serde_json::json!({ "ok": true, "gate": id }));
    }
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
        let deps3 = deps2.clone();
        let request = TurnRequest {
            thread_key: thread_key2.clone(),
            space_name: "team-chat".into(),
            text: prompt,
            sender: Some(sender),
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: None,
            reply_sink: Some(transcripts2.clone()),
            request_id: Some(request_id.clone()),
        };
        let Some(request) = crate::handler::debounce(&deps3, request).await else { return };
        let result = crate::handler::tracked(&deps3, Some(&request_id), process_message(request, deps2)).await;
        if let Err(err) = result {
            tracing::error!(%err, "team turn failed");
        }
    });

    Ok(serde_json::json!({ "ok": true, "replies": [] }))
}

pub async fn team_steer(
    deps: Arc<HandlerDeps>,
    transcripts: Arc<TranscriptStore>,
    thread: &str,
    text: &str,
    name: &str,
    reply_to: Option<Quote>,
) -> Result<serde_json::Value, String> {
    if !thread_id_ok(thread) {
        return Err("bad thread id".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("text is required".into());
    }
    let thread_key = format!("{TEAM_PREFIX}{thread}");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let request = TurnRequest {
        thread_key: thread_key.clone(),
        space_name: "team-chat".into(),
        text: quoted(reply_to.as_ref(), text),
        sender: Some(name.into()),
        reply_via_chat: false,
        thread: None,
        room_n: None,
        captured_replies: Some(captured.clone()),
        reply_sink: None,
        request_id: None,
    };
    if !crate::handler::steered(&request, &deps).await {
        return team_send(deps, transcripts, thread, text, name, None, &[], reply_to).await;
    }
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
                reply_to,
            }],
        )
        .await?;
    for reply in captured.lock().await.iter() {
        let message = bot_message(&transcripts.get(&thread_key), reply.clone());
        transcripts.append(&thread_key, vec![message]).await?;
    }
    Ok(serde_json::json!({ "ok": true, "replies": [] }))
}

fn quoted(reply_to: Option<&Quote>, text: &str) -> String {
    let Some(q) = reply_to else { return text.to_string() };
    let excerpt: String = q.text.chars().take(400).collect();
    let lines = excerpt.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
    format!("Replying to {}:\n{lines}\n\n{text}", q.author)
}

pub fn split_quote(text: &str, prior: &[TranscriptMessage]) -> (String, Option<Quote>) {
    let (head, body) = match text.split_once('\n') {
        Some((h, b)) if h.starts_with("*@") && h.ends_with('*') => (Some(h), b),
        _ => (None, text),
    };
    let quote_lines: Vec<&str> = body.lines().take_while(|l| l.starts_with('>')).collect();
    if quote_lines.is_empty() {
        return (text.to_string(), None);
    }
    let quote = quote_lines.iter().map(|l| l.trim_start_matches('>').trim()).collect::<Vec<_>>().join("\n").trim().to_string();
    let rest = body.lines().skip(quote_lines.len()).collect::<Vec<_>>().join("\n").trim().to_string();
    if quote.is_empty() || rest.is_empty() {
        return (text.to_string(), None);
    }
    let needle = quote.trim_end_matches(['.', '…']).to_lowercase();
    let author = prior.iter().rev().find(|m| m.text.to_lowercase().contains(&needle)).map(speaker).unwrap_or_default();
    let text = head.map(|h| format!("{h}\n{rest}")).unwrap_or(rest);
    (text, Some(Quote { author, text: quote }))
}

fn speaker(m: &TranscriptMessage) -> String {
    m.text
        .split_once('\n')
        .map(|(h, _)| h)
        .filter(|h| m.bot && h.starts_with("*@") && h.ends_with('*'))
        .map(|h| h.trim_matches('*').to_string())
        .unwrap_or_else(|| m.author.clone())
}

pub(crate) fn bot_message(prior: &[TranscriptMessage], reply: String) -> TranscriptMessage {
    let (text, reply_to) = split_quote(&reply, prior);
    TranscriptMessage {
        author: BOT_NAME.into(),
        text,
        bot: true,
        at: None,
        questions: None,
        attachments: None,
        reply_to,
    }
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
                    format!("no agent @{persona_name} — add it under Create")
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
        busy: deps.queue.busy(&thread_key).await || crate::handler::debouncing(&thread_key),
        members: record.as_ref().and_then(|r| r.members.clone()),
        kicked: record.as_ref().and_then(|r| r.kicked.clone()).unwrap_or_default(),
        answering: talking.iter().map(|w| w.strip_prefix('@').unwrap_or(w)).map(String::from).collect(),
        upcoming: crate::handler::upcoming(&thread_key)
            .into_iter()
            .filter(|n| !talking.iter().any(|t| t.trim_start_matches('@').eq_ignore_ascii_case(n)))
            .collect(),
        presence: presence(
            &effective_members(record.as_ref(), &options.personas),
            &talking,
            record.as_ref().and_then(|r| r.pending_questions.as_ref()).is_some_and(|q| !q.is_empty()),
            record.as_ref().and_then(|r| r.room_seen.as_ref()),
        ),
        runs: record.as_ref().map(|r| agent_runs(r, &options)).unwrap_or_default(),
        debounce: crate::handler::debounce_pending(&thread_key).map(|(count, ms_left)| Debounce { count, ms_left }),
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
            persona_usage: Some(std::collections::HashMap::from([(
                "architect".into(),
                crate::session::PersonaUsage {
                    context_tokens: Some(420),
                    context_window: Some(128_000),
                    estimated: Some(false),
                    turns: Some(2),
                },
            )])),
            ..Default::default()
        };
        let options = crate::handler::TurnOptions {
            context_footer: crate::settings::ContextFooter::Never,
            auto_compact_at: 0,
            debounce_ms: 0,
            parallel_room: false,
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
                avatar: None,
            }],
            host_prompt: None,
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
        assert_eq!(runs[1].context_tokens, Some(420));
        assert_eq!(runs[1].context_window, Some(128_000));
        assert_eq!(runs[1].turns, Some(2));
        assert_eq!(runs[1].estimated, Some(false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(author: &str, text: &str, bot: bool) -> TranscriptMessage {
        TranscriptMessage { author: author.into(), text: text.into(), bot, at: None, questions: None, attachments: None, reply_to: None }
    }

    #[test]
    fn agent_replies_starting_with_a_quote_cite_the_matching_message() {
        let prior = vec![msg("Ana", "usemos pnpm en vez de npm", false), msg(BOT_NAME, "*@dev*\nlisto, corro los tests", true)];
        let (text, quote) = split_quote("*@qa*\n> corro los tests\nfallan dos", &prior);
        assert_eq!(text, "*@qa*\nfallan dos");
        assert_eq!(quote, Some(Quote { author: "@dev".into(), text: "corro los tests".into() }));
        let (text, quote) = split_quote("> usemos pnpm\nok", &prior);
        assert_eq!((text.as_str(), quote.unwrap().author.as_str()), ("ok", "Ana"));
        assert_eq!(split_quote("sin cita", &prior), ("sin cita".into(), None));
        assert_eq!(split_quote("> solo cita", &prior).1, None);
    }

    #[test]
    fn human_replies_carry_the_quote_into_the_prompt() {
        let q = Quote { author: "@dev".into(), text: "a\nb".into() };
        assert_eq!(quoted(Some(&q), "por qué?"), "Replying to @dev:\n> a\n> b\n\npor qué?");
        assert_eq!(quoted(None, "hola"), "hola");
    }
}
