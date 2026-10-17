use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::driver::types::{AgentDriver, AgentQuestion, AgentTurnInput};
use crate::google::{ChatClient, PostMessageBody, PostThread};
use crate::personas::{
    active_personas, add_hint, addressed_personas, asked_personas, consult_open, consult_topics,
    dialogue_open, dialogue_pass, host_preamble, is_pass, mentioned_personas, mentions_bot,
    persona_preamble, request_stop, room_append, room_catch_up, room_prompt, roster_update,
    strip_self_prefix, take_stop, MAX_DIALOGUE_HOPS, MAX_HOPS, MAX_INTERJECTIONS,
};
pub use crate::personas::BOT_NAME;
use crate::workspace::slug_for;
use crate::question_gate::{has_question, hold_question, take_question};
use crate::questions::{continuation, question_cards};
use crate::queue::TurnQueue;
use crate::session::{SessionPatch, SessionStore};
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
    pub default_model: Option<String>,
    pub default_driver: crate::config::AgentDriverKind,
    pub default_models: crate::settings::Models,
    pub personas: Vec<Persona>,
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
        let _ = tracked(&deps2.clone(), request_id.as_deref(), process_message(
            TurnRequest {
                thread_key: thread2,
                space_name: space2,
                text: prompt,
                sender,
                reply_via_chat: true,
                thread,
                room_n: None,
                captured_replies: None,
            },
            deps2,
        ))
        .await;
    });
    HandleResult {
        status: 200,
        body: json!({ "ok": true }),
    }
}

pub async fn tracked<F: std::future::Future<Output = Result<bool, String>>>(deps: &HandlerDeps, request_id: Option<&str>, turn: F) -> Result<bool, String> {
    let (Some(ledger), Some(id)) = (&deps.ledger, request_id) else {
        return turn.await;
    };
    ledger.set(id, crate::turn_ledger::TurnState::Running).await;
    let result = turn.await;
    let state = if result.is_ok() { crate::turn_ledger::TurnState::Posted } else { crate::turn_ledger::TurnState::Failed };
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
}

