use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::driver::types::{AgentDriver, AgentQuestion, AgentTurnInput};
use crate::google::{ChatClient, PostMessageBody, PostThread};
use crate::personas::{
    active_personas, add_hint, addressed_personas, asked_personas, consult_open, consult_topics,
    dialogue_open, dialogue_pass, flow_move, hears_reply, host_preamble, is_pass, last_bot_agent, mentioned_personas,
    mentions_bot, persona_preamble, request_stop, room_append, room_catch_up, room_prompt, roster_update, switchboard_update,
    strip_self_prefix, FlowMove, MAX_DIALOGUE_HOPS, MAX_HOPS, MAX_INTERJECTIONS,
};
pub use crate::personas::BOT_NAME;
use crate::workspace::slug_for;
use crate::question_gate::{has_question, hold_question, take_question};
use crate::questions::{continuation, question_cards};
use crate::queue::TurnQueue;
use crate::session::{FlowCursor, SessionPatch, SessionStore};
use crate::settings::{ContextFooter, Persona, Settings};
use crate::text::{chunk_text, extract_prompt};
use crate::verify::TokenVerifier;
use crate::workspace::Workspaces;

pub const TEAM_PREFIX: &str = "share/";

#[derive(Debug, Clone, Deserialize)]
pub struct ChatEvent {
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    pub space: Option<ChatSpace>,
    pub message: Option<ChatMessage>,
    pub user: Option<ChatUser>,
    pub action: Option<ChatAction>,
    #[serde(rename = "common")]
    pub common: Option<ChatCommon>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatCommon {
    pub parameters: Option<Vec<ChatParam>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatParam {
    pub key: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatAction {
    pub action_method_name: Option<String>,
    pub parameters: Option<Vec<ChatParam>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatSpace {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub name: Option<String>,
    pub text: Option<String>,
    #[serde(rename = "argumentText")]
    pub argument_text: Option<String>,
    pub thread: Option<ChatThread>,
    pub sender: Option<ChatUser>,
    pub attachment: Option<Vec<ChatAttachment>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatAttachment {
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    #[serde(rename = "contentName")]
    pub content_name: Option<String>,
    #[serde(rename = "attachmentDataRef")]
    pub attachment_data_ref: Option<AttachmentDataRef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttachmentDataRef {
    #[serde(rename = "resourceName")]
    pub resource_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatThread {
    pub name: Option<String>,
    #[serde(rename = "threadKey")]
    pub thread_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatUser {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
}

#[derive(Clone)]
pub struct HandlerConfig {
    pub allowed_spaces: Vec<String>,
    pub workdir: String,
}

#[derive(Clone)]
pub struct TurnOptions {
    pub context_footer: ContextFooter,
    pub auto_compact_at: u32,
    pub debounce_ms: u32,
    pub parallel_room: bool,
    pub default_model: Option<String>,
    pub default_driver: crate::config::AgentDriverKind,
    pub default_models: crate::settings::Models,
    pub personas: Vec<Persona>,
    pub host_prompt: Option<String>,
}

pub struct HandlerDeps {
    pub verifier: Arc<dyn TokenVerifier>,
    pub driver: Arc<dyn AgentDriver>,
    pub chat: Arc<dyn ChatClient>,
    pub store: Arc<SessionStore>,
    pub queue: Arc<TurnQueue>,
    pub config: std::sync::Mutex<HandlerConfig>,
    pub workspaces: Option<Arc<Workspaces>>,
    pub activity: Option<Arc<crate::activity::ActivityLog>>,
    pub scheduler: std::sync::OnceLock<Arc<crate::schedules::Scheduler>>,
    pub ledger: Option<Arc<crate::turn_ledger::TurnLedger>>,
    pub options: Arc<dyn Fn() -> TurnOptions + Send + Sync>,
    pub media: Option<Arc<crate::media::MediaStore>>,
}

#[derive(Debug, Serialize)]
pub struct HandleResult {
    pub status: u16,
    pub body: Value,
}

fn card_answer(event: &ChatEvent) -> Option<String> {
    let params = event
        .action
        .as_ref()
        .and_then(|a| a.parameters.as_ref())
        .or_else(|| event.common.as_ref().and_then(|c| c.parameters.as_ref()))?;
    params
        .iter()
        .find(|p| p.key.as_deref() == Some("answer"))
        .and_then(|p| p.value.clone())
}

fn param<'a>(event: &'a ChatEvent, key: &str) -> Option<&'a str> {
    let params = event
        .action
        .as_ref()
        .and_then(|a| a.parameters.as_ref())
        .or_else(|| event.common.as_ref().and_then(|c| c.parameters.as_ref()))?;
    params.iter().find(|p| p.key.as_deref() == Some(key)).and_then(|p| p.value.as_deref())
}

pub fn gate_command(text: &str) -> Option<(String, bool)> {
    let mut words = text.trim().split_whitespace();
    let approve = match words.next()? {
        "/approve" => true,
        "/deny" => false,
        _ => return None,
    };
    let id = words.next()?;
    id.starts_with('g').then(|| (id.to_string(), approve))
}

fn gate_event(event: &ChatEvent) -> Option<HandleResult> {
    let who = event.user.as_ref().and_then(|u| u.display_name.clone());
    if let Some(id) = param(event, "gate") {
        let approve = param(event, "approve") == Some("yes");
        let text = match crate::gate::decide(id, approve) {
            Some(info) => crate::gate::decided_text(&info, approve, who.as_deref()),
            None => "This approval was already decided or expired.".to_string(),
        };
        return Some(HandleResult { status: 200, body: json!({ "actionResponse": { "type": "UPDATE_MESSAGE" }, "text": text }) });
    }
    let message = event.message.as_ref()?;
    let text = extract_prompt(message.argument_text.as_deref(), message.text.as_deref());
    let (id, approve) = gate_command(&text)?;
    let text = match crate::gate::decide(&id, approve) {
        Some(info) => crate::gate::decided_text(&info, approve, who.as_deref()),
        None => format!("No pending approval {id}."),
    };
    Some(HandleResult { status: 200, body: json!({ "text": text }) })
}

pub async fn handle_event(auth_header: Option<&str>, event: ChatEvent, deps: Arc<HandlerDeps>) -> HandleResult {
    if let Err(err) = deps.verifier.verify(auth_header).await {
        tracing::error!(%err, "auth rejected");
        return HandleResult {
            status: 401,
            body: json!({ "error": "invalid token" }),
        };
    }

    let space_name = event.space.as_ref().and_then(|s| s.name.clone());
    let allowed = deps.config.lock().unwrap().allowed_spaces.clone();
    let Some(space_name) = space_name.filter(|s| allowed.iter().any(|a| a == s)) else {
        return HandleResult {
            status: 200,
            body: json!({ "ok": true, "dropped": true }),
        };
    };

    if let Some(res) = gate_event(&event) {
        return res;
    }

    if event.event_type.as_deref() == Some("ADDED_TO_SPACE") {
        let chat = deps.chat.clone();
        let space = space_name.clone();
        tokio::spawn(async move {
            let _ = chat
                .post_message(&space, &PostMessageBody::text("Hi — mention me in a thread to start."))
                .await;
        });
        return HandleResult {
            status: 200,
            body: json!({ "ok": true }),
        };
    }

    let clicked = card_answer(&event);
    if event.event_type.as_deref() != Some("MESSAGE") && clicked.is_none() {
        return HandleResult {
            status: 200,
            body: json!({ "ok": true }),
        };
    }
    let Some(message) = event.message.clone() else {
        return HandleResult {
            status: 200,
            body: json!({ "ok": true }),
        };
    };
    let thread_key = message
        .thread
        .as_ref()
        .and_then(|t| t.name.clone().or(t.thread_key.clone()));
    let Some(thread_key) = thread_key else {
        return HandleResult {
            status: 200,
            body: json!({ "ok": true, "dropped": true }),
        };
    };
    let clicked_answer = clicked.is_some();
    let text = clicked.unwrap_or_else(|| {
        extract_prompt(message.argument_text.as_deref(), message.text.as_deref())
    });
    let has_attachments = message
        .attachment
        .as_ref()
        .map(|list| {
            list.iter()
                .any(|a| a.attachment_data_ref.as_ref().and_then(|r| r.resource_name.as_ref()).is_some())
        })
        .unwrap_or(false);
    if text.is_empty() && !has_attachments {
        return HandleResult {
            status: 200,
            body: json!({ "ok": true, "dropped": true }),
        };
    }
    let thread = message.thread.as_ref().map(|t| PostThread {
        name: t.name.clone(),
        thread_key: t.thread_key.clone(),
    });
    let request_id = message.name.clone().map(|n| if clicked_answer { format!("{n}#{text}") } else { n });
    if let (Some(ledger), Some(id)) = (&deps.ledger, &request_id) {
        if !ledger.begin(id, &thread_key, &space_name, thread.clone()).await {
            return HandleResult { status: 200, body: json!({ "ok": true, "duplicate": true }) };
        }
        let who = message.sender.as_ref().or(event.user.as_ref()).and_then(|u| u.display_name.clone());
        let said = match &who {
            Some(w) => format!("{w}: {text}"),
            None => text.clone(),
        };
        ledger.remember_prompt(id, &said).await;
    }
    let sender = message
        .sender
        .as_ref()
        .or(event.user.as_ref())
        .and_then(|u| u.display_name.clone());
    let deps2 = deps.clone();
    let space2 = space_name.clone();
    let thread2 = thread_key.clone();
    tokio::spawn(async move {
        let saved = if clicked_answer || !has_attachments {
            Vec::new()
        } else {
            ingest_chat_attachments(&message, &deps2).await
        };
        let prompt = std::iter::once(text)
            .chain(saved.iter().map(crate::media::attachment_prompt_line))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if prompt.is_empty() {
            tracing::info!("message dropped: attachments could not be downloaded");
            return;
        }
        let request = TurnRequest {
            thread_key: thread2,
            space_name: space2,
            text: prompt,
            sender,
            reply_via_chat: true,
            thread,
            room_n: None,
            captured_replies: None,
            reply_sink: None,
            request_id: request_id.clone(),
        };
        let Some(request) = debounce(&deps2, request).await else { return };
        if steered(&request, &deps2).await {
            return;
        }
        let id = request.request_id.clone();
        let _ = tracked(&deps2.clone(), id.as_deref(), process_message(request, deps2)).await;
    });
    HandleResult {
        status: 200,
        body: json!({ "ok": true }),
    }
}

pub(crate) async fn steered(req: &TurnRequest, deps: &HandlerDeps) -> bool {
    if command_of(&req.text).is_some() || persona_lane(req, deps) || !deps.queue.busy(&req.thread_key).await {
        return false;
    }
    let Some(session) = deps.store.get(&req.thread_key).and_then(|r| r.session_ref) else {
        return false;
    };
    let request_id = req.request_id.clone().unwrap_or_else(|| format!("{}:steer:{}", req.thread_key, uuid::Uuid::new_v4()));
    let result = match deps.driver.steer(&req.thread_key, &session, &request_id, &req.text).await {
        Ok(Some(result)) => result,
        Ok(None) => return false,
        Err(e) => {
            tracing::warn!("steer failed, queueing instead: {e}");
            return false;
        }
    };
    note(deps, "turn_steer", &req.thread_key, req.text.chars().take(80).collect::<String>(), req.sender.clone().unwrap_or_default()).await;
    if let crate::driver::types::SteerResult::Answered(out) = result {
        if !is_pass(&out.reply) {
            deliver_reply(req, deps, &out.reply, None, None).await;
        }
    }
    mark(deps, req.request_id.as_deref(), crate::turn_ledger::TurnState::Posted).await;
    true
}

async fn mark(deps: &HandlerDeps, request_id: Option<&str>, state: crate::turn_ledger::TurnState) {
    if let (Some(ledger), Some(id)) = (&deps.ledger, request_id) {
        ledger.set(id, state).await;
    }
}

struct Batch {
    generation: u64,
    items: Vec<(Option<String>, String, Option<String>)>,
    due: std::time::Instant,
}

static BATCHES: std::sync::Mutex<Option<std::collections::HashMap<String, Batch>>> = std::sync::Mutex::new(None);

pub fn debouncing(thread_key: &str) -> bool {
    debounce_pending(thread_key).is_some()
}

/// Busy beyond the host queue: a pending debounce or an agent answering on its own lane.
pub fn lanes_busy(thread_key: &str) -> bool {
    debouncing(thread_key) || !speaking(thread_key).is_empty()
}

pub fn debounce_pending(thread_key: &str) -> Option<(usize, u64)> {
    let guard = BATCHES.lock().unwrap();
    let batch = guard.as_ref()?.get(thread_key)?;
    if std::time::Instant::now() > batch.due + std::time::Duration::from_secs(5) {
        return None;
    }
    let left = batch.due.saturating_duration_since(std::time::Instant::now()).as_millis() as u64;
    Some((batch.items.len(), left))
}

pub async fn debounce(deps: &HandlerDeps, req: TurnRequest) -> Option<TurnRequest> {
    let ms = (deps.options)().debounce_ms;
    if ms == 0 || command_of(&req.text).is_some() || deps.queue.busy(&req.thread_key).await {
        return Some(req);
    }
    let generation = {
        let mut guard = BATCHES.lock().unwrap();
        let batch = guard.get_or_insert_with(std::collections::HashMap::new).entry(req.thread_key.clone()).or_insert(Batch { generation: 0, items: Vec::new(), due: std::time::Instant::now() });
        batch.generation += 1;
        batch.due = std::time::Instant::now() + std::time::Duration::from_millis(ms as u64);
        batch.items.push((req.sender.clone(), req.text.clone(), req.request_id.clone()));
        batch.generation
    };
    tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
    let items = {
        let mut guard = BATCHES.lock().unwrap();
        let map = guard.get_or_insert_with(std::collections::HashMap::new);
        if map.get(&req.thread_key).map(|b| b.generation) != Some(generation) {
            return None;
        }
        map.remove(&req.thread_key).map(|b| b.items).unwrap_or_default()
    };
    if items.len() <= 1 {
        return Some(req);
    }
    for (_, _, id) in &items[..items.len() - 1] {
        mark(deps, id.as_deref(), crate::turn_ledger::TurnState::Posted).await;
    }
    let one_sender = items.iter().all(|(s, _, _)| *s == items[0].0);
    let text = items
        .iter()
        .map(|(s, t, _)| match (one_sender, s) {
            (false, Some(s)) => format!("{s}: {t}"),
            _ => t.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let sender = if one_sender { items[0].0.clone() } else { None };
    if let (Some(ledger), Some(id)) = (&deps.ledger, &req.request_id) {
        ledger.remember_prompt(id, &match &sender {
            Some(s) => format!("{s}: {text}"),
            None => text.clone(),
        })
        .await;
    }
    Some(TurnRequest { text, sender, ..req })
}

pub async fn tracked<F: std::future::Future<Output = Result<bool, String>>>(deps: &HandlerDeps, request_id: Option<&str>, turn: F) -> Result<bool, String> {
    let (Some(ledger), Some(id)) = (&deps.ledger, request_id) else {
        return turn.await;
    };
    ledger.set(id, crate::turn_ledger::TurnState::Running).await;
    let result = turn.await;
    let state = if result == Ok(true) { crate::turn_ledger::TurnState::Posted } else { crate::turn_ledger::TurnState::Failed };
    ledger.set(id, state).await;
    result
}

async fn ingest_chat_attachments(
    message: &ChatMessage,
    deps: &HandlerDeps,
) -> Vec<crate::media::StoredMedia> {
    let list = match &message.attachment {
        Some(list) if !list.is_empty() => list,
        _ => return Vec::new(),
    };
    let Some(media) = deps.media.as_ref() else {
        return Vec::new();
    };
    let mut saved = Vec::new();
    for a in list {
        let Some(resource) = a
            .attachment_data_ref
            .as_ref()
            .and_then(|r| r.resource_name.as_deref())
        else {
            continue;
        };
        match deps.chat.download_media(resource).await {
            Ok(bytes) => {
                let ct = a.content_type.as_deref().unwrap_or("application/octet-stream");
                match media.save(&bytes, ct, a.content_name.as_deref()).await {
                    Ok(stored) => saved.push(stored),
                    Err(err) => tracing::error!(%err, "media save failed"),
                }
            }
            Err(err) => tracing::error!(%err, "Chat attachment download failed"),
        }
    }
    saved
}

pub struct TurnRequest {
    pub thread_key: String,
    pub space_name: String,
    pub text: String,
    pub sender: Option<String>,
    pub reply_via_chat: bool,
    pub thread: Option<PostThread>,
    pub room_n: Option<u64>,
    pub captured_replies: Option<Arc<tokio::sync::Mutex<Vec<String>>>>,
    pub reply_sink: Option<Arc<crate::transcripts::TranscriptStore>>,
    pub request_id: Option<String>,
}

/// In a parallel room, a message for agents skips the host's thread queue: each agent has its own lane.
fn persona_lane(req: &TurnRequest, deps: &HandlerDeps) -> bool {
    let options = (deps.options)();
    if !options.parallel_room || command_of(&req.text).is_some() || has_question(&req.thread_key) {
        return false;
    }
    let record = deps.store.get(&req.thread_key);
    if record.as_ref().and_then(|r| r.pending_questions.as_ref()).is_some() {
        return false;
    }
    let personas = active_personas(&options.personas, record.as_ref().and_then(|r| r.members.as_deref()));
    !addressed_personas(&req.text, &personas).is_empty()
}

/// Steers a message into an agent's running session. False when the agent is idle or steer is unavailable.
async fn steer_persona(req: &TurnRequest, deps: &HandlerDeps, persona: &Persona) -> bool {
    if !speaking(&req.thread_key).contains(&format!("@{}", persona.name)) {
        return false;
    }
    let Some(session) = deps.store.get(&req.thread_key).and_then(|r| r.persona_sessions).and_then(|m| m.get(&persona.name).cloned()) else {
        return false;
    };
    let key = format!("{}#{}", req.thread_key, persona.name);
    let request_id = req.request_id.as_ref().map(|r| format!("{r}#{}#steer", persona.name)).unwrap_or_else(|| format!("{key}:steer:{}", uuid::Uuid::new_v4()));
    let text = match &req.sender {
        Some(s) => format!("{s}: {}", req.text),
        None => req.text.clone(),
    };
    let result = match deps.driver.steer(&key, &session, &request_id, &text).await {
        Ok(Some(result)) => result,
        Ok(None) => return false,
        Err(e) => {
            tracing::warn!("persona steer failed, queueing instead: {e}");
            return false;
        }
    };
    note(deps, "turn_steer", &req.thread_key, text.chars().take(80).collect::<String>(), format!("@{}", persona.name)).await;
    if let crate::driver::types::SteerResult::Answered(out) = result {
        let reply = strip_self_prefix(&out.reply, persona);
        if !is_pass(&reply) {
            deliver_reply(req, deps, &reply, Some(&persona.name), None).await;
        }
    }
    true
}

fn spend_notice(req: &TurnRequest, deps: &HandlerDeps) -> Option<(String, bool)> {
    let settings = crate::settings::global()?.get();
    if settings.spend.is_empty() {
        return None;
    }
    let ledger = crate::usage::global()?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let agent = addressed_personas(&req.text, &settings.personas).first().map(|p| p.name.clone()).unwrap_or_else(|| BOT_NAME.to_string());
    let override_on = deps.store.get(&req.thread_key).and_then(|r| r.spend_override).unwrap_or(false);
    let status = crate::usage::assess_spend(&ledger.entries(), &today, &req.thread_key, &agent, &settings.spend, override_on)?;
    let pct = if status.limit > 0.0 { (status.spent / status.limit * 100.0).round() as u32 } else { 100 };
    let text = match status.level {
        crate::usage::SpendLevel::Stop => format!(
            "Spend cap reached ({pct}% of the {} limit, ${:.4} / ${:.4}). Send /spend-continue to keep going.",
            status.scope, status.spent, status.limit
        ),
        crate::usage::SpendLevel::Warn => format!("Spend is at {pct}% of the {} limit (${:.4} / ${:.4}).", status.scope, status.spent, status.limit),
        crate::usage::SpendLevel::Ok => return None,
    };
    Some((text, status.level == crate::usage::SpendLevel::Stop))
}

fn kick_flow(thread_key: String, space: String, sink: Option<Arc<crate::transcripts::TranscriptStore>>, deps: Arc<HandlerDeps>, approved: bool) {
    tokio::spawn(async move {
        let Some(settings) = crate::settings::global().map(|s| s.get()) else { return };
        let Some(cursor) = deps.store.get(&thread_key).and_then(|r| r.flow) else { return };
        if cursor.hold {
            return;
        }
        let Some(flow) = settings.flows.iter().find(|f| f.id == cursor.id).cloned() else { return };
        let Some(step) = flow.steps.get(cursor.step).cloned() else { return };
        if step.approve && !approved {
            let _ = deps
                .store
                .update(&thread_key, &space, SessionPatch { flow: Some(Some(FlowCursor { hold: true, ..cursor.clone() })), ..Default::default() })
                .await;
            let (info, rx) = crate::gate::open_flow(&thread_key, &step.agent);
            if let Some(sink) = &sink {
                let _ = sink.append(&thread_key, vec![crate::team::bot_line(&crate::gate::summary(&info))]).await;
            }
            let deps2 = deps.clone();
            let sink2 = sink.clone();
            let space2 = space.clone();
            let thread2 = thread_key.clone();
            let id = cursor.id.clone();
            let step_i = cursor.step;
            let task = cursor.task.clone();
            tokio::spawn(async move {
                let ok = rx.await.unwrap_or(false);
                if !ok {
                    let _ = deps2.store.update(&thread2, &space2, SessionPatch { flow: Some(None), ..Default::default() }).await;
                    if let Some(sink) = &sink2 {
                        let _ = sink.append(&thread2, vec![crate::team::bot_line("Flow stopped.")]).await;
                    }
                    return;
                }
                let _ = deps2
                    .store
                    .update(&thread2, &space2, SessionPatch { flow: Some(Some(FlowCursor { id, step: step_i, hold: false, task })), ..Default::default() })
                    .await;
                kick_flow(thread2, space2, sink2, deps2, true);
            });
            return;
        }
        let task = cursor.task.as_deref().map(|t| format!("

Task: {t}")).unwrap_or_default();
        let text = format!(
            "@{} You are step {} of the flow \"{}\". Continue from the conversation. Do not @mention the next step; the flow does that.{task}",
            step.agent,
            cursor.step + 1,
            flow.name
        );
        let request_id = uuid::Uuid::new_v4().to_string();
        if let Some(ledger) = &deps.ledger {
            ledger.begin(&request_id, &thread_key, &space, None).await;
        }
        let req = TurnRequest {
            thread_key,
            space_name: space,
            text,
            sender: Some("flow".into()),
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: None,
            reply_sink: sink,
            request_id: Some(request_id),
        };
        let _ = process_message(req, deps).await;
    });
}

async fn follow_flow(req: &TurnRequest, sink: &Arc<crate::transcripts::TranscriptStore>, deps: Arc<HandlerDeps>) {
    let Some(settings) = crate::settings::global().map(|s| s.get()) else { return };
    let Some(cursor) = deps.store.get(&req.thread_key).and_then(|r| r.flow) else { return };
    if cursor.hold {
        return;
    }
    let Some(flow) = settings.flows.iter().find(|f| f.id == cursor.id).cloned() else { return };
    let messages = sink.get(&req.thread_key);
    let last = messages.iter().rev().find(|m| m.bot);
    let agent = last.and_then(|m| last_bot_agent(&m.text, &m.author));
    match flow_move(cursor.step, &flow.steps, agent.as_deref()) {
        FlowMove::Stay => {}
        FlowMove::Done => {
            let _ = deps.store.update(&req.thread_key, &req.space_name, SessionPatch { flow: Some(None), ..Default::default() }).await;
            deliver_reply(req, &deps, &format!("Flow {} finished.", flow.name), None, None).await;
        }
        FlowMove::Next { step, .. } => {
            let _ = deps
                .store
                .update(&req.thread_key, &req.space_name, SessionPatch { flow: Some(Some(FlowCursor { id: cursor.id, step, hold: false, task: cursor.task })), ..Default::default() })
                .await;
            kick_flow(req.thread_key.clone(), req.space_name.clone(), req.reply_sink.clone(), deps, false);
        }
    }
}

pub async fn process_message(mut req: TurnRequest, deps: Arc<HandlerDeps>) -> Result<bool, String> {
    let key = req.thread_key.clone();
    if req.reply_via_chat {
        crate::gate::remember_route(&key, &req.space_name, req.thread.clone());
    }
    let lane_free = persona_lane(&req, &deps);
    let queue = deps.queue.clone();
    let turn = move || async move {
        if let Some(cmd) = command_of(&req.text) {
            let reply = run_command(&req, &deps).await.unwrap_or_else(|e| format!("Command failed: {e}"));
            let started = cmd == "flow" && !reply.starts_with("Command failed");
            deliver_reply(&req, &deps, &reply, None, None).await;
            if started {
                kick_flow(req.thread_key.clone(), req.space_name.clone(), req.reply_sink.clone(), deps.clone(), false);
            }
            return Ok(true);
        }
        if let Some((text, stop)) = spend_notice(&req, &deps) {
            deliver_reply(&req, &deps, &text, None, None).await;
            if stop {
                return Ok(true);
            }
        }
        offer_repo(&req, &deps).await;
        if let Some(scheduler) = deps.scheduler.get() {
            let mut jobs = scheduler.jobs_for_text(&req.text, &req.space_name);
            jobs.extend(scheduler.jobs_for_text(&req.text, &req.thread_key));
            let notes = fire_jobs(&deps, jobs, "a message matched").await;
            if !notes.is_empty() {
                deliver_reply(&req, &deps, &notes.join("\n"), None, None).await;
            }
        }
        let members = deps
            .store
            .get(&req.thread_key)
            .as_ref()
            .and_then(|r| r.members.clone());
        let personas = active_personas(&(deps.options)().personas, members.as_deref());
        if !personas.is_empty() {
            let room_n = room_log(
                &deps,
                &req.thread_key,
                &req.space_name,
                req.sender.as_deref().unwrap_or("someone"),
                &req.text,
            )
            .await;
            req.room_n = Some(room_n);
        }
        let parallel = (deps.options)().parallel_room;
        let result = if parallel {
            let jump = optional_jump(&req, &deps, false);
            let (result, _) = tokio::join!(agent_turn(&req, &deps), optional_round(&req, &deps, jump));
            result
        } else {
            agent_turn(&req, &deps).await
        };
        let (kind, detail) = match &result {
            Ok(_) => ("turn_ok", req.sender.clone().unwrap_or_default()),
            Err(e) => ("turn_fail", e.clone()),
        };
        note(&deps, kind, &req.thread_key, req.text.chars().take(80).collect::<String>(), detail).await;
        if result.is_ok() && req.sender.as_deref() == Some("flow") {
            if let Some(sink) = req.reply_sink.clone() {
                follow_flow(&req, &sink, deps.clone()).await;
            }
        }
        if !parallel {
            let jump = optional_jump(&req, &deps, true);
            optional_round(&req, &deps, jump).await;
        }
        result
    };
    // Agent lanes serialize on persona_lock inside persona_round; only host turns take the thread queue.
    if lane_free {
        turn().await
    } else {
        queue.run(&key, turn).await
    }
}

fn optional_jump(req: &TurnRequest, deps: &HandlerDeps, after_turn: bool) -> Vec<Persona> {
    let record = deps.store.get(&req.thread_key);
    let room_now = active_personas(&(deps.options)().personas, record.as_ref().and_then(|r| r.members.as_deref()));
    let mut spoken: std::collections::HashSet<String> = addressed_personas(&req.text, &room_now)
        .into_iter()
        .chain(consult_topics(&req.text, &room_now))
        .map(|p| p.name.to_lowercase())
        .collect();
    if after_turn {
        if let (Some(since), Some(room)) = (req.room_n, record.as_ref().and_then(|r| r.room.clone())) {
            spoken.extend(room.into_iter().filter(|e| e.n > since).filter_map(|e| e.author.strip_prefix('@').map(|n| n.to_lowercase())));
        }
    }
    // Room membership does not override Listens. Only "Every message" chimes in
    // on a line that did not name them; "Only @mentions" stays quiet until @name.
    room_now
        .iter()
        .filter(|p| !spoken.contains(&p.name.to_lowercase()) && p.listen.as_deref() == Some("all"))
        .cloned()
        .collect()
}

async fn optional_round(req: &TurnRequest, deps: &HandlerDeps, jump: Vec<Persona>) {
    if jump.is_empty() {
        return;
    }
    let all = active_personas(
        &(deps.options)().personas,
        deps.store.get(&req.thread_key).as_ref().and_then(|r| r.members.as_deref()),
    );
    let _ = persona_round(
        req,
        deps,
        &jump,
        &all,
        PersonaOpts {
            optional: true,
            ..Default::default()
        },
    )
    .await;
}

async fn deliver_reply(
    req: &TurnRequest,
    deps: &HandlerDeps,
    text: &str,
    author: Option<&str>,
    questions: Option<&[AgentQuestion]>,
) {
    let body_text = if let Some(a) = author {
        format!("*@{a}*\n{text}")
    } else {
        text.to_string()
    };
    if let Some(sink) = &req.reply_sink {
        let message = crate::team::bot_message(&sink.get(&req.thread_key), body_text.clone());
        if let Err(err) = sink.append(&req.thread_key, vec![message]).await {
            tracing::error!(%err, "team reply append failed");
        }
    } else if let Some(buf) = &req.captured_replies {
        buf.lock().await.push(body_text.clone());
    }
    if let Some(room_author) = author.map(|a| format!("@{a}")).or(Some(BOT_NAME.to_string())) {
        if req.room_n.is_some() || deps.store.get(&req.thread_key).and_then(|r| r.room).is_some() {
            let _ = room_log(deps, &req.thread_key, &req.space_name, &room_author, text).await;
        }
    }
    if req.reply_via_chat {
        let cards = questions.map(question_cards);
        for (i, chunk) in chunk_text(&body_text, 3800).into_iter().enumerate() {
            let body = PostMessageBody {
                text: chunk,
                thread: req.thread.clone(),
                cards_v2: if i == 0 { cards.clone() } else { None },
            };
            if let Err(err) = deps.chat.post_message(&req.space_name, &body).await {
                tracing::error!(%err, "reply failed");
            }
        }
    }
}

async fn agent_turn(req: &TurnRequest, deps: &HandlerDeps) -> Result<bool, String> {
    let record = deps.store.get(&req.thread_key);
    let options = (deps.options)();
    let personas = active_personas(&options.personas, record.as_ref().and_then(|r| r.members.as_deref()));
    let addressed = addressed_personas(&req.text, &personas);

    if record.as_ref().and_then(|r| r.members.as_ref()).is_some() && !add_hint(&req.text) {
        let outside: Vec<_> = mentioned_personas(&req.text, &options.personas)
            .into_iter()
            .filter(|p| !personas.iter().any(|a| a.name.eq_ignore_ascii_case(&p.name)))
            .collect();
        if !outside.is_empty() {
            let names = outside.iter().map(|p| format!("@{}", p.name)).collect::<Vec<_>>().join(", ");
            deliver_reply(
                req,
                deps,
                &format!("{names} aren't in this room. Ask to add them (e.g. \"agregá a {names}\")."),
                None,
                None,
            )
            .await;
            if addressed.is_empty() {
                return Ok(true);
            }
        }
    }

    if !addressed.is_empty() && !has_question(&req.thread_key) && record.as_ref().and_then(|r| r.pending_questions.as_ref()).is_none()
    {
        let first: Vec<Persona> = addressed.into_iter().cloned().collect();
        if options.parallel_room {
            // Fan-out: each mentioned agent answers on its own lane; a busy one is steered or waits its turn.
            let rounds = first.iter().map(|p| async {
                if steer_persona(req, deps, p).await {
                    return Ok(true);
                }
                persona_round(req, deps, std::slice::from_ref(p), &personas, PersonaOpts::default()).await
            });
            let results = futures::future::join_all(rounds).await;
            for r in results {
                r?;
            }
            return Ok(true);
        }
        return persona_round(req, deps, &first, &personas, PersonaOpts::default()).await;
    }

    let parked = take_question(&req.thread_key);
    let workdir = record
        .as_ref()
        .and_then(|r| r.worktree.clone())
        .unwrap_or_else(|| deps.config.lock().unwrap().workdir.clone());
    let driver_kind = record
        .as_ref()
        .and_then(|r| r.driver)
        .unwrap_or(options.default_driver);
    let model = record
        .as_ref()
        .and_then(|r| r.model.clone())
        .or(options.default_model.clone());

    let result = if let Some(parked) = parked {
        parked.resume(req.text.clone()).await
    } else {
        let text = if let Some(qs) = record.as_ref().and_then(|r| r.pending_questions.as_ref()) {
            continuation(qs, &req.text, req.sender.as_deref())
        } else {
            let mut text = if let Some(s) = &req.sender {
                format!("{s}: {}", req.text)
            } else {
                req.text.clone()
            };
            let topics = consult_topics(&req.text, &personas);
            if !topics.is_empty() {
                text.push_str(&format!(
                    "\n\n[Room] Agents you can bring into this discussion: {}. Write @name to ask them now.",
                    topics.iter().map(|p| format!("@{}", p.name)).collect::<Vec<_>>().join(", ")
                ));
            }
            if let Some(room_n) = req.room_n {
                text = format!(
                    "{}{text}",
                    room_catch_up(
                        record.as_ref().and_then(|r| r.room.as_deref()),
                        BOT_NAME,
                        record
                            .as_ref()
                            .and_then(|r| r.room_seen.as_ref())
                            .and_then(|m| m.get(BOT_NAME).copied()),
                        room_n,
                    )
                );
                mark_seen(deps, &req.thread_key, &req.space_name, BOT_NAME, room_n).await;
            }
            let prompt_now = options.host_prompt.clone().unwrap_or_default();
            let prompt_now = prompt_now.trim().to_string();
            let seen = record.as_ref().and_then(|r| r.host_prompt_seen.clone());
            let deliver_switchboard = !personas.is_empty()
                || record.as_ref().and_then(|r| r.host_roster.as_ref()).is_some()
                || !prompt_now.is_empty()
                || seen.is_some();
            if deliver_switchboard {
                let names: Vec<String> = personas.iter().map(|p| p.name.clone()).collect();
                let fresh = record.as_ref().and_then(|r| r.session_ref.as_ref()).is_none();
                if fresh {
                    text = format!("{}\n\n---\n\n{text}", host_preamble(&personas, options.host_prompt.as_deref()));
                } else if let Some(before) = record.as_ref().and_then(|r| r.host_roster.as_deref()) {
                    text.push_str(&roster_update(Some(before), &personas));
                    text.push_str(&switchboard_update(seen.as_deref(), &prompt_now));
                } else if record.as_ref().and_then(|r| r.host_roster.as_ref()).is_none() && !personas.is_empty() {
                    text.push_str(&format!("\n\n{}", host_preamble(&personas, options.host_prompt.as_deref())));
                } else {
                    text.push_str(&switchboard_update(seen.as_deref(), &prompt_now));
                }
                let _ = deps
                    .store
                    .update(
                        &req.thread_key,
                        &req.space_name,
                        SessionPatch {
                            host_roster: Some(Some(names)),
                            host_prompt_seen: Some(Some(prompt_now)),
                            ..Default::default()
                        },
                    )
                    .await;
            }
            if let Some(summary) = record.as_ref().filter(|r| r.session_ref.is_none()).and_then(|r| r.summary.as_deref()) {
                text = format!("{COMPACTED_HEADER}
{summary}

---

{text}");
            }
            text
        };

        let _speaking = Speaking::start(&req.thread_key, BOT_NAME);
        deps.driver
            .run_turn(AgentTurnInput {
                thread_key: req.thread_key.clone(),
                session_ref: record.as_ref().and_then(|r| r.session_ref.clone()),
                text,
                workdir,
                model,
                agent: None,
                driver: Some(driver_kind),
                answer_questions: true,
                request_id: req.request_id.clone(),
                mcps_override: None,
                instructions_override: None,
                effort: None,
            })
            .await
    };

    match result {
        Ok(out) => {
            if let Some(pending) = out.pending {
                let questions = pending.questions.clone();
                hold_question(&req.thread_key, pending);
                let _ = deps
                    .store
                    .update(
                        &req.thread_key,
                        &req.space_name,
                        SessionPatch {
                            session_ref: Some(out.session_ref.clone()),
                            pending_questions: Some(Some(questions.clone())),
                            ..Default::default()
                        },
                    )
                    .await;
                deliver_reply(req, deps, &out.reply, None, Some(&questions)).await;
                mark(deps, req.request_id.as_deref(), crate::turn_ledger::TurnState::Posted).await;
                return Ok(true);
            }

            crate::usage::note(&req.thread_key, BOT_NAME, out.session_ref.as_deref(), out.usage.as_ref());
            let turns = record.as_ref().and_then(|r| r.turns).unwrap_or(0) + 1;
            let (context_tokens, context_window, estimated) = match &out.usage {
                Some(u) => (Some(Some(u.context_tokens)), u.context_window.map(Some), Some(Some(false))),
                None => {
                    let prev = record.as_ref().filter(|r| r.estimated != Some(false)).and_then(|r| r.context_tokens).unwrap_or(0);
                    let add = ((req.text.len() + out.reply.len()).div_ceil(4)) as u64;
                    (Some(Some(prev + add)), None, Some(Some(true)))
                }
            };
            let mut reply = out.reply;
            let _ = deps
                .store
                .update(
                    &req.thread_key,
                    &req.space_name,
                    SessionPatch {
                        session_ref: Some(out.session_ref.clone()),
                        turns: Some(Some(turns)),
                        pending_questions: Some(None),
                        context_tokens,
                        context_window,
                        estimated,
                        cost_usd: out.usage.as_ref().and_then(|u| u.cost_usd).map(Some),
                        tokens_per_sec: Some(out.usage.as_ref().and_then(|u| u.tokens_per_sec)),
                        summary: Some(None),
                        ..Default::default()
                    },
                )
                .await;
            if !is_pass(&reply) {
                if let Some(rec) = deps.store.get(&req.thread_key) {
                    if should_show_footer(options.context_footer, &rec) {
                        reply.push_str(&context_line(&rec, &options));
                    }
                }
                deliver_reply(req, deps, &reply, None, None).await;
                mark(deps, req.request_id.as_deref(), crate::turn_ledger::TurnState::Posted).await;
            }
            let pct = deps.store.get(&req.thread_key).as_ref().and_then(context_percent);
            if let Some(pct) = pct.filter(|p| options.auto_compact_at > 0 && *p >= options.auto_compact_at as u64) {
                let note = compact(&req.thread_key, &req.space_name, deps).await.unwrap_or_else(|e| format!("Compaction failed: {e}"));
                deliver_reply(req, deps, &format!("Context at {pct}% — compacting automatically.
{note}"), None, None).await;
            }

            let room_now = active_personas(
                &options.personas,
                deps.store.get(&req.thread_key).as_ref().and_then(|r| r.members.as_deref()),
            );
            let topics: Vec<Persona> = consult_topics(&req.text, &room_now).into_iter().cloned().collect();
            if !topics.is_empty() {
                let _ = persona_round(
                    req,
                    deps,
                    &topics,
                    &room_now,
                    PersonaOpts {
                        host_reply: Some(reply.clone()),
                        consult: true,
                        ..Default::default()
                    },
                )
                .await;
            } else {
                let asked: Vec<Persona> = asked_personas(&reply, &room_now)
                .into_iter()
                .filter(|p| hears_reply(p, &reply))
                .cloned()
                .collect();
                if !asked.is_empty() {
                    let _ = persona_round(
                        req,
                        deps,
                        &asked,
                        &room_now,
                        PersonaOpts {
                            ask: true,
                            ..Default::default()
                        },
                    )
                    .await;
                }
            }
            Ok(true)
        }
        Err(err) => {
            let _ = deps
                .store
                .update(
                    &req.thread_key,
                    &req.space_name,
                    SessionPatch {
                        pending_questions: Some(None),
                        ..Default::default()
                    },
                )
                .await;
            deliver_reply(req, deps, &format!("Agent error: {err}"), None, None).await;
            Ok(false)
        }
    }
}

#[derive(Default)]
struct PersonaOpts {
    optional: bool,
    host_reply: Option<String>,
    ask: bool,
    consult: bool,
}

pub const RESUME_PROMPT: &str = "Continue where you left off; you were paused.";

/// Reruns a paused agent's turn on its own persona session.
pub async fn resume_agent(mut req: TurnRequest, deps: Arc<HandlerDeps>, agent: &str) -> Result<bool, String> {
    let Some(was) = crate::personas::take_paused(&req.thread_key, agent) else {
        return Ok(false);
    };
    let key = req.thread_key.clone();
    let deps2 = deps.clone();
    deps.queue
        .run(&key, || async move {
            let deps = deps2;
            let record = deps.store.get(&req.thread_key);
            let options = (deps.options)();
            let personas = active_personas(&options.personas, record.as_ref().and_then(|r| r.members.as_deref()));
            let Some(p) = personas.iter().find(|p| p.name.eq_ignore_ascii_case(agent)).cloned() else {
                return Ok(false);
            };
            // ponytail: the paused text is repeated because a first-turn pause never got a session to resume.
            req.text = if was.is_empty() { RESUME_PROMPT.to_string() } else { format!("{RESUME_PROMPT}\n\nYou were working on:\n{was}") };
            req.sender = None;
            persona_round(&req, &deps, std::slice::from_ref(&p), &personas, PersonaOpts::default()).await
        })
        .await
}

async fn persona_round(
    req: &TurnRequest,
    deps: &HandlerDeps,
    first: &[Persona],
    all: &[Persona],
    opts: PersonaOpts,
) -> Result<bool, String> {
    if first.is_empty() {
        return Ok(true);
    }
    let since = crate::personas::stop_mark();
    let dialogue = !opts.optional && !opts.ask && (first.len() >= 2 || opts.consult);
    let max_hops = if dialogue { MAX_DIALOGUE_HOPS } else { MAX_HOPS };
    let peers: Vec<&Persona> = if dialogue {
        first
            .iter()
            .filter(|p| p.respond_to.as_deref() != Some("people"))
            .collect()
    } else {
        Vec::new()
    };
    let said = match &req.sender {
        Some(s) => format!("{s}: {}", req.text),
        None => req.text.clone(),
    };
    let mut queue: Vec<PersonaItem> = if opts.consult {
        vec![PersonaItem {
            persona: first[0].clone(),
            text: consult_open(&said, opts.host_reply.as_deref().unwrap_or("")),
            hop: 0,
            asked_by: None,
            optional: false,
        }]
    } else if dialogue {
        let refs: Vec<&Persona> = first.iter().collect();
        vec![PersonaItem {
            persona: first[0].clone(),
            text: dialogue_open(&said, &refs),
            hop: 0,
            asked_by: None,
            optional: false,
        }]
    } else {
        first
            .iter()
            .map(|p| PersonaItem {
                persona: p.clone(),
                text: if opts.optional {
                    room_prompt(&said)
                } else {
                    said.clone()
                },
                hop: 0,
                asked_by: None,
                optional: opts.optional,
            })
            .collect()
    };

    let mut idx = 0;
    let mut hops_done = 0;
    let mut interjections = 0;
    let upcoming_round = Upcoming::new(&req.thread_key);
    while idx < queue.len() && hops_done < max_hops + first.len() {
        upcoming_round.set(queue[idx + 1..].iter().map(|q| q.persona.name.clone()).collect());
        if opts.optional && crate::personas::stop_requested(&req.thread_key, since) {
            break;
        }
        if crate::personas::stop_requested(&req.thread_key, since) {
            let left: Vec<_> = queue[idx..].iter().map(|q| format!("@{}", q.persona.name)).collect();
            deliver_reply(
                req,
                deps,
                &format!("Stopped. {} did not answer.", left.join(", ")),
                None,
                None,
            )
            .await;
            break;
        }
        let item = queue[idx].clone();
        idx += 1;
        if crate::personas::agent_stopped(&req.thread_key, &item.persona.name, since) {
            continue;
        }
        let record = deps.store.get(&req.thread_key);
        let session_ref = record
            .as_ref()
            .and_then(|r| r.persona_sessions.as_ref())
            .and_then(|m| m.get(&item.persona.name).cloned());
        let names: Vec<String> = all.iter().map(|p| p.name.clone()).collect();
        let update = if session_ref.is_some() {
            roster_update(
                record
                    .as_ref()
                    .and_then(|r| r.persona_roster.as_ref())
                    .and_then(|m| m.get(&item.persona.name))
                    .map(|v| v.as_slice()),
                all,
            )
        } else {
            String::new()
        };
        let who = format!("@{}", item.persona.name);
        let catch_up = if let Some(room_n) = req.room_n {
            let seen = record
                .as_ref()
                .and_then(|r| r.room_seen.as_ref())
                .and_then(|m| m.get(&who).copied());
            room_catch_up(
                record.as_ref().and_then(|r| r.room.as_deref()),
                &who,
                seen,
                room_n,
            )
        } else {
            String::new()
        };
        if let Some(room_n) = req.room_n {
            mark_seen(deps, &req.thread_key, &req.space_name, &who, room_n).await;
        }
        let preamble = if session_ref.is_none() {
            format!("{}\n\n---\n\n", persona_preamble(&item.persona, all))
        } else {
            String::new()
        };
        let workdir = record
            .as_ref()
            .and_then(|r| r.worktree.clone())
            .unwrap_or_else(|| deps.config.lock().unwrap().workdir.clone());
        let round_tag = if item.optional { "#room" } else { "" };
        let persona_request = req.request_id.as_ref().map(|r| format!("{r}#{}#{}{round_tag}", item.persona.name, item.hop));
        if let (Some(ledger), Some(id)) = (&deps.ledger, &persona_request) {
            ledger.begin_persona(id, &req.thread_key, &item.persona.name, &req.space_name, req.thread.clone(), &item.text).await;
        }
        let _turn = persona_lock(&req.thread_key, &item.persona.name).lock_owned().await;
        let talking = Speaking::start(&req.thread_key, &format!("@{}", item.persona.name));
        let result = deps
            .driver
            .run_turn(AgentTurnInput {
                thread_key: format!("{}#{}", req.thread_key, item.persona.name),
                session_ref,
                text: format!("{preamble}{catch_up}{}{update}", item.text),
                workdir,
                model: item.persona.model.clone().or_else(|| {
                    if item.persona.driver.is_some() {
                        None
                    } else {
                        record.as_ref().and_then(|r| r.model.clone())
                    }
                }),
                agent: item.persona.agent.clone(),
                driver: item.persona.driver.or(record.as_ref().and_then(|r| r.driver)),
                answer_questions: false,
                request_id: persona_request.clone(),
                mcps_override: None,
                instructions_override: None,
                effort: item.persona.effort.clone(),
            })
            .await;
        drop(talking);
        let state = if result.is_ok() { crate::turn_ledger::TurnState::Posted } else { crate::turn_ledger::TurnState::Failed };
        mark(deps, persona_request.as_deref(), state).await;
        let reply = match result {
            Ok(out) => {
                let reply = strip_self_prefix(&out.reply, &item.persona);
                if is_pass(&reply) {
                    continue;
                }
                if item.optional {
                    interjections += 1;
                    if interjections > MAX_INTERJECTIONS {
                        continue;
                    }
                }
                crate::usage::note(&req.thread_key, &item.persona.name, out.session_ref.as_deref(), out.usage.as_ref());
                // One atomic edit: concurrent rounds save other agents on the same record.
                let name = item.persona.name.clone();
                let _ = deps
                    .store
                    .modify(&req.thread_key, &req.space_name, |r| {
                        if let Some(s) = out.session_ref {
                            r.persona_sessions.get_or_insert_with(Default::default).insert(name.clone(), s);
                        }
                        r.persona_roster.get_or_insert_with(Default::default).insert(name.clone(), names);
                        let usage = r.persona_usage.get_or_insert_with(Default::default);
                        let next = crate::session::persona_usage_after(usage.get(&name), out.usage.as_ref(), item.text.len(), reply.len());
                        usage.insert(name, next);
                    })
                    .await;
                deliver_reply(req, deps, &reply, Some(&item.persona.name), None).await;
                reply
            }
            Err(_) if crate::personas::agent_stopped(&req.thread_key, &item.persona.name, since) => {
                // A deliberate stop or pause aborted the run: not a failure.
                crate::personas::note_paused_text(&req.thread_key, &item.persona.name, &item.text);
                continue;
            }
            Err(err) => {
                deliver_reply(
                    req,
                    deps,
                    &format!("@{} failed: {err}", item.persona.name),
                    Some(&item.persona.name),
                    None,
                )
                .await;
                continue;
            }
        };

        hops_done += 1;
        if item.optional {
            if interjections >= MAX_INTERJECTIONS {
                break;
            }
            continue;
        }
        if item.hop >= max_hops {
            continue;
        }
        let next_asked: Vec<&Persona> = if dialogue || opts.consult {
            mentioned_personas(&reply, all)
                .into_iter()
                .filter(|p| {
                    p.name != item.persona.name
                        && item.asked_by.as_ref().map(|a| a.name.as_str()) != Some(p.name.as_str())
                })
                .collect()
        } else {
            asked_personas(&reply, all)
                .into_iter()
                .filter(|p| hears_reply(p, &reply))
                .filter(|p| {
                    p.name != item.persona.name
                        && item.asked_by.as_ref().map(|a| a.name.as_str()) != Some(p.name.as_str())
                })
                .collect()
        };
        let next_empty = next_asked.is_empty();
        for next in next_asked {
            if next.respond_to.as_deref() == Some("people") && item.hop > 0 && item.asked_by.is_some() {
                continue;
            }
            if let Some(waiting) = queue.iter_mut().find(|q| q.persona.name == next.name) {
                waiting.text = format!("{}\n\n@{}: {reply}", waiting.text, item.persona.name);
                if waiting.asked_by.is_none() {
                    waiting.asked_by = Some(item.persona.clone());
                }
            } else {
                queue.push(PersonaItem {
                    persona: (*next).clone(),
                    text: format!("@{}: {reply}", item.persona.name),
                    hop: item.hop + 1,
                    asked_by: Some(item.persona.clone()),
                    optional: false,
                });
            }
        }
        if !opts.optional
            && !opts.ask
            && item.hop == 0
            && next_empty
            && (mentions_bot(&reply) || opts.consult)
        {
            let host_text = host_continue(req, deps, &format!("@{}: {reply}", item.persona.name)).await;
            if let Some(host_text) = host_text {
                if item.hop + 1 < max_hops {
                    let next = peers
                        .iter()
                        .find(|p| p.name != item.persona.name)
                        .copied()
                        .unwrap_or(&item.persona);
                    queue.push(PersonaItem {
                        persona: next.clone(),
                        text: dialogue_pass(BOT_NAME, &host_text),
                        hop: item.hop + 1,
                        asked_by: None,
                        optional: false,
                    });
                }
            }
        } else if dialogue && next_empty && peers.len() > 1 {
            let is_floor = item.text.starts_with("[Discussion] @")
                || item.text.starts_with("[Consultation]");
            if item.hop == 0 || is_floor {
                if let Some(next) = peers.iter().find(|p| {
                    p.name != item.persona.name && !queue.iter().any(|q| q.persona.name == p.name)
                }) {
                    queue.push(PersonaItem {
                        persona: (**next).clone(),
                        text: dialogue_pass(&item.persona.name, &reply),
                        hop: item.hop + 1,
                        asked_by: Some(item.persona.clone()),
                        optional: false,
                    });
                }
            }
        }
    }
    Ok(true)
}

#[derive(Clone)]
struct PersonaItem {
    persona: Persona,
    text: String,
    hop: usize,
    asked_by: Option<Persona>,
    optional: bool,
}

async fn host_continue(req: &TurnRequest, deps: &HandlerDeps, text: &str) -> Option<String> {
    let record = deps.store.get(&req.thread_key);
    let workdir = record
        .as_ref()
        .and_then(|r| r.worktree.clone())
        .unwrap_or_else(|| deps.config.lock().unwrap().workdir.clone());
    let options = (deps.options)();
    match deps
        .driver
        .run_turn(AgentTurnInput {
            thread_key: req.thread_key.clone(),
            session_ref: record.as_ref().and_then(|r| r.session_ref.clone()),
            text: text.to_string(),
            workdir,
            model: record.as_ref().and_then(|r| r.model.clone()).or(options.default_model),
            agent: None,
            driver: record.as_ref().and_then(|r| r.driver).or(Some(options.default_driver)),
            answer_questions: false,
            request_id: None,
            mcps_override: None,
            instructions_override: None,
            effort: None,
        })
        .await
    {
        Ok(out) => {
            deliver_reply(req, deps, &out.reply, None, None).await;
            let _ = deps
                .store
                .update(
                    &req.thread_key,
                    &req.space_name,
                    SessionPatch {
                        session_ref: Some(out.session_ref),
                        ..Default::default()
                    },
                )
                .await;
            Some(out.reply)
        }
        Err(_) => None,
    }
}

async fn room_log(deps: &HandlerDeps, thread_key: &str, space: &str, author: &str, text: &str) -> u64 {
    let n = deps
        .store
        .modify(thread_key, space, |r| {
            let next = room_append(r.room.as_deref(), author, text);
            let n = next.last().map(|e| e.n).unwrap_or(0);
            r.room = Some(next);
            n
        })
        .await;
    n.unwrap_or(0)
}

async fn mark_seen(deps: &HandlerDeps, thread_key: &str, space: &str, who: &str, n: u64) {
    let _ = deps
        .store
        .modify(thread_key, space, |r| {
            r.room_seen.get_or_insert_with(Default::default).insert(who.to_string(), n);
        })
        .await;
}

/// The slash command a message invokes, if any. A first token with another `/` is a path, not a command.
pub fn command_of(text: &str) -> Option<&str> {
    let rest = text.trim_start().strip_prefix('/')?;
    let cmd = rest.split_whitespace().next().filter(|_| !rest.starts_with(char::is_whitespace))?;
    (!cmd.contains('/')).then_some(cmd)
}

async fn run_command(req: &TurnRequest, deps: &HandlerDeps) -> Result<String, String> {
    let cmd = command_of(&req.text).unwrap_or("");
    let args: Vec<&str> = req.text.split_whitespace().skip(1).collect();
    match cmd {
        "help" => Ok("Commands: /help /clear [@agent] /compact /context /model /stop /agents /invite <agent> /kick <agent> /approve <id> /deny <id> /topic <text> /repo <name...> /status /up [repo] /down /logs /close [repo] /flow <id> /spend-continue".into()),
        "spend-continue" => {
            deps.store
                .update(&req.thread_key, &req.space_name, SessionPatch { spend_override: Some(Some(true)), ..Default::default() })
                .await?;
            Ok("This thread can keep going past the spend cap.".into())
        }
        "flow" => {
            let id = args.first().copied().ok_or("Usage: /flow <id>")?;
            let settings = crate::settings::global().ok_or("settings are not loaded")?.get();
            let flow = settings.flows.iter().find(|f| f.id == id).ok_or_else(|| format!("unknown flow {id}"))?;
            if flow.steps.is_empty() {
                return Err(format!("flow {id} has no steps"));
            }
            for step in &flow.steps {
                crate::team::apply_member_op(deps, &req.thread_key, "add", crate::team::TeamMemberInput::Agent { persona: step.agent.clone() }).await?;
            }
            deps.store
                .update(
                    &req.thread_key,
                    &req.space_name,
                    SessionPatch {
                        flow: Some(Some(FlowCursor { id: flow.id.clone(), step: 0, hold: false, task: Some(args[1..].join(" ")).filter(|t| !t.trim().is_empty()) })),
                        ..Default::default()
                    },
                )
                .await?;
            Ok(format!("Starting {}.", flow.name))
        }
        "stop" => {
            request_stop(&req.thread_key);
            crate::pi_sidecar::abort(&req.thread_key).await;
            Ok("Stopped the running agents.".into())
        }
        "compact" => compact(&req.thread_key, &req.space_name, deps).await,
        "clear" => clear_command(&args, req, deps).await,
        "context" => {
            let options = (deps.options)();
            match deps.store.get(&req.thread_key) {
                Some(r) => Ok(context_line(&r, &options).trim_start_matches('\n').to_string()),
                None => Ok("No session yet.".into()),
            }
        }
        "model" => {
            let model = args.first().map(|s| (*s).to_string());
            deps.store
                .update(
                    &req.thread_key,
                    &req.space_name,
                    SessionPatch {
                        model: Some(model.clone()),
                        ..Default::default()
                    },
                )
                .await?;
            Ok(match model {
                Some(m) => format!("Model set to {m}"),
                None => "Model cleared.".into(),
            })
        }
        "agent" => Err("Only Pi is available — use /model to set the model.".into()),
        "repo" | "status" | "up" | "down" | "logs" | "close" => repo_command(cmd, &args, req, deps).await,
        "topic" => {
            let title = args.join(" ");
            set_title(req, deps, Some(title.clone()).filter(|t| !t.trim().is_empty())).await?;
            Ok(if title.trim().is_empty() { "Topic cleared.".into() } else { format!("Topic set: {title}") })
        }
        "approve" | "deny" if args.first().is_some_and(|id| id.starts_with('g')) => {
            let approve = cmd == "approve";
            let info = crate::gate::decide(args[0], approve).ok_or_else(|| format!("No pending approval {}.", args[0]))?;
            Ok(crate::gate::decided_text(&info, approve, req.sender.as_deref()))
        }
        "approve" | "deny" => {
            let scheduler = deps.scheduler.get().ok_or("Schedules are not enabled on this bridge.")?;
            let id = args.first().ok_or_else(|| format!("Usage: /{cmd} <id>"))?;
            let job = scheduler.decide(id, cmd == "approve", chrono::Local::now()).await?;
            Ok(if cmd == "approve" { format!("Approved: {} ran ({}).", job.name, job.last_status.unwrap_or_default()) } else { format!("Denied: {} will not run.", job.name) })
        }
        "agents" => {
            let record = deps.store.get(&req.thread_key);
            let members = crate::team::effective_members(record.as_ref(), &(deps.options)().personas);
            let lines: Vec<String> = crate::team::presence(&members, &speaking(&req.thread_key), false, record.as_ref().and_then(|r| r.room_seen.as_ref()))
                .into_iter()
                .map(|p| format!("{} · {}", p.name, p.status))
                .collect();
            Ok(lines.join("
"))
        }
        "invite" | "kick" => {
            let persona = args.first().ok_or_else(|| format!("Usage: /{cmd} <agent>"))?.trim_start_matches('@').to_string();
            let op = if cmd == "invite" { "add" } else { "remove" };
            crate::team::apply_member_op(deps, &req.thread_key, op, crate::team::TeamMemberInput::Agent { persona: persona.clone() }).await?;
            Ok(if op == "add" { format!("@{persona} joined the room.") } else { format!("@{persona} left the room.") })
        }
        _ => {
            let jobs = deps.scheduler.get().map(|s| s.jobs_for_command(cmd, &req.space_name).into_iter().chain(s.jobs_for_command(cmd, &req.thread_key)).collect::<Vec<_>>()).unwrap_or_default();
            if jobs.is_empty() {
                return Err(format!("unknown command /{cmd}"));
            }
            Ok(fire_jobs(deps, jobs, &format!("/{cmd} in chat")).await.join("\n"))
        }
    }
}

pub async fn set_thread_title(deps: &HandlerDeps, thread_key: &str, title: &str) -> Result<String, String> {
    let clean: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean: String = clean.chars().take(200).collect();
    thread_command(deps, thread_key, &format!("/topic {clean}")).await
}

async fn set_title(req: &TurnRequest, deps: &HandlerDeps, title: Option<String>) -> Result<(), String> {
    deps.store
        .update(&req.thread_key, &req.space_name, SessionPatch { title: Some(title), ..Default::default() })
        .await
}

pub fn delegates_for<'a>(caller: &Persona, all: &'a [Persona]) -> Vec<&'a Persona> {
    all.iter()
        .filter(|p| !p.name.eq_ignore_ascii_case(&caller.name))
        .filter(|p| caller.delegates.is_empty() || caller.delegates.iter().any(|d| d.eq_ignore_ascii_case(&p.name)))
        .collect()
}

pub async fn ask_persona(deps: &HandlerDeps, thread_key: &str, agent: &str, question: &str) -> Result<String, String> {
    let options = (deps.options)();
    let (base, caller) = thread_key.rsplit_once('#').ok_or("ask_agent works from an agent's turn")?;
    let caller = options.personas.iter().find(|p| p.name.eq_ignore_ascii_case(caller)).ok_or("unknown calling agent")?;
    if !crate::skills::mcps(caller).iter().any(|m| m == "agents") {
        return Err(format!("@{} cannot ask other agents (add the agents tool)", caller.name));
    }
    let target = delegates_for(caller, &options.personas)
        .into_iter()
        .find(|p| p.name.eq_ignore_ascii_case(agent.trim_start_matches('@')))
        .ok_or_else(|| format!("@{} cannot ask @{agent}", caller.name))?
        .clone();
    let record = deps.store.get(base);
    let key = format!("{base}#{}", target.name);
    let session = record.as_ref().and_then(|r| r.persona_sessions.as_ref()).and_then(|m| m.get(&target.name).cloned());
    let preamble = if session.is_none() { format!("{}\n\n---\n\n", persona_preamble(&target, &options.personas)) } else { String::new() };
    let _talking = Speaking::start(base, &format!("@{}", target.name));
    let out = deps
        .driver
        .run_turn(AgentTurnInput {
            thread_key: key,
            session_ref: session,
            text: format!("{preamble}@{} asks you: {question}", caller.name),
            workdir: record.as_ref().and_then(|r| r.worktree.clone()).unwrap_or_else(|| deps.config.lock().unwrap().workdir.clone()),
            model: target.model.clone(),
            agent: target.agent.clone(),
            driver: target.driver,
            answer_questions: false,
            request_id: None,
            mcps_override: None,
            instructions_override: None,
            effort: None,
        })
        .await?;
    let space = record.as_ref().map(|r| r.space.clone()).unwrap_or_else(|| "team-chat".into());
    let mut sessions = record.as_ref().and_then(|r| r.persona_sessions.clone()).unwrap_or_default();
    crate::usage::note(thread_key, &target.name, out.session_ref.as_deref(), out.usage.as_ref());
    if let Some(s) = out.session_ref {
        sessions.insert(target.name.clone(), s);
    }
    let mut usage_map = record.as_ref().and_then(|r| r.persona_usage.clone()).unwrap_or_default();
    let prev = usage_map.get(&target.name).cloned();
    usage_map.insert(
        target.name.clone(),
        crate::session::persona_usage_after(prev.as_ref(), out.usage.as_ref(), question.len(), out.reply.len()),
    );
    let _ = deps
        .store
        .update(
            base,
            &space,
            SessionPatch {
                persona_sessions: Some(if sessions.is_empty() { None } else { Some(sessions) }),
                persona_usage: Some(Some(usage_map)),
                ..Default::default()
            },
        )
        .await;
    note(deps, "agent_ask", base, format!("@{} asked @{}", caller.name, target.name), question.chars().take(120).collect::<String>()).await;
    Ok(out.reply)
}

pub async fn thread_command(deps: &HandlerDeps, thread_key: &str, text: &str) -> Result<String, String> {
    let space = deps.store.get(thread_key).map(|r| r.space).unwrap_or_else(|| "team-chat".into());
    let req = TurnRequest {
        thread_key: thread_key.to_string(),
        space_name: space,
        text: text.to_string(),
        sender: None,
        reply_via_chat: false,
        thread: None,
        room_n: None,
        captured_replies: None,
        reply_sink: None,
        request_id: None,
    };
    run_command(&req, deps).await
}

pub async fn fire_jobs(deps: &HandlerDeps, mut jobs: Vec<crate::schedules::Job>, reason: &str) -> Vec<String> {
    jobs.sort_by(|a, b| a.id.cmp(&b.id));
    jobs.dedup_by(|a, b| a.id == b.id);
    let Some(scheduler) = deps.scheduler.get().cloned() else { return Vec::new() };
    let mut out = Vec::new();
    for job in jobs {
        if job.needs_approval {
            match scheduler.trigger(&job.id, reason, chrono::Local::now()).await {
                Ok(j) => {
                    let id = j.pending.map(|p| p.id).unwrap_or_default();
                    out.push(format!("{} needs approval: /approve {id} or /deny {id}", j.name));
                }
                Err(e) => out.push(format!("{} could not start: {e}", job.name)),
            }
        } else {
            let (scheduler, id, reason) = (scheduler.clone(), job.id.clone(), reason.to_string());
            tokio::spawn(async move {
                let _ = scheduler.trigger(&id, &reason, chrono::Local::now()).await;
            });
            out.push(format!("Running {}.", job.name));
        }
    }
    out
}

const COMPACT_PROMPT: &str = "Summarize this conversation so a fresh session can continue it: goals, decisions made, current state of the code and worktree, open tasks and open questions. Be concise; no preamble.";
const COMPACTED_HEADER: &str = "Context from earlier in this thread (compacted):";

async fn clear_command(args: &[&str], req: &TurnRequest, deps: &HandlerDeps) -> Result<String, String> {
    crate::question_gate::cancel_question(&req.thread_key);
    if let Some(raw) = args.first() {
        let want = raw.trim_start_matches('@');
        if want.is_empty() {
            return Err("Usage: /clear [@agent]".into());
        }
        let record = deps.store.get(&req.thread_key);
        let mut sessions = record.as_ref().and_then(|r| r.persona_sessions.clone()).unwrap_or_default();
        let mut roster = record.as_ref().and_then(|r| r.persona_roster.clone()).unwrap_or_default();
        let mut usage = record.as_ref().and_then(|r| r.persona_usage.clone()).unwrap_or_default();
        let key = sessions
            .keys()
            .chain(roster.keys())
            .chain(usage.keys())
            .find(|k| k.eq_ignore_ascii_case(want))
            .cloned()
            .unwrap_or_else(|| want.to_string());
        let before_sessions = sessions.len();
        let before_roster = roster.len();
        let before_usage = usage.len();
        sessions.retain(|k, _| !k.eq_ignore_ascii_case(want));
        roster.retain(|k, _| !k.eq_ignore_ascii_case(want));
        usage.retain(|k, _| !k.eq_ignore_ascii_case(want));
        if sessions.len() == before_sessions && roster.len() == before_roster && usage.len() == before_usage {
            return Ok(format!("No session for @{want} yet."));
        }
        deps.store
            .update(
                &req.thread_key,
                &req.space_name,
                SessionPatch {
                    persona_sessions: Some(if sessions.is_empty() { None } else { Some(sessions) }),
                    persona_roster: Some(if roster.is_empty() { None } else { Some(roster) }),
                    persona_usage: Some(if usage.is_empty() { None } else { Some(usage) }),
                    ..Default::default()
                },
            )
            .await?;
        return Ok(format!("Started a fresh session for @{key}. Repo and members are untouched."));
    }
    let session = deps.store.get(&req.thread_key).and_then(|r| r.session_ref);
    let kept = match &session {
        Some(s) => matches!(deps.driver.reset(s).await, Some(Ok(()))),
        None => false,
    };
    deps.store
        .update(
            &req.thread_key,
            &req.space_name,
            SessionPatch {
                session_ref: if kept { None } else { Some(None) },
                summary: Some(None),
                context_tokens: Some(None),
                context_window: Some(None),
                estimated: Some(None),
                cost_usd: Some(None),
                turns: Some(None),
                pending_questions: Some(None),
                host_roster: Some(None),
                host_prompt_seen: Some(None),
                ..Default::default()
            },
        )
        .await?;
    Ok("Started a fresh session for this thread. Repo and members are untouched.".into())
}

async fn compact(thread_key: &str, space: &str, deps: &HandlerDeps) -> Result<String, String> {
    let record = deps.store.get(thread_key);
    let Some(session_ref) = record.as_ref().and_then(|r| r.session_ref.clone()) else {
        return Ok("Nothing to compact yet.".into());
    };
    crate::question_gate::cancel_question(thread_key);
    if let Some(native) = deps.driver.compact(&session_ref).await {
        let note = native?;
        deps.store
            .update(
                thread_key,
                space,
                SessionPatch {
                    context_tokens: Some(None),
                    estimated: Some(None),
                    ..Default::default()
                },
            )
            .await?;
        return Ok(note);
    }
    let before = record.as_ref().and_then(|r| r.context_tokens);
    let out = deps
        .driver
        .run_turn(AgentTurnInput {
            thread_key: thread_key.to_string(),
            session_ref: Some(session_ref),
            text: COMPACT_PROMPT.into(),
            workdir: record.as_ref().and_then(|r| r.worktree.clone()).unwrap_or_else(|| deps.config.lock().unwrap().workdir.clone()),
            model: record.as_ref().and_then(|r| r.model.clone()),
            agent: None,
            driver: record.as_ref().and_then(|r| r.driver),
            answer_questions: false,
            request_id: None,
            mcps_override: None,
            instructions_override: None,
            effort: None,
        })
        .await?;
    let after = out.reply.len().div_ceil(4) as u64;
    deps.store
        .update(
            thread_key,
            space,
            SessionPatch {
                session_ref: Some(None),
                summary: Some(Some(out.reply)),
                context_tokens: Some(Some(after)),
                estimated: Some(Some(true)),
                ..Default::default()
            },
        )
        .await?;
    Ok(match before {
        Some(b) => format!("Session compacted: ~{b} → ~{after} tokens. The next message continues from the summary."),
        None => "Session compacted. The next message continues from the summary.".into(),
    })
}

static SPEAKING: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

pub struct Speaking(String, String);

impl Speaking {
    pub fn start(thread_key: &str, who: &str) -> Self {
        let entry = (thread_key.to_string(), who.to_string());
        SPEAKING.lock().unwrap().push(entry.clone());
        Speaking(entry.0, entry.1)
    }
}

impl Drop for Speaking {
    fn drop(&mut self) {
        let mut list = SPEAKING.lock().unwrap();
        if let Some(i) = list.iter().position(|(k, w)| k == &self.0 && w == &self.1) {
            list.remove(i);
        }
    }
}

static UPCOMING: std::sync::Mutex<Vec<(String, u64, Vec<String>)>> = std::sync::Mutex::new(Vec::new());
static ROUND_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Upcoming(String, u64);

impl Upcoming {
    fn new(thread_key: &str) -> Self {
        Upcoming(thread_key.to_string(), ROUND_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }

    fn set(&self, names: Vec<String>) {
        let mut list = UPCOMING.lock().unwrap();
        list.retain(|(k, id, _)| !(k == &self.0 && *id == self.1));
        if !names.is_empty() {
            list.push((self.0.clone(), self.1, names));
        }
    }
}

impl Drop for Upcoming {
    fn drop(&mut self) {
        UPCOMING.lock().unwrap().retain(|(k, id, _)| !(k == &self.0 && *id == self.1));
    }
}

type PersonaLocks = std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>;
static PERSONA_LOCKS: std::sync::Mutex<Option<PersonaLocks>> = std::sync::Mutex::new(None);

fn persona_lock(thread_key: &str, persona: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut guard = PERSONA_LOCKS.lock().unwrap();
    guard
        .get_or_insert_with(Default::default)
        .entry(format!("{thread_key}#{}", persona.to_lowercase()))
        .or_default()
        .clone()
}

pub fn upcoming(thread_key: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in UPCOMING.lock().unwrap().iter().filter(|(k, _, _)| k == thread_key).flat_map(|(_, _, n)| n) {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(name)) {
            out.push(name.clone());
        }
    }
    out
}

pub fn speaking(thread_key: &str) -> Vec<String> {
    SPEAKING.lock().unwrap().iter().filter(|(k, _)| k == thread_key).map(|(_, w)| w.clone()).collect()
}

pub async fn note(deps: &HandlerDeps, kind: &str, thread_key: &str, title: impl Into<String>, detail: impl Into<String>) {
    if let Some(log) = &deps.activity {
        log.record(kind, thread_key, title, detail).await;
    }
}

pub fn thread_repos(record: Option<&crate::session::SessionRecord>) -> Vec<String> {
    record
        .and_then(|r| r.repo.as_deref())
        .map(|s| s.split(", ").filter(|x| !x.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

async fn set_repos(req: &TurnRequest, deps: &HandlerDeps, repos: &[String], dir: Option<String>, branch: Option<String>) -> Result<(), String> {
    let some = !repos.is_empty();
    let worktree = dir.filter(|_| some);
    let moved = deps.store.get(&req.thread_key).and_then(|r| r.worktree) != worktree;
    if moved {
        let _ = compact(&req.thread_key, &req.space_name, deps).await;
    }
    deps.store
        .update(
            &req.thread_key,
            &req.space_name,
            SessionPatch {
                repo: Some(some.then(|| repos.join(", "))),
                worktree: Some(worktree),
                branch: Some(branch.filter(|_| some)),
                persona_sessions: moved.then_some(None),
                ..Default::default()
            },
        )
        .await
}

async fn register_repo_path(ws: &Workspaces, raw: &str) -> Result<String, String> {
    let root = crate::workspace::git_root(raw).ok_or_else(|| format!("{raw} is not inside a git repository"))?;
    let root_s = root.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    if let Some(name) = ws.repo_for_path(&root_s) {
        return Ok(name);
    }
    let base = root.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_else(|| "repo".into());
    let base: String = base.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let taken = ws.repo_names();
    let name = (1..).map(|i| if i == 1 { base.clone() } else { format!("{base}-{i}") }).find(|n| !taken.contains(n)).unwrap();
    let repo = crate::config::RepoConfig { path: root_s, up: None, base: None };
    if let Some(store) = crate::settings::global() {
        let mut map = store.get().repos.clone();
        map.insert(name.clone(), repo.clone());
        store.update(crate::settings::SettingsPatch { repos: Some(map), ..Default::default() }).await?;
    }
    ws.register(&name, repo);
    Ok(name)
}

static OFFERED: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);

async fn offer_repo(req: &TurnRequest, deps: &HandlerDeps) {
    if command_of(&req.text).is_some() || deps.workspaces.is_none() {
        return;
    }
    let record = deps.store.get(&req.thread_key);
    if record.as_ref().and_then(|r| r.worktree.as_ref()).is_some() {
        return;
    }
    let Some(root) = crate::workspace::paths_in(&req.text).iter().find_map(|p| crate::workspace::git_root(p)) else { return };
    let root = root.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let key = format!("{}|{root}", req.thread_key);
    if !OFFERED.lock().unwrap().get_or_insert_with(Default::default).insert(key) {
        return;
    }
    let text = format!("This thread is chat-only, so the agent works on {root} directly, with no branch or worktree. Reply /repo {root} to pin it: the thread gets its own branch and worktree and the folder shows up in the control plane.");
    if req.reply_via_chat {
        let card = json!([{
            "cardId": "repo-offer",
            "card": {
                "header": { "title": "Use this repo for the thread?", "subtitle": root },
                "sections": [{ "widgets": [{ "buttonList": { "buttons": [{
                    "text": "Pin repo to this thread",
                    "onClick": { "action": { "function": "answerQuestion", "parameters": [{ "key": "answer", "value": format!("/repo {root}") }] } }
                }] } }] }]
            }
        }]);
        let body = PostMessageBody { text, thread: req.thread.clone(), cards_v2: Some(card) };
        let _ = deps.chat.post_message(&req.space_name, &body).await;
    } else {
        deliver_reply(req, deps, &text, None, None).await;
    }
}

async fn repo_command(cmd: &str, args: &[&str], req: &TurnRequest, deps: &HandlerDeps) -> Result<String, String> {
    let ws = deps.workspaces.clone().ok_or("No repos configured on this bridge.")?;
    let slug = slug_for(&req.thread_key);
    let record = deps.store.get(&req.thread_key);
    let mut repos = thread_repos(record.as_ref());
    let dir = ws.thread_dir(&slug).to_string_lossy().into_owned();
    let branch = format!("switchboard/{slug}");
    let worktree = record.as_ref().and_then(|r| r.worktree.clone());
    match cmd {
        "repo" if args.is_empty() => Ok(format!(
            "Usage: /repo <name> [name...]. Configured: {}. This thread: {}",
            ws.repo_names().join(", "),
            if repos.is_empty() { "none".into() } else { repos.join(", ") }
        )),
        "repo" => {
            let mut names = Vec::new();
            for arg in args {
                names.push(if crate::workspace::looks_like_path(arg) { register_repo_path(&ws, arg).await? } else { arg.to_string() });
            }
            for name in names {
                if repos.contains(&name) {
                    continue;
                }
                ws.create(&name, &slug).await?;
                repos.push(name);
            }
            set_repos(req, deps, &repos, Some(dir.clone()), Some(branch.clone())).await?;
            if record.as_ref().and_then(|r| r.title.as_ref()).is_none() {
                set_title(req, deps, Some(format!("{branch} · {}", repos.join(", ")))).await?;
            }
            note(deps, "repo_attach", &req.thread_key, branch.clone(), repos.join(", ")).await;
            Ok(format!("Worktrees ready in {dir}: {}
Branch: {branch}
The agent now works there for this thread.", repos.join(", ")))
        }
        "status" => Ok(match worktree {
            None => format!(
                "Chat only. Folder: {}\nWorking now: {}\nAgents can still read any path you give them; writing outside this folder asks for approval.\nPin a repo with /repo <name or path>. Configured: {}",
                deps.config.lock().unwrap().workdir,
                Some(speaking(&req.thread_key).join(", ")).filter(|s| !s.is_empty()).unwrap_or_else(|| "nobody".into()),
                Some(ws.repo_names().join(", ")).filter(|s| !s.is_empty()).unwrap_or_else(|| "none".into())
            ),
            Some(wt) => format!(
                "Repos: {}
Branch: {}
Folder: {wt}
App: {}",
                repos.join(", "),
                record.as_ref().and_then(|r| r.branch.clone()).unwrap_or_default(),
                ws.port(&slug).map(|p| format!("running on :{p}")).unwrap_or_else(|| "stopped".into())
            ),
        }),
        _ if repos.is_empty() => Err("No repos for this thread yet. Use /repo <name...> first.".into()),
        "up" => {
            let repo = args.first().map(|a| a.to_string()).unwrap_or_else(|| repos[0].clone());
            if !repos.contains(&repo) {
                return Err(format!("{repo} is not in this thread ({})", repos.join(", ")));
            }
            let path = repo_path(worktree.as_deref().unwrap_or(&dir), &repo);
            let port = ws.up(&slug, &repo, &path).await?;
            note(deps, "app_up", &req.thread_key, format!("{repo} on :{port}"), branch.clone()).await;
            Ok(format!("{repo} starting on http://localhost:{port} — /logs to follow it."))
        }
        "down" if ws.down(&slug) => {
            note(deps, "app_down", &req.thread_key, "App stopped", branch.clone()).await;
            Ok("App stopped.".into())
        }
        "down" => Ok("The app is not running.".into()),
        "logs" => Ok(Some(ws.logs(&slug, 200)).filter(|l| !l.is_empty()).unwrap_or_else(|| "(no output yet)".into())),
        _ => {
            let wt = worktree.unwrap_or(dir);
            match args.first() {
                Some(name) if repos.iter().any(|r| r == name) => {
                    ws.remove(name, &repo_path(&wt, name)).await?;
                    repos.retain(|r| r != name);
                    set_repos(req, deps, &repos, Some(wt), Some(branch)).await?;
                    Ok(format!("Worktree for {name} removed. The branch stays in the repo."))
                }
                Some(name) => Err(format!("{name} is not in this thread ({})", repos.join(", "))),
                None => {
                    ws.down(&slug);
                    ws.remove_thread(&wt).await?;
                    set_repos(req, deps, &[], None, None).await?;
                    Ok("Worktrees removed. Branches stay in their repos.".into())
                }
            }
        }
    }
}

fn repo_path(dir: &str, repo: &str) -> String {
    let nested = std::path::Path::new(dir).join(repo);
    if nested.exists() { nested.to_string_lossy().into_owned() } else { dir.to_string() }
}

fn context_percent(r: &crate::session::SessionRecord) -> Option<u64> {
    match (r.context_tokens, r.context_window) {
        (Some(t), Some(w)) if w > 0 => Some(t * 100 / w),
        _ => None,
    }
}

fn should_show_footer(mode: ContextFooter, r: &crate::session::SessionRecord) -> bool {
    match mode {
        ContextFooter::Never => false,
        ContextFooter::Every => true,
        ContextFooter::Every5 => r.turns.unwrap_or(0).is_multiple_of(5),
        ContextFooter::Above60 => context_percent(r).map(|p| p >= 60).unwrap_or(false),
    }
}

pub fn context_line(r: &crate::session::SessionRecord, options: &TurnOptions) -> String {
    let model = r
        .model
        .clone()
        .or_else(|| options.default_models.pi.clone())
        .or_else(|| options.default_model.clone())
        .unwrap_or_else(|| "default".into());
    let pct = context_percent(r)
        .map(|p| format!("{p}%"))
        .unwrap_or_else(|| "?".into());
    let cost = r.cost_usd.map(|c| format!(" · ${c:.4}")).unwrap_or_default();
    let tps = r.tokens_per_sec.map(|t| format!(" · {t:.0} tok/s")).unwrap_or_default();
    format!("\n_context {pct} · {model}{cost}{tps}_")
}

pub fn settings_to_options(s: &Settings) -> TurnOptions {
    TurnOptions {
        context_footer: s.context_footer,
        auto_compact_at: s.auto_compact_at,
        debounce_ms: s.debounce_ms,
        parallel_room: s.parallel_room,
        default_model: s.models.pi.clone(),
        default_driver: crate::config::AgentDriverKind::Pi,
        default_models: s.models.clone(),
        personas: s.personas.clone(),
        host_prompt: s.host_prompt.clone(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn paths_are_not_commands() {
        assert_eq!(super::command_of("/help"), Some("help"));
        assert_eq!(super::command_of("  /repo yFlow"), Some("repo"));
        assert_eq!(super::command_of("/home/me/yFlow analizá esto"), None);
        assert_eq!(super::command_of("/ hola"), None);
        assert_eq!(super::command_of("hola /help"), None);
    }

    use super::*;
    use crate::driver::types::AgentTurnResult;
    use crate::driver::EchoDriver;
    use crate::google::RecordingChat;
    use crate::question_gate::cancel_question;
    use crate::session::RoomMember;
    use crate::verify::AcceptAllVerifier;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn persona(name: &str, listen: Option<&str>) -> Persona {
        Persona {
            name: name.into(),
            prompt: format!("You are {name}."),
            driver: None,
            model: None,
            effort: None,
            agent: None,
            listen: listen.map(str::to_string),
            respond_to: None,
            skills: vec![],
            mcps: vec![],
            delegates: vec![],
            description: None,
            avatar: None,
        }
    }

    type Plan = Box<dyn Fn(&str, usize) -> String + Send + Sync>;

    struct ScriptedDriver {
        plan: Plan,
        calls: Mutex<Vec<AgentTurnInput>>,
    }

    impl ScriptedDriver {
        fn new(plan: impl Fn(&str, usize) -> String + Send + Sync + 'static) -> Self {
            Self {
                plan: Box::new(plan),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl AgentDriver for ScriptedDriver {
        async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
            let agent = input
                .thread_key
                .rsplit_once('#')
                .map(|(_, a)| a.to_string())
                .unwrap_or_else(|| "default".into());
            let n = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(input.clone());
                calls
                    .iter()
                    .filter(|c| c.thread_key == input.thread_key)
                    .count()
            };
            Ok(AgentTurnResult {
                reply: (self.plan)(&agent, n),
                session_ref: Some(format!("s-{agent}")),
                usage: None,
                pending: None,
            })
        }
    }

    fn deps(dir: &std::path::Path) -> Arc<HandlerDeps> {
        let store = Arc::new(SessionStore::open(dir.join("sessions.json")));
        let chat = Arc::new(RecordingChat::new());
        Arc::new(HandlerDeps {
            verifier: Arc::new(AcceptAllVerifier),
            driver: Arc::new(EchoDriver),
            chat,
            store,
            queue: Arc::new(TurnQueue::new()),
            config: std::sync::Mutex::new(HandlerConfig {
                allowed_spaces: vec!["spaces/x".into()],
                workdir: dir.to_string_lossy().to_string(),
            }),
            workspaces: None,
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: None,
            options: Arc::new(|| TurnOptions {
                context_footer: ContextFooter::Never,
                auto_compact_at: 0,
                debounce_ms: 0,
                parallel_room: false,
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Pi,
                default_models: Default::default(),
                personas: vec![],
                host_prompt: None,
            }),
            media: None,
        })
    }

    async fn room_deps(
        dir: &std::path::Path,
        driver: Arc<dyn AgentDriver>,
        personas: Vec<Persona>,
        members: Option<Vec<&str>>,
    ) -> Arc<HandlerDeps> {
        room_deps_with(dir, driver, personas, members, false).await
    }

    async fn room_deps_with(
        dir: &std::path::Path,
        driver: Arc<dyn AgentDriver>,
        personas: Vec<Persona>,
        members: Option<Vec<&str>>,
        parallel_room: bool,
    ) -> Arc<HandlerDeps> {
        let store = Arc::new(SessionStore::open(dir.join("sessions.json")));
        if let Some(names) = members {
            let list: Vec<RoomMember> = names
                .into_iter()
                .map(|n| RoomMember::Agent {
                    id: format!("agent:{n}"),
                    persona: n.into(),
                    joined_at: "x".into(),
                })
                .collect();
            store
                .update(
                    "team/t1",
                    "spaces/team",
                    SessionPatch {
                        members: Some(Some(list)),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }
        let personas = Arc::new(personas);
        let personas2 = personas.clone();
        Arc::new(HandlerDeps {
            verifier: Arc::new(AcceptAllVerifier),
            driver,
            chat: Arc::new(RecordingChat::new()),
            store,
            queue: Arc::new(TurnQueue::new()),
            config: std::sync::Mutex::new(HandlerConfig {
                allowed_spaces: vec!["spaces/team".into()],
                workdir: dir.to_string_lossy().to_string(),
            }),
            workspaces: None,
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: None,
            options: Arc::new(move || TurnOptions {
                context_footer: ContextFooter::Never,
                auto_compact_at: 0,
                debounce_ms: 0,
                parallel_room,
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Pi,
                default_models: Default::default(),
                personas: (*personas2).clone(),
                host_prompt: None,
            }),
            media: None,
        })
    }

    #[tokio::test]
    async fn drops_unlisted_space() {
        let dir = tempdir().unwrap();
        let d = deps(dir.path());
        let event: ChatEvent = serde_json::from_value(json!({
            "type": "MESSAGE",
            "space": { "name": "spaces/other" },
            "message": { "text": "hi", "thread": { "name": "spaces/other/threads/t" } }
        }))
        .unwrap();
        let res = handle_event(Some("Bearer x"), event, d).await;
        assert_eq!(res.status, 200);
        assert_eq!(res.body["dropped"], true);
    }

    #[tokio::test]
    async fn queues_agent_turn() {
        cancel_question("spaces/x/threads/t");
        let dir = tempdir().unwrap();
        let store = Arc::new(SessionStore::open(dir.path().join("sessions.json")));
        let chat = Arc::new(RecordingChat::new());
        let d = Arc::new(HandlerDeps {
            verifier: Arc::new(AcceptAllVerifier),
            driver: Arc::new(EchoDriver),
            chat: chat.clone(),
            store,
            queue: Arc::new(TurnQueue::new()),
            config: std::sync::Mutex::new(HandlerConfig {
                allowed_spaces: vec!["spaces/x".into()],
                workdir: dir.path().to_string_lossy().to_string(),
            }),
            workspaces: None,
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: None,
            options: Arc::new(|| TurnOptions {
                context_footer: ContextFooter::Never,
                auto_compact_at: 0,
                debounce_ms: 0,
                parallel_room: false,
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Pi,
                default_models: Default::default(),
                personas: vec![],
                host_prompt: None,
            }),
            media: None,
        });
        let ok = process_message(
            TurnRequest {
                thread_key: "spaces/x/threads/t".into(),
                space_name: "spaces/x".into(),
                text: "hello".into(),
                sender: Some("u".into()),
                reply_via_chat: true,
                thread: None,
                room_n: None,
                captured_replies: None,
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        assert!(ok);
        let posts = chat.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 1);
        assert!(posts[0].1.text.contains("Echo:"));
    }

    #[tokio::test]
    async fn ask_user_question_flow() {
        cancel_question("spaces/x/threads/q");
        let dir = tempdir().unwrap();
        let chat = Arc::new(RecordingChat::new());
        let d = Arc::new(HandlerDeps {
            verifier: Arc::new(AcceptAllVerifier),
            driver: Arc::new(EchoDriver),
            chat: chat.clone(),
            store: Arc::new(SessionStore::open(dir.path().join("sessions.json"))),
            queue: Arc::new(TurnQueue::new()),
            config: std::sync::Mutex::new(HandlerConfig {
                allowed_spaces: vec!["spaces/x".into()],
                workdir: dir.path().to_string_lossy().to_string(),
            }),
            workspaces: None,
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: None,
            options: Arc::new(|| TurnOptions {
                context_footer: ContextFooter::Never,
                auto_compact_at: 0,
                debounce_ms: 0,
                parallel_room: false,
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Pi,
                default_models: Default::default(),
                personas: vec![],
                host_prompt: None,
            }),
            media: None,
        });
        process_message(
            TurnRequest {
                thread_key: "spaces/x/threads/q".into(),
                space_name: "spaces/x".into(),
                text: "ASK:Ship?".into(),
                sender: Some("u".into()),
                reply_via_chat: true,
                thread: None,
                room_n: None,
                captured_replies: None,
                reply_sink: None,
                request_id: None,
            },
            d.clone(),
        )
        .await
        .unwrap();
        assert!(has_question("spaces/x/threads/q"));
        process_message(
            TurnRequest {
                thread_key: "spaces/x/threads/q".into(),
                space_name: "spaces/x".into(),
                text: "1".into(),
                sender: Some("u".into()),
                reply_via_chat: true,
                thread: None,
                room_n: None,
                captured_replies: None,
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let posts = chat.posts.lock().unwrap().clone();
        assert!(posts.len() >= 2);
        assert!(posts.last().unwrap().1.text.contains("answered"));
        cancel_question("spaces/x/threads/q");
    }

    type Step = Box<dyn Fn(&AgentTurnInput) -> Result<String, String> + Send + Sync>;

    struct StepDriver {
        step: Step,
        calls: Mutex<Vec<AgentTurnInput>>,
    }

    #[async_trait]
    impl AgentDriver for StepDriver {
        async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
            self.calls.lock().unwrap().push(input.clone());
            let reply = (self.step)(&input)?;
            Ok(AgentTurnResult { reply, session_ref: None, usage: None, pending: None })
        }
    }

    fn stop_req(thread: &str, text: &str, captured: Arc<tokio::sync::Mutex<Vec<String>>>) -> TurnRequest {
        TurnRequest {
            thread_key: thread.into(),
            space_name: "spaces/team".into(),
            text: text.into(),
            sender: None,
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: Some(captured),
            reply_sink: None,
            request_id: None,
        }
    }

    #[tokio::test]
    async fn stopping_all_reaches_every_parallel_round_without_failure_posts() {
        let thread = "team/stop-all";
        let driver = Arc::new(StepDriver {
            step: Box::new(move |_| {
                crate::personas::request_stop(thread);
                Err("aborted".into())
            }),
            calls: Mutex::new(Vec::new()),
        });
        let dir = tempdir().unwrap();
        let d = room_deps_with(dir.path(), driver.clone(), vec![persona("qa", None), persona("dev", None)], None, true).await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(stop_req(thread, "@qa @dev review all", captured.clone()), d).await.unwrap();
        let replies = captured.lock().await.clone();
        assert!(!replies.iter().any(|r| r.contains("failed")), "{replies:?}");
    }

    #[tokio::test]
    async fn pausing_one_agent_keeps_the_others_and_resume_continues_it() {
        let thread = "team/pause-one";
        let driver = Arc::new(StepDriver {
            step: Box::new(move |input| {
                if input.thread_key.ends_with("#qa") && !input.text.contains("Continue where you left off") {
                    crate::personas::mark_paused(thread, "qa");
                    crate::personas::request_agent_stop(thread, "qa");
                    return Err("aborted".into());
                }
                Ok(format!("{} done", input.thread_key))
            }),
            calls: Mutex::new(Vec::new()),
        });
        let dir = tempdir().unwrap();
        let d = room_deps_with(dir.path(), driver.clone(), vec![persona("qa", None), persona("dev", None)], None, true).await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(stop_req(thread, "@qa @dev review all", captured.clone()), d.clone()).await.unwrap();
        let replies = captured.lock().await.clone();
        assert!(replies.iter().any(|r| r.contains("#dev done")), "{replies:?}");
        assert!(!replies.iter().any(|r| r.contains("failed")), "{replies:?}");
        assert_eq!(crate::personas::paused(thread), vec!["qa".to_string()]);

        resume_agent(stop_req(thread, "", captured.clone()), d, "qa").await.unwrap();
        let last = driver.calls.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.thread_key, format!("{thread}#qa"));
        assert!(last.text.contains("Continue where you left off") && last.text.contains("review all"), "{}", last.text);
        assert!(crate::personas::paused(thread).is_empty());
        assert!(captured.lock().await.iter().any(|r| r.contains("#qa done")));
    }

    #[test]
    fn agent_lane_turn_marks_thread_busy() {
        let key = "share/lane-busy-test";
        assert!(!lanes_busy(key));
        let talking = Speaking::start(key, "@qa");
        assert!(lanes_busy(key), "a persona answering on its own lane must show as busy");
        drop(talking);
        assert!(!lanes_busy(key));
    }

    #[tokio::test]
    async fn parallel_room_fans_out_to_every_mentioned_agent() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "qa" => "qa review".into(),
            "dev" => "dev review".into(),
            _ => "host".into(),
        }));
        let d = room_deps_with(
            dir.path(),
            driver.clone(),
            vec![persona("qa", None), persona("dev", None)],
            Some(vec!["qa", "dev"]),
            true,
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "@qa @dev review all".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let replies = captured.lock().await.clone();
        assert!(replies.iter().any(|r| r.contains("*@qa*") && r.contains("qa review")));
        assert!(replies.iter().any(|r| r.contains("*@dev*") && r.contains("dev review")));
        let calls = driver.calls.lock().unwrap().clone();
        assert!(!calls.iter().any(|c| c.text.contains("[Discussion with")));
    }

    #[tokio::test]
    async fn room_agents_decide_to_reply_or_pass() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, n| match (agent, n) {
            ("default", _) => "host view".into(),
            ("qa", 1) => "PASS".into(),
            ("qa", _) => "qa late".into(),
            ("dev", _) => "dev has a note".into(),
            _ => "x".into(),
        }));
        let d = room_deps(
            dir.path(),
            driver.clone(),
            vec![persona("qa", Some("all")), persona("dev", Some("all"))],
            Some(vec!["qa", "dev"]),
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "random topic".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let replies = captured.lock().await.clone();
        assert!(replies.iter().any(|r| r.contains("host view")));
        assert!(replies.iter().any(|r| r.contains("*@dev*") && r.contains("dev has a note")));
        assert!(!replies.iter().any(|r| r.contains("*@qa*")));
        let calls = driver.calls.lock().unwrap().clone();
        assert!(calls.iter().any(|c| c.thread_key.ends_with("#qa") && c.text.contains("[Room message")));
        assert!(calls.iter().any(|c| c.thread_key.ends_with("#dev") && c.text.contains("[Room message")));
    }

    #[tokio::test]
    async fn room_agent_jumps_in_after_mention_of_peer() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "architect" => "Arch view.".into(),
            "qa" => "QA jumps in.".into(),
            _ => "default".into(),
        }));
        let d = room_deps(
            dir.path(),
            driver.clone(),
            vec![persona("architect", None), persona("qa", Some("all"))],
            Some(vec!["architect", "qa"]),
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "@architect thoughts?".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let replies = captured.lock().await.clone();
        assert_eq!(replies.len(), 2);
        assert!(replies[0].contains("*@architect*"));
        assert!(replies[1].contains("*@qa*"));
        let qa_call = driver
            .calls
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.thread_key.ends_with("#qa"))
            .cloned()
            .unwrap();
        assert!(qa_call.text.contains("[Room message"));
    }

    #[tokio::test]
    async fn mentions_only_agent_stays_quiet_until_named() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "qa" => "qa note".into(),
            "dev" => "dev note".into(),
            _ => "host".into(),
        }));
        let d = room_deps(
            dir.path(),
            driver.clone(),
            vec![persona("qa", None), persona("dev", Some("all"))],
            Some(vec!["qa", "dev"]),
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let req = |text: &str| TurnRequest {
            thread_key: "team/t1".into(),
            space_name: "spaces/team".into(),
            text: text.into(),
            sender: Some("Ana".into()),
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: Some(captured.clone()),
            reply_sink: None,
            request_id: None,
        };
        process_message(req("open question"), d.clone()).await.unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        assert!(calls.iter().any(|c| c.thread_key.ends_with("#dev") && c.text.contains("[Room message")));
        assert!(!calls.iter().any(|c| c.thread_key.ends_with("#qa")), "{calls:?}");
        let replies = captured.lock().await.clone();
        assert!(replies.iter().any(|r| r.contains("*@dev*")));
        assert!(!replies.iter().any(|r| r.contains("*@qa*")));

        process_message(req("@qa look at this"), d).await.unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        assert!(calls.iter().any(|c| c.thread_key.ends_with("#qa") && c.text.contains("@qa look at this")));
    }

    #[tokio::test]
    async fn mentions_only_agent_ignores_a_group_question_from_the_host() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "qa" => "qa note".into(),
            "dev" => "dev note".into(),
            _ => "Can @qa and @dev weigh in?".into(),
        }));
        let d = room_deps(
            dir.path(),
            driver.clone(),
            vec![persona("qa", None), persona("dev", None)],
            Some(vec!["qa", "dev"]),
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "open question".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        assert!(calls.iter().any(|c| !c.thread_key.contains('#')), "host still answers");
        assert!(!calls.iter().any(|c| c.thread_key.ends_with("#qa") || c.thread_key.ends_with("#dev")), "{calls:?}");
    }

    #[tokio::test]
    async fn mentions_only_agent_answers_a_direct_handoff() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "qa" => "qa note".into(),
            _ => "@qa look at login.".into(),
        }));
        let d = room_deps(
            dir.path(),
            driver.clone(),
            vec![persona("qa", None), persona("dev", None)],
            Some(vec!["qa", "dev"]),
        )
        .await;
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "open question".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: None,
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        assert!(calls.iter().any(|c| c.thread_key.ends_with("#qa")));
        assert!(!calls.iter().any(|c| c.thread_key.ends_with("#dev")), "{calls:?}");
    }

    #[tokio::test]
    async fn control_plane_host_prompt_reaches_the_next_switchboard_turn() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|_, _| "ok".into()));
        let prompt = Arc::new(Mutex::new(String::new()));
        let prompt_for_opts = prompt.clone();
        let personas = vec![persona("qa", None)];
        let d = Arc::new(HandlerDeps {
            verifier: Arc::new(AcceptAllVerifier),
            driver: driver.clone(),
            chat: Arc::new(RecordingChat::new()),
            store: Arc::new(SessionStore::open(dir.path().join("sessions.json"))),
            queue: Arc::new(TurnQueue::new()),
            config: std::sync::Mutex::new(HandlerConfig {
                allowed_spaces: vec!["spaces/team".into()],
                workdir: dir.path().to_string_lossy().to_string(),
            }),
            workspaces: None,
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: None,
            options: Arc::new(move || {
                let current = prompt_for_opts.lock().unwrap().clone();
                TurnOptions {
                    context_footer: ContextFooter::Never,
                    auto_compact_at: 0,
                    debounce_ms: 0,
                    parallel_room: false,
                    default_model: None,
                    default_driver: crate::config::AgentDriverKind::Pi,
                    default_models: Default::default(),
                    personas: personas.clone(),
                    host_prompt: if current.is_empty() { None } else { Some(current) },
                }
            }),
            media: None,
        });
        let send = |text: &str| TurnRequest {
            thread_key: "team/t1".into(),
            space_name: "spaces/team".into(),
            text: text.into(),
            sender: Some("Ana".into()),
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: None,
            reply_sink: None,
            request_id: None,
        };
        process_message(send("hola"), d.clone()).await.unwrap();
        *prompt.lock().unwrap() = "Prefer Spanish.".into();
        process_message(send("otra"), d.clone()).await.unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        let host: Vec<_> = calls.iter().filter(|c| !c.thread_key.contains('#')).collect();
        assert_eq!(host.len(), 2, "{calls:?}");
        assert!(!host[0].text.contains("[Switchboard update:"), "{}", host[0].text);
        assert!(host[1].text.contains("[Switchboard update:"), "{}", host[1].text);
        assert!(host[1].text.contains("Prefer Spanish."), "{}", host[1].text);
        assert_eq!(
            d.store.get("team/t1").and_then(|r| r.host_prompt_seen),
            Some("Prefer Spanish.".into())
        );
    }

    #[tokio::test]
    async fn an_agent_the_host_already_called_does_not_answer_again() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, n| match agent {
            "default" => "Te dejo con @soporte, ¿lo ves?".into(),
            "soporte" => format!("hola {n}"),
            _ => "x".into(),
        }));
        let d = room_deps(dir.path(), driver.clone(), vec![persona("soporte", None)], Some(vec!["soporte"])).await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "que onda soporte".into(),
                sender: Some("nahuel".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: Some("m1".into()),
            },
            d,
        )
        .await
        .unwrap();
        let replies = captured.lock().await.clone();
        let soporte = replies.iter().filter(|r| r.contains("*@soporte*")).count();
        assert_eq!(soporte, 1, "{replies:?}");
        let calls = driver.calls.lock().unwrap().iter().filter(|c| c.thread_key.ends_with("#soporte")).count();
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn caps_optional_room_chime_ins_at_two() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "default" => "host".into(),
            other => format!("{other} opinion"),
        }));
        let d = room_deps(
            dir.path(),
            driver,
            vec![persona("a1", Some("all")), persona("b1", Some("all")), persona("c1", Some("all"))],
            Some(vec!["a1", "b1", "c1"]),
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "open question".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let agent_posts = captured
            .lock()
            .await
            .iter()
            .filter(|r| r.contains("*@"))
            .count();
        assert_eq!(agent_posts, 2);
    }

    #[tokio::test]
    async fn sessions_reset_only_when_the_agent_folder_moves() {
        let dir = tempdir().unwrap();
        let mut repos = std::collections::HashMap::new();
        for name in ["api", "web"] {
            let path = dir.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            for args in [vec!["init", "-q"], vec!["commit", "-q", "--allow-empty", "-m", "i"]] {
                assert!(std::process::Command::new("git")
                    .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                    .args(&args)
                    .current_dir(&path)
                    .status()
                    .unwrap()
                    .success());
            }
            repos.insert(name.to_string(), crate::config::RepoConfig { path: path.to_string_lossy().into_owned(), up: None, base: None });
        }
        let base = room_deps(dir.path(), Arc::new(EchoDriver), vec![], None).await;
        let deps = HandlerDeps {
            verifier: base.verifier.clone(),
            driver: base.driver.clone(),
            chat: base.chat.clone(),
            store: base.store.clone(),
            queue: base.queue.clone(),
            config: std::sync::Mutex::new(HandlerConfig {
                allowed_spaces: vec!["spaces/team".into()],
                workdir: dir.path().to_string_lossy().to_string(),
            }),
            workspaces: Some(Arc::new(Workspaces::new(dir.path().join("worktrees"), repos))),
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: None,
            options: base.options.clone(),
            media: None,
        };
        let seed = || SessionPatch {
            session_ref: Some(Some("ses_old".into())),
            persona_sessions: Some(Some(std::collections::HashMap::from([("qa".to_string(), "ses_qa".to_string())]))),
            ..Default::default()
        };
        let run = |text: &str| TurnRequest {
            thread_key: "team/t1".into(),
            space_name: "spaces/team".into(),
            text: text.into(),
            sender: None,
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: None,
            reply_sink: None,
            request_id: None,
        };
        let sessions = |d: &HandlerDeps| d.store.get("team/t1").map(|r| (r.session_ref.is_some(), r.persona_sessions.is_some())).unwrap();
        deps.store.update("team/t1", "spaces/team", seed()).await.unwrap();
        run_command(&run("/repo api"), &deps).await.unwrap();
        assert_eq!(sessions(&deps), (false, false));
        assert!(deps.store.get("team/t1").unwrap().summary.is_some());
        let title = |d: &HandlerDeps| d.store.get("team/t1").unwrap().title.unwrap_or_default();
        assert!(title(&deps).starts_with("switchboard/") && title(&deps).ends_with("· api"), "{}", title(&deps));
        run_command(&run("/topic Login SAML"), &deps).await.unwrap();
        assert_eq!(title(&deps), "Login SAML");
        deps.store.update("team/t1", "spaces/team", seed()).await.unwrap();
        run_command(&run("/repo web"), &deps).await.unwrap();
        assert_eq!(title(&deps), "Login SAML");
        run_command(&run("/close web"), &deps).await.unwrap();
        assert_eq!(sessions(&deps), (true, true));
        run_command(&run("/close"), &deps).await.unwrap();
        assert_eq!(sessions(&deps), (false, false));
    }

    #[tokio::test]
    async fn clear_resets_host_or_one_persona_without_deleting_the_thread() {
        let dir = tempdir().unwrap();
        let deps = room_deps(dir.path(), Arc::new(EchoDriver), vec![persona("qa", None)], Some(vec!["qa"])).await;
        deps.store
            .update(
                "team/t1",
                "spaces/team",
                SessionPatch {
                    session_ref: Some(Some("ses_host".into())),
                    summary: Some(Some("old".into())),
                    context_tokens: Some(Some(1200)),
                    turns: Some(Some(4)),
                    pending_questions: Some(Some(vec![AgentQuestion {
                        header: "h".into(),
                        question: "Ship?".into(),
                        options: vec![],
                        multiple: None,
                    }])),
                    host_roster: Some(Some(vec!["qa".into()])),
                    persona_sessions: Some(Some(std::collections::HashMap::from([
                        ("qa".into(), "ses_qa".into()),
                        ("architect".into(), "ses_arch".into()),
                    ]))),
                    persona_usage: Some(Some(std::collections::HashMap::from([(
                        "qa".into(),
                        crate::session::PersonaUsage {
                            context_tokens: Some(99),
                            context_window: Some(1000),
                            estimated: Some(false),
                            turns: Some(1),
                        },
                    )]))),
                    persona_roster: Some(Some(std::collections::HashMap::from([
                        ("qa".into(), vec!["Ana".into()]),
                        ("architect".into(), vec!["Ana".into()]),
                    ]))),
                    repo: Some(Some("api".into())),
                    worktree: Some(Some("/tmp/wt".into())),
                    branch: Some(Some("feat".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let run = |text: &str| TurnRequest {
            thread_key: "team/t1".into(),
            space_name: "spaces/team".into(),
            text: text.into(),
            sender: None,
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: None,
            reply_sink: None,
            request_id: None,
        };
        let note = run_command(&run("/clear @QA"), &deps).await.unwrap();
        assert!(note.contains("@qa"), "{note}");
        let rec = deps.store.get("team/t1").unwrap();
        assert_eq!(rec.session_ref.as_deref(), Some("ses_host"));
        assert_eq!(rec.repo.as_deref(), Some("api"));
        assert_eq!(rec.worktree.as_deref(), Some("/tmp/wt"));
        assert_eq!(rec.branch.as_deref(), Some("feat"));
        assert!(rec.members.as_ref().unwrap().iter().any(|m| matches!(m, RoomMember::Agent { persona, .. } if persona == "qa")));
        assert_eq!(
            rec.persona_sessions.as_ref().unwrap().get("architect").map(String::as_str),
            Some("ses_arch")
        );
        assert!(!rec.persona_sessions.as_ref().unwrap().contains_key("qa"));
        assert!(!rec.persona_roster.as_ref().unwrap().contains_key("qa"));
        assert!(rec.persona_roster.as_ref().unwrap().contains_key("architect"));
        assert!(rec.persona_usage.as_ref().map(|m| !m.contains_key("qa")).unwrap_or(true));

        let note = run_command(&run("/clear"), &deps).await.unwrap();
        assert!(note.contains("fresh session"), "{note}");
        let rec = deps.store.get("team/t1").unwrap();
        assert!(rec.session_ref.is_none());
        assert!(rec.summary.is_none());
        assert!(rec.context_tokens.is_none());
        assert!(rec.turns.is_none());
        assert!(rec.pending_questions.is_none());
        assert!(rec.host_roster.is_none());
        assert_eq!(rec.repo.as_deref(), Some("api"));
        assert_eq!(rec.worktree.as_deref(), Some("/tmp/wt"));
        assert_eq!(
            rec.persona_sessions.as_ref().unwrap().get("architect").map(String::as_str),
            Some("ses_arch")
        );
        assert!(deps.store.get("team/t1").is_some());
    }

    #[tokio::test]
    async fn compact_seeds_the_next_session_once() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|_, _| "RESUMEN: login con SAML, falta el test".into()));
        let d = room_deps(dir.path(), driver.clone(), vec![], None).await;
        d.store
            .update("team/t1", "spaces/team", SessionPatch { session_ref: Some(Some("ses_old".into())), ..Default::default() })
            .await
            .unwrap();
        let req = |text: &str| TurnRequest {
            thread_key: "team/t1".into(),
            space_name: "spaces/team".into(),
            text: text.into(),
            sender: Some("Ana".into()),
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: Some(Arc::new(tokio::sync::Mutex::new(Vec::new()))),
            reply_sink: None,
            request_id: None,
        };
        let note = run_command(&req("/compact"), &d).await.unwrap();
        assert!(note.contains("Session compacted"));
        let rec = d.store.get("team/t1").unwrap();
        assert!(rec.session_ref.is_none());
        assert!(rec.summary.as_deref().unwrap().contains("SAML"));
        process_message(req("seguimos"), d.clone()).await.unwrap();
        process_message(req("y ahora?"), d.clone()).await.unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        assert!(calls[0].text.starts_with("Summarize this conversation"));
        assert!(calls[1].text.contains(COMPACTED_HEADER) && calls[1].text.contains("SAML"));
        assert!(!calls[2].text.contains(COMPACTED_HEADER));
        assert!(d.store.get("team/t1").unwrap().summary.is_none());
    }

    fn ledger_deps(dir: &std::path::Path, driver: Arc<dyn AgentDriver>, chat: Arc<crate::google::RecordingChat>) -> Arc<HandlerDeps> {
        Arc::new(HandlerDeps {
            verifier: Arc::new(AcceptAllVerifier),
            driver,
            chat,
            store: Arc::new(SessionStore::open(dir.join("sessions.json"))),
            queue: Arc::new(TurnQueue::new()),
            config: std::sync::Mutex::new(HandlerConfig { allowed_spaces: vec!["spaces/a".into()], workdir: dir.to_string_lossy().to_string() }),
            workspaces: None,
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: Some(Arc::new(crate::turn_ledger::TurnLedger::open(dir.join("turns.json")))),
            options: Arc::new(|| TurnOptions {
                context_footer: ContextFooter::Never,
                auto_compact_at: 0,
                debounce_ms: 0,
                parallel_room: false,
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Pi,
                default_models: Default::default(),
                personas: vec![],
                host_prompt: None,
            }),
            media: None,
        })
    }

    #[tokio::test]
    async fn quick_messages_reach_the_agent_as_one_turn() {
        let dir = tempdir().unwrap();
        let base = ledger_deps(dir.path(), Arc::new(EchoDriver), Arc::new(crate::google::RecordingChat::new()));
        let deps = Arc::new(HandlerDeps {
            verifier: base.verifier.clone(),
            driver: base.driver.clone(),
            chat: base.chat.clone(),
            store: base.store.clone(),
            queue: base.queue.clone(),
            config: std::sync::Mutex::new(HandlerConfig { allowed_spaces: vec![], workdir: dir.path().to_string_lossy().to_string() }),
            workspaces: None,
            activity: None,
            scheduler: std::sync::OnceLock::new(),
            ledger: base.ledger.clone(),
            options: Arc::new(|| TurnOptions {
                context_footer: ContextFooter::Never,
                auto_compact_at: 0,
                debounce_ms: 300,
                parallel_room: false,
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Pi,
                default_models: Default::default(),
                personas: vec![],
                host_prompt: None,
            }),
            media: None,
        });
        let req = |thread: &str, sender: &str, text: &str, id: &str| TurnRequest {
            thread_key: thread.into(),
            space_name: "team-chat".into(),
            text: text.into(),
            sender: Some(sender.into()),
            reply_via_chat: false,
            thread: None,
            room_n: None,
            captured_replies: None,
            reply_sink: None,
            request_id: Some(id.into()),
        };
        let ledger = deps.ledger.clone().unwrap();
        for id in ["a1", "a2", "a3"] {
            ledger.begin(id, "share/d1", "team-chat", None).await;
        }
        let burst = ["hola", "tengo un problema", "con el webhook"].iter().zip(["a1", "a2", "a3"]).map(|(t, id)| {
            let deps = deps.clone();
            let r = req("share/d1", "Ana", t, id);
            async move { debounce(&deps, r).await }
        });
        let mut out = Vec::new();
        for f in burst {
            out.push(tokio::spawn(f));
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let results: Vec<_> = futures::future::join_all(out).await.into_iter().map(|r| r.unwrap()).collect();
        let fired: Vec<_> = results.into_iter().flatten().collect();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].text, "hola
tengo un problema
con el webhook");
        assert_eq!(fired[0].sender.as_deref(), Some("Ana"));
        assert_eq!(fired[0].request_id.as_deref(), Some("a3"));
        assert_eq!(ledger.state("a1"), Some(crate::turn_ledger::TurnState::Posted));

        let two = futures::future::join(debounce(&deps, req("share/d2", "Ana", "che", "b1")), async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            debounce(&deps, req("share/d2", "Beto", "yo tambien", "b2")).await
        })
        .await;
        let merged = two.0.or(two.1).unwrap();
        assert_eq!(merged.text, "Ana: che
Beto: yo tambien");
        assert!(merged.sender.is_none());

        let started = std::time::Instant::now();
        assert!(debounce(&deps, req("share/d3", "Ana", "/status", "c1")).await.is_some());
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
    }

    #[tokio::test]
    async fn the_same_chat_message_runs_once() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|_, _| "hecho".into()));
        let chat = Arc::new(crate::google::RecordingChat::new());
        let deps = ledger_deps(dir.path(), driver.clone(), chat.clone());
        let event = || -> ChatEvent {
            serde_json::from_value(json!({
                "type": "MESSAGE",
                "space": { "name": "spaces/a" },
                "message": { "name": "spaces/a/messages/m1", "text": "hola", "thread": { "name": "spaces/a/threads/t1" } }
            }))
            .unwrap()
        };
        let first = handle_event(None, event(), deps.clone()).await;
        let second = handle_event(None, event(), deps.clone()).await;
        assert_eq!(first.status, 200);
        assert_eq!(second.body["duplicate"], true);
        for _ in 0..50 {
            if deps.ledger.as_ref().unwrap().state("spaces/a/messages/m1") == Some(crate::turn_ledger::TurnState::Posted) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(driver.calls.lock().unwrap().len(), 1);
        assert_eq!(chat.posts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_restart_announces_cut_turns_and_open_questions_once() {
        let dir = tempdir().unwrap();
        let chat = Arc::new(crate::google::RecordingChat::new());
        let driver = Arc::new(ScriptedDriver::new(|_, _| "x".into()));
        let deps = ledger_deps(dir.path(), driver.clone(), chat.clone());
        let ledger = deps.ledger.clone().unwrap();
        let thread = Some(crate::google::PostThread { name: Some("spaces/a/threads/t1".into()), thread_key: None });
        ledger.begin("m1", "spaces/a/threads/t1", "spaces/a", thread).await;
        ledger.set("m1", crate::turn_ledger::TurnState::Running).await;
        deps.store
            .update(
                "spaces/a/threads/t2",
                "spaces/a",
                SessionPatch {
                    pending_questions: Some(Some(vec![AgentQuestion { header: "h".into(), question: "Ship?".into(), options: vec![], multiple: None }])),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let transcripts = Arc::new(crate::transcripts::TranscriptStore::open(dir.path().join("t"), 50));
        let reopened = Arc::new(crate::turn_ledger::TurnLedger::open(dir.path().join("turns.json")));
        assert_eq!(crate::turn_ledger::recover(deps.clone(), reopened.clone(), transcripts.clone()).await, 1);
        for _ in 0..100 {
            if chat.posts.lock().unwrap().len() >= 2
                && reopened.state("m1") == Some(crate::turn_ledger::TurnState::Failed)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(crate::turn_ledger::recover(deps.clone(), reopened.clone(), transcripts.clone()).await, 0);
        let posts = chat.posts.lock().unwrap().clone();
        assert!(posts.iter().any(|(_, b)| b.text == crate::turn_ledger::CUT_NOTICE));
        assert!(posts.iter().any(|(_, b)| b.text == crate::turn_ledger::EXPIRED_NOTICE));
        assert!(deps.store.get("spaces/a/threads/t2").unwrap().pending_questions.is_none());
        assert_eq!(reopened.state("m1"), Some(crate::turn_ledger::TurnState::Failed));
        assert!(driver.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_agent_the_host_brought_in_does_not_answer_twice() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "default" => "Te dejo con el experto: @soporte, te está buscando".into(),
            "soporte" => "Hola, acá soporte".into(),
            _ => "PASS".into(),
        }));
        let d = room_deps(dir.path(), driver.clone(), vec![persona("soporte", None)], Some(vec!["soporte"])).await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "que onda soporte".into(),
                sender: Some("Nahuel".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let replies = captured.lock().await.clone();
        let from_soporte = replies.iter().filter(|r| r.starts_with("*@soporte*")).count();
        assert_eq!(from_soporte, 1, "{replies:?}");
    }

    #[tokio::test]
    async fn host_pass_is_not_posted() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "default" => "PASS".into(),
            "soporte" => "Es de configuracion: revisa el canal.".into(),
            _ => "PASS".into(),
        }));
        let d = room_deps(
            dir.path(),
            driver,
            vec![persona("soporte", None), persona("codigo", None)],
            Some(vec!["soporte", "codigo"]),
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "el canal de WhatsApp no recibe mensajes".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let replies = captured.lock().await.clone();
        assert_eq!(replies.len(), 1);
        assert!(replies[0].starts_with("*@soporte*"));
    }

    #[tokio::test]
    async fn echo_stays_quiet_on_optional_room_prompt() {
        let dir = tempdir().unwrap();
        let d = room_deps(
            dir.path(),
            Arc::new(EchoDriver),
            vec![persona("qa", None)],
            Some(vec!["qa"]),
        )
        .await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        process_message(
            TurnRequest {
                thread_key: "team/t1".into(),
                space_name: "spaces/team".into(),
                text: "hola".into(),
                sender: Some("Ana".into()),
                reply_via_chat: false,
                thread: None,
                room_n: None,
                captured_replies: Some(captured.clone()),
                reply_sink: None,
                request_id: None,
            },
            d,
        )
        .await
        .unwrap();
        let replies = captured.lock().await.clone();
        assert_eq!(replies.len(), 1);
        assert!(replies[0].contains("Echo:"));
        assert!(!replies[0].contains("*@qa*"));
    }

    /// Blocks `qa`'s first run until released; records runs and steers.
    struct GateDriver {
        release: Arc<tokio::sync::Notify>,
        steer_ok: bool,
        calls: Mutex<Vec<AgentTurnInput>>,
        steers: Mutex<Vec<(String, String, String)>>,
    }

    #[async_trait]
    impl AgentDriver for GateDriver {
        async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
            let first_qa = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(input.clone());
                input.thread_key.ends_with("#qa") && calls.iter().filter(|c| c.thread_key.ends_with("#qa")).count() == 1
            };
            if first_qa {
                self.release.notified().await;
            }
            let agent = input.thread_key.rsplit_once('#').map(|(_, a)| a.to_string()).unwrap_or_else(|| "host".into());
            Ok(AgentTurnResult { reply: format!("{agent} done"), session_ref: Some(format!("s-{agent}")), usage: None, pending: None })
        }

        async fn steer(&self, thread_key: &str, session_ref: &str, _request_id: &str, text: &str) -> Result<Option<crate::driver::types::SteerResult>, String> {
            self.steers.lock().unwrap().push((thread_key.into(), session_ref.into(), text.into()));
            Ok(self.steer_ok.then_some(crate::driver::types::SteerResult::Joined))
        }
    }

    fn gate(steer_ok: bool) -> Arc<GateDriver> {
        Arc::new(GateDriver { release: Arc::new(tokio::sync::Notify::new()), steer_ok, calls: Mutex::new(Vec::new()), steers: Mutex::new(Vec::new()) })
    }

    async fn qa_running(driver: &GateDriver) {
        for _ in 0..200 {
            if driver.calls.lock().unwrap().iter().any(|c| c.thread_key.ends_with("#qa")) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("qa never started");
    }

    async fn lane_deps(dir: &std::path::Path, driver: Arc<GateDriver>, thread: &str) -> Arc<HandlerDeps> {
        let d = room_deps_with(dir, driver, vec![persona("qa", None), persona("dev", None)], None, true).await;
        let sessions: std::collections::HashMap<String, String> = [("qa".to_string(), "s-qa".to_string())].into();
        d.store.update(thread, "spaces/team", SessionPatch { persona_sessions: Some(Some(sessions)), ..Default::default() }).await.unwrap();
        d
    }

    /// `qa` blocks until released, then fails the way an aborted run does.
    struct AbortedQa {
        release: Arc<tokio::sync::Notify>,
        started: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl AgentDriver for AbortedQa {
        async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
            if input.thread_key.ends_with("#qa") {
                self.started.notify_one();
                self.release.notified().await;
                return Err("aborted".into());
            }
            Ok(AgentTurnResult { reply: "dev done".into(), session_ref: None, usage: None, pending: None })
        }
    }

    #[tokio::test]
    async fn a_stop_survives_a_message_that_arrives_right_after_it() {
        let thread = "team/stop-then-message";
        let dir = tempdir().unwrap();
        let driver = Arc::new(AbortedQa { release: Arc::new(tokio::sync::Notify::new()), started: Arc::new(tokio::sync::Notify::new()) });
        let d = room_deps_with(dir.path(), driver.clone(), vec![persona("qa", None), persona("dev", None)], None, true).await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let first = tokio::spawn(process_message(stop_req(thread, "@qa long task", captured.clone()), d.clone()));
        driver.started.notified().await;
        crate::personas::request_stop(thread);
        process_message(stop_req(thread, "@dev quick one", captured.clone()), d.clone()).await.unwrap();
        driver.release.notify_one();
        first.await.unwrap().unwrap();
        let replies = captured.lock().await.clone();
        assert!(!replies.iter().any(|r| r.contains("failed")), "stop was lost: {replies:?}");
    }

    #[tokio::test]
    async fn an_idle_agent_starts_while_another_is_still_working() {
        let thread = "team/lanes-idle";
        let dir = tempdir().unwrap();
        let driver = gate(false);
        let d = lane_deps(dir.path(), driver.clone(), thread).await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let first = tokio::spawn(process_message(stop_req(thread, "@qa long task", captured.clone()), d.clone()));
        qa_running(&driver).await;
        tokio::time::timeout(std::time::Duration::from_secs(2), process_message(stop_req(thread, "@dev quick one", captured.clone()), d.clone()))
            .await
            .expect("dev waited on qa")
            .unwrap();
        assert!(captured.lock().await.iter().any(|r| r.contains("dev done")));
        driver.release.notify_one();
        first.await.unwrap().unwrap();
        let sessions = d.store.get(thread).and_then(|r| r.persona_sessions).unwrap();
        assert_eq!(sessions.get("qa").map(String::as_str), Some("s-qa"));
        assert_eq!(sessions.get("dev").map(String::as_str), Some("s-dev"));
    }

    #[tokio::test]
    async fn a_busy_agent_is_steered_on_its_own_session_never_the_host() {
        let thread = "team/lanes-steer";
        let dir = tempdir().unwrap();
        let driver = gate(true);
        let d = lane_deps(dir.path(), driver.clone(), thread).await;
        d.store.update(thread, "spaces/team", SessionPatch { session_ref: Some(Some("s-host".into())), ..Default::default() }).await.unwrap();
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let first = tokio::spawn(process_message(stop_req(thread, "@qa long task", captured.clone()), d.clone()));
        qa_running(&driver).await;
        let mut req = stop_req(thread, "@qa also check login", captured.clone());
        req.sender = Some("Ana".into());
        assert!(!steered(&req, &d).await, "host must not take a persona mention");
        tokio::time::timeout(std::time::Duration::from_secs(2), process_message(req, d.clone())).await.expect("steer waited").unwrap();
        let steers = driver.steers.lock().unwrap().clone();
        assert_eq!(steers.len(), 1, "{steers:?}");
        assert_eq!((steers[0].0.as_str(), steers[0].1.as_str()), (format!("{thread}#qa").as_str(), "s-qa"));
        assert!(steers[0].2.contains("also check login"));
        driver.release.notify_one();
        first.await.unwrap().unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        assert_eq!(calls.iter().filter(|c| c.thread_key.ends_with("#qa")).count(), 1);
        assert!(!calls.iter().any(|c| c.thread_key == thread));
    }

    #[tokio::test]
    async fn a_busy_agent_without_steer_runs_the_message_next() {
        let thread = "team/lanes-queue";
        let dir = tempdir().unwrap();
        let driver = gate(false);
        let d = lane_deps(dir.path(), driver.clone(), thread).await;
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let first = tokio::spawn(process_message(stop_req(thread, "@qa long task", captured.clone()), d.clone()));
        qa_running(&driver).await;
        let second = tokio::spawn(process_message(stop_req(thread, "@qa also check login", captured.clone()), d.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!second.is_finished(), "queued behind qa's running turn");
        driver.release.notify_one();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        let calls = driver.calls.lock().unwrap().clone();
        let qa: Vec<_> = calls.iter().filter(|c| c.thread_key.ends_with("#qa")).collect();
        assert_eq!(qa.len(), 2);
        assert!(qa[1].text.contains("also check login"));
        assert!(!calls.iter().any(|c| c.thread_key == thread));
    }
}