pub async fn process_message(mut req: TurnRequest, deps: Arc<HandlerDeps>) -> Result<bool, String> {
    let key = req.thread_key.clone();
    deps.queue
        .run(&key, || async {
            if req.text.starts_with('/') {
                let reply = run_command(&req, &deps).await.unwrap_or_else(|e| format!("Command failed: {e}"));
                deliver_reply(&req, &deps, &reply, None, None).await;
                return Ok(true);
            }
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
            let result = agent_turn(&req, &deps).await;
            let (kind, detail) = match &result {
                Ok(_) => ("turn_ok", req.sender.clone().unwrap_or_default()),
                Err(e) => ("turn_fail", e.clone()),
            };
            note(&deps, kind, &req.thread_key, req.text.chars().take(80).collect::<String>(), detail).await;
            let room_now = active_personas(
                &(deps.options)().personas,
                deps.store.get(&req.thread_key).as_ref().and_then(|r| r.members.as_deref()),
            );
            let spoken: std::collections::HashSet<String> = addressed_personas(&req.text, &room_now)
                .into_iter()
                .chain(consult_topics(&req.text, &room_now))
                .map(|p| p.name.to_lowercase())
                .collect();
            let members_present = deps
                .store
                .get(&req.thread_key)
                .as_ref()
                .and_then(|r| r.members.as_ref())
                .is_some();
            let jump: Vec<Persona> = room_now
                .iter()
                .filter(|p| {
                    if spoken.contains(&p.name.to_lowercase()) {
                        return false;
                    }
                    if members_present {
                        true
                    } else {
                        p.listen.as_deref() == Some("all")
                    }
                })
                .cloned()
                .collect();
            if !jump.is_empty() {
                let _ = persona_round(
                    &req,
                    &deps,
                    &jump,
                    &active_personas(
                        &(deps.options)().personas,
                        deps.store.get(&req.thread_key).as_ref().and_then(|r| r.members.as_deref()),
                    ),
                    PersonaOpts {
                        optional: true,
                        ..Default::default()
                    },
                )
                .await;
            }
            result
        })
        .await
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
    if let Some(buf) = &req.captured_replies {
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
            if !personas.is_empty() || record.as_ref().and_then(|r| r.host_roster.as_ref()).is_some() {
                let names: Vec<String> = personas.iter().map(|p| p.name.clone()).collect();
                if record.as_ref().and_then(|r| r.session_ref.as_ref()).is_none() {
                    text = format!("{}\n\n---\n\n{text}", host_preamble(&personas));
                } else if let Some(before) = record.as_ref().and_then(|r| r.host_roster.as_deref()) {
                    text.push_str(&roster_update(Some(before), &names));
                } else {
                    text.push_str(&format!("\n\n{}", host_preamble(&personas)));
                }
                let _ = deps
                    .store
                    .update(
                        &req.thread_key,
                        &req.space_name,
                        SessionPatch {
                            host_roster: Some(Some(names)),
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
                return Ok(true);
            }

            let mut reply = out.reply;
            let turns = record.as_ref().and_then(|r| r.turns).unwrap_or(0) + 1;
            let _ = deps
                .store
                .update(
                    &req.thread_key,
                    &req.space_name,
                    SessionPatch {
                        session_ref: Some(out.session_ref.clone()),
                        turns: Some(Some(turns)),
                        pending_questions: Some(None),
                        context_tokens: out.usage.as_ref().map(|u| Some(u.context_tokens)),
                        context_window: out.usage.as_ref().and_then(|u| u.context_window.map(Some)),
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
                let asked: Vec<Persona> = asked_personas(&reply, &room_now).into_iter().cloned().collect();
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
    while idx < queue.len() && hops_done < max_hops + first.len() {
        if take_stop(&req.thread_key) {
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
                &names,
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
            })
            .await;
        drop(talking);
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
                let mut persona_sessions = record
                    .as_ref()
                    .and_then(|r| r.persona_sessions.clone())
                    .unwrap_or_default();
                if let Some(s) = out.session_ref {
                    persona_sessions.insert(item.persona.name.clone(), s);
                }
                let mut persona_roster = record
                    .as_ref()
                    .and_then(|r| r.persona_roster.clone())
                    .unwrap_or_default();
                persona_roster.insert(item.persona.name.clone(), names);
                let _ = deps
                    .store
                    .update(
                        &req.thread_key,
                        &req.space_name,
                        SessionPatch {
                            persona_sessions: Some(Some(persona_sessions)),
                            persona_roster: Some(Some(persona_roster)),
                            ..Default::default()
                        },
                    )
                    .await;
                deliver_reply(req, deps, &reply, Some(&item.persona.name), None).await;
                reply
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
    let record = deps.store.get(thread_key);
    let next = room_append(record.as_ref().and_then(|r| r.room.as_deref()), author, text);
    let n = next.last().map(|e| e.n).unwrap_or(0);
    let _ = deps
        .store
        .update(
            thread_key,
            space,
            SessionPatch {
                room: Some(Some(next)),
                ..Default::default()
            },
        )
        .await;
    n
}

async fn mark_seen(deps: &HandlerDeps, thread_key: &str, space: &str, who: &str, n: u64) {
    let record = deps.store.get(thread_key);
    let mut seen = record
        .as_ref()
        .and_then(|r| r.room_seen.clone())
        .unwrap_or_default();
    seen.insert(who.to_string(), n);
    let _ = deps
        .store
        .update(
            thread_key,
            space,
            SessionPatch {
                room_seen: Some(Some(seen)),
                ..Default::default()
            },
        )
        .await;
}

async fn run_command(req: &TurnRequest, deps: &HandlerDeps) -> Result<String, String> {
    let mut parts = req.text.trim_start_matches('/').split_whitespace();
    let cmd = parts.next().unwrap_or("");
    let args: Vec<&str> = parts.collect();
    match cmd {
        "help" => Ok("Commands: /help /clear /compact /context /model /agent /stop /agents /invite <agent> /kick <agent> /approve <id> /deny <id> /topic <text> /repo <name...> /status /up [repo] /down /logs /close [repo]".into()),
        "stop" => {
            request_stop(&req.thread_key);
            Ok("Stopping after the current agent finishes.".into())
        }
        "compact" => compact(&req.thread_key, &req.space_name, deps).await,
        "clear" => {
            deps.store.delete(&req.thread_key).await?;
            Ok("Session cleared.".into())
        }
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
        "agent" => {
            let driver = match args.first().copied() {
                Some("opencode") => Some(crate::config::AgentDriverKind::Opencode),
                Some("claude") => Some(crate::config::AgentDriverKind::Claude),
                Some(other) => return Err(format!("unknown agent {other}")),
                None => None,
            };
            deps.store
                .update(
                    &req.thread_key,
                    &req.space_name,
                    SessionPatch {
                        driver: Some(driver),
                        session_ref: Some(None),
                        ..Default::default()
                    },
                )
                .await?;
            Ok("Agent updated.".into())
        }
        "repo" | "status" | "up" | "down" | "logs" | "close" => repo_command(cmd, &args, req, deps).await,
        "topic" => {
            let title = args.join(" ");
            set_title(req, deps, Some(title.clone()).filter(|t| !t.trim().is_empty())).await?;
            Ok(if title.trim().is_empty() { "Topic cleared.".into() } else { format!("Topic set: {title}") })
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

async fn set_title(req: &TurnRequest, deps: &HandlerDeps, title: Option<String>) -> Result<(), String> {
    deps.store
        .update(&req.thread_key, &req.space_name, SessionPatch { title: Some(title), ..Default::default() })
        .await
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

async fn compact(thread_key: &str, space: &str, deps: &HandlerDeps) -> Result<String, String> {
    let record = deps.store.get(thread_key);
    let Some(session_ref) = record.as_ref().and_then(|r| r.session_ref.clone()) else {
        return Ok("Nothing to compact yet.".into());
    };
    crate::question_gate::cancel_question(thread_key);
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
                session_ref: moved.then_some(None),
                persona_sessions: moved.then_some(None),
                ..Default::default()
            },
        )
        .await
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
            for name in args.iter().map(|a| a.to_string()).filter(|a| !repos.contains(a)).collect::<Vec<_>>() {
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
            None => "No repos for this thread. Use /repo <name...>.".into(),
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
        .or_else(|| match r.driver.unwrap_or(options.default_driver) {
            crate::config::AgentDriverKind::Opencode => options.default_models.opencode.clone(),
            crate::config::AgentDriverKind::Claude => options.default_models.claude.clone(),
        })
        .unwrap_or_else(|| "default".into());
    let pct = context_percent(r)
        .map(|p| format!("{p}%"))
        .unwrap_or_else(|| "?".into());
    format!("\n_context {pct} · {model}_")
}

pub fn settings_to_options(s: &Settings) -> TurnOptions {
    let default_model = match s.agent_driver {
        crate::config::AgentDriverKind::Opencode => s.models.opencode.clone(),
        crate::config::AgentDriverKind::Claude => s.models.claude.clone(),
    };
    TurnOptions {
        context_footer: s.context_footer,
        auto_compact_at: s.auto_compact_at,
        default_model,
        default_driver: s.agent_driver,
        default_models: s.models.clone(),
        personas: s.personas.clone(),
    }
}

#[cfg(test)]
mod tests {
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
            agent: None,
            listen: listen.map(str::to_string),
            respond_to: None,
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
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Opencode,
                default_models: Default::default(),
                personas: vec![],
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
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Opencode,
                default_models: Default::default(),
                personas: (*personas2).clone(),
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
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Opencode,
                default_models: Default::default(),
                personas: vec![],
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
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Opencode,
                default_models: Default::default(),
                personas: vec![],
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
            vec![persona("qa", None), persona("dev", None)],
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
            vec![persona("architect", None), persona("qa", None)],
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
    async fn caps_optional_room_chime_ins_at_two() {
        let dir = tempdir().unwrap();
        let driver = Arc::new(ScriptedDriver::new(|agent, _| match agent {
            "default" => "host".into(),
            other => format!("{other} opinion"),
        }));
        let d = room_deps(
            dir.path(),
            driver,
            vec![persona("a1", None), persona("b1", None), persona("c1", None)],
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
                default_model: None,
                default_driver: crate::config::AgentDriverKind::Opencode,
                default_models: Default::default(),
                personas: vec![],
            }),
            media: None,
        })
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
        let transcripts = crate::transcripts::TranscriptStore::open(dir.path().join("t"), 50);
        let reopened = crate::turn_ledger::TurnLedger::open(dir.path().join("turns.json"));
        assert_eq!(crate::turn_ledger::recover(&deps, &reopened, &transcripts).await, 1);
        assert_eq!(crate::turn_ledger::recover(&deps, &reopened, &transcripts).await, 0);
        let posts = chat.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        assert!(posts.iter().any(|(_, b)| b.text == crate::turn_ledger::CUT_NOTICE));
        assert!(posts.iter().any(|(_, b)| b.text == crate::turn_ledger::EXPIRED_NOTICE));
        assert!(deps.store.get("spaces/a/threads/t2").unwrap().pending_questions.is_none());
        assert_eq!(reopened.state("m1"), Some(crate::turn_ledger::TurnState::Failed));
        assert!(driver.calls.lock().unwrap().is_empty());
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
}
