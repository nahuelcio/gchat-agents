use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::driver::types::{AgentDriver, AgentTurnInput};
use crate::mcp_client::BUILTIN_GROUPS;
use crate::skills;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentDraft {
    pub name: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(rename = "respondTo", default, skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcps: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delegates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcps: Vec<String>,
    pub body: String,
    /// Bundled resources: references/, scripts/, assets/ (Anthropic skill layout).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<crate::skills::SkillFile>,
}

#[derive(Debug, Clone, Default)]
pub struct DraftContext {
    pub available_mcps: Vec<String>,
    pub available_skills: Vec<String>,
    pub workdir: String,
    pub model: Option<String>,
}

pub fn available_mcps(settings: &crate::settings::Settings) -> Vec<String> {
    let mut names: Vec<String> = BUILTIN_GROUPS.iter().map(|s| (*s).to_string()).collect();
    for s in &settings.mcp_servers {
        if !names.iter().any(|n| n == &s.name) {
            names.push(s.name.clone());
        }
    }
    names
}

/// Meta-pack that steers Create → Skills AI. Not attachable to chat agents.
pub const SKILL_CREATOR: &str = "skill-creator";

pub fn available_skill_names() -> Vec<String> {
    skills::available()
        .into_iter()
        .map(|s| s.name)
        .filter(|n| n != SKILL_CREATOR)
        .collect()
}

/// Body + references from the skill-creator pack, if installed.
fn skill_creator_guide() -> String {
    let Some(s) = skills::load(SKILL_CREATOR) else {
        return String::new();
    };
    let mut out = format!("\n\n---\n# Follow the skill-creator pack\n\n{}\n", s.body.trim());
    for f in s.files.iter().filter(|f| f.path.starts_with("references/")) {
        out.push_str(&format!("\n## {}\n{}\n", f.path, f.content.trim()));
    }
    out
}

fn slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if (c == '-' || c == '_') && !out.ends_with(['-', '_']) {
            out.push(c);
        }
        if out.len() >= 32 {
            break;
        }
    }
    out.trim_matches(['-', '_']).to_string()
}

fn extract_json(reply: &str) -> Result<Value, String> {
    let trimmed = reply.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after).trim_start_matches(['\r', '\n']);
        if let Some(end) = after.find("```") {
            let block = after[..end].trim();
            if let Ok(v) = serde_json::from_str::<Value>(block) {
                return Ok(v);
            }
        }
    }
    if let (Some(a), Some(b)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if b > a {
            if let Ok(v) = serde_json::from_str::<Value>(&trimmed[a..=b]) {
                return Ok(v);
            }
        }
    }
    Err("Pi did not return JSON for the draft".into())
}

fn filter_known(items: &[String], allowed: &[String]) -> Vec<String> {
    items
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty() && allowed.iter().any(|a| a == s))
        .fold(Vec::new(), |mut acc, s| {
            if !acc.contains(&s) {
                acc.push(s);
            }
            acc
        })
}

fn ensure_default_mcps(mcps: Vec<String>, available: &[String]) -> Vec<String> {
    let mut out = if mcps.is_empty() {
        crate::mcp_client::with_default_persona_mcps(None)
            .into_iter()
            .filter(|m| available.iter().any(|a| a == m))
            .collect()
    } else {
        mcps
    };
    for m in crate::mcp_client::DEFAULT_PERSONA_MCPS {
        if available.iter().any(|a| a == *m) && !out.iter().any(|x| x == *m) {
            out.push((*m).to_string());
        }
    }
    out
}

pub fn parse_agent_draft(reply: &str, ctx: &DraftContext) -> Result<AgentDraft, String> {
    let v = extract_json(reply)?;
    let mut draft: AgentDraft = serde_json::from_value(v).map_err(|e| format!("bad agent draft JSON: {e}"))?;
    draft.name = slug(&draft.name);
    if draft.name.is_empty() {
        return Err("draft needs a name".into());
    }
    draft.prompt = draft.prompt.trim().to_string();
    if draft.prompt.is_empty() {
        return Err("draft needs a prompt".into());
    }
    draft.mcps = ensure_default_mcps(filter_known(&draft.mcps, &ctx.available_mcps), &ctx.available_mcps);
    draft.skills = filter_known(&draft.skills, &ctx.available_skills);
    draft.delegates = draft
        .delegates
        .into_iter()
        .map(|d| slug(&d))
        .filter(|d| !d.is_empty() && d != &draft.name)
        .collect();
    if !draft.mcps.iter().any(|m| m == "agents") {
        draft.delegates.clear();
    }
    match draft.listen.as_deref() {
        Some("all") => {}
        _ => draft.listen = None,
    }
    match draft.respond_to.as_deref() {
        Some("people") => {}
        _ => draft.respond_to = None,
    }
    if draft.model.as_ref().is_some_and(|m| m.trim().is_empty()) {
        draft.model = None;
    }
    Ok(draft)
}

pub fn parse_skill_draft(reply: &str, ctx: &DraftContext) -> Result<SkillDraft, String> {
    let v = extract_json(reply)?;
    let mut draft: SkillDraft = serde_json::from_value(v).map_err(|e| format!("bad skill draft JSON: {e}"))?;
    draft.name = slug(&draft.name).replace('_', "-");
    if !skills::valid_name(&draft.name) {
        return Err("draft needs a valid skill name (lowercase letters, digits or -)".into());
    }
    draft.description = draft.description.trim().to_string();
    draft.body = draft.body.trim().to_string();
    if draft.body.is_empty() {
        return Err("draft needs instructions (body)".into());
    }
    if draft.description.is_empty() {
        draft.description = draft.name.clone();
    }
    draft.mcps = filter_known(&draft.mcps, &ctx.available_mcps);
    draft.files.retain(|f| crate::skills::valid_file_path(&f.path) && f.content.len() <= 200_000);
    Ok(draft)
}

fn agent_instructions(ctx: &DraftContext, improve: bool) -> String {
    let mcps = ctx.available_mcps.join(", ");
    let skills = if ctx.available_skills.is_empty() {
        "(none yet)".into()
    } else {
        ctx.available_skills.join(", ")
    };
    let mode = if improve {
        "Improve the existing agent draft using the brief. Keep what still fits; rewrite what does not."
    } else {
        "Create a new agent persona from the brief."
    };
    format!(
        r#"You draft Google Chat agents for Switchboard (Pi runtime only).
{mode}

Rules:
- Reply with ONLY one JSON object (no markdown, no commentary).
- name: short handle, lowercase letters/digits/-/_ , max 32, no @.
- prompt: concise role + know-how in the brief's language (default English; 2–8 sentences). Prefer putting reusable procedures in skills when a matching skill exists.
- listen: omit or "all" (listens to every message). Default omit = only @mentions.
- respondTo: omit or "people" (ignore other agents). Default omit = anyone.
- skills: subset of [{skills}] — only when clearly useful.
- mcps: subset of [{mcps}] — only tools this agent needs. Always include "engram" when it is in that list. Prefer an explicit short list when the role is narrow.
- delegates: other agent names this one may ask (only if "agents" is in mcps).
- model: omit unless the brief names one.

JSON shape:
{{"name":"ventas","prompt":"...","listen":"all","respondTo":"people","skills":[],"mcps":["google-drive","engram"],"delegates":[]}}"#
    )
}

fn skill_instructions(ctx: &DraftContext, improve: bool) -> String {
    let mcps = ctx.available_mcps.join(", ");
    let mode = if improve {
        "Improve the existing skill pack using the brief. Keep what still fits; rewrite what does not."
    } else {
        "Create a new skill pack (SKILL.md + optional references/) from the brief."
    };
    let guide = skill_creator_guide();
    format!(
        r#"You draft reusable skill packs for Switchboard agents (Pi runtime). You are steered by the skill-creator pack.
{mode}

Rules:
- Reply with ONLY one JSON object (no markdown, no commentary).
- name: lowercase letters, digits or - only (no underscores), max 40.
- description: pushy trigger text — what it does AND when to use it (edge cases welcome).
- body: imperative markdown — workflow, why it matters, when to open references. Point to files by path.
- mcps: subset of [{mcps}] that this pack needs. Empty is fine.
- files: optional array of {{"path":"references/foo.md","content":"..."}}. Prefer moving long domain docs into references/.

JSON shape:
{{"name":"cotizaciones","description":"Precios y planes. Use whenever the user mentions quotes, pricing, or discounts.","mcps":["google-drive"],"body":"...","files":[{{"path":"references/discounts.md","content":"..."}}]}}{guide}"#
    )
}

fn user_text(brief: &str, current_json: Option<&str>) -> String {
    match current_json {
        Some(cur) if !cur.trim().is_empty() => format!("Brief:\n{}\n\nCurrent draft JSON:\n{}", brief.trim(), cur.trim()),
        _ => format!("Brief:\n{}", brief.trim()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatReply {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<AgentDraft>,
    #[serde(default)]
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillChatReply {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<SkillDraft>,
    #[serde(default)]
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct HostDraft {
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcps: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostChatReply {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<HostDraft>,
    #[serde(default)]
    pub ready: bool,
}

fn chat_history_text(messages: &[DraftChatMessage], current_json: Option<&str>) -> String {
    let mut out = String::from("Conversation so far:\n");
    for m in messages {
        let role = match m.role.trim().to_ascii_lowercase().as_str() {
            "assistant" => "assistant",
            _ => "user",
        };
        out.push_str(&format!("\n[{role}]\n{}\n", m.content.trim()));
    }
    if let Some(cur) = current_json.filter(|c| !c.trim().is_empty()) {
        out.push_str("\nCurrent draft JSON (may be incomplete; refine it):\n");
        out.push_str(cur);
        out.push('\n');
    }
    out.push_str("\nReply with ONLY one JSON object for this next turn.");
    out
}

fn agent_chat_instructions(ctx: &DraftContext) -> String {
    let mcps = ctx.available_mcps.join(", ");
    let skills = if ctx.available_skills.is_empty() {
        "(none yet)".into()
    } else {
        ctx.available_skills.join(", ")
    };
    format!(
        r#"You help the user create OR improve a Google Chat agent for Switchboard (Pi runtime).

Goal: clarify what they want, then produce a solid draft. When a Current draft JSON is provided, treat this as an EDIT — keep the name, preserve what still fits, change only what the user asks.

Rules:
- Reply with ONLY one JSON object (no markdown fences, no commentary outside JSON).
- Shape: {{"message":"...","draft":{{...}}|null,"ready":false|true}}
- message: short, in the user's language (default English). Ask at most 2 focused questions when info is missing. When updating the draft, say what changed.
- draft: null only for a brand-new agent with no name/role yet. If a current draft exists, ALWAYS return a full updated draft.
- ready: true when name + prompt are clear enough to save (edits can be ready right after a clear change).
- Draft fields:
  - name: short handle, lowercase letters/digits/-/_ , max 32, no @. On edit, keep the existing name unless the user renames.
  - prompt: concise role + know-how (2–8 sentences). Prefer reusable procedures in skills when a matching skill exists.
  - listen: omit or "all". Default omit = only @mentions.
  - respondTo: omit or "people". Default omit = anyone.
  - skills: subset of [{skills}] — only when clearly useful.
  - mcps: subset of [{mcps}]. Always include "engram" when available. Prefer a short explicit list for narrow roles.
  - delegates: other agent names only if "agents" is in mcps.
  - model: omit unless the user names one.

Example (edit):
{{"message":"Shortened the role and limited Can ask to @finanzas. Ready to save?","draft":{{"name":"soporte","prompt":"...","listen":"all","skills":["soporte"],"mcps":["switchboard","engram","agents"],"delegates":["finanzas"]}},"ready":true}}"#
    )
}

fn host_chat_instructions(ctx: &DraftContext) -> String {
    let mcps = ctx.available_mcps.join(", ");
    let skills = if ctx.available_skills.is_empty() {
        "(none yet)".into()
    } else {
        ctx.available_skills.join(", ")
    };
    format!(
        r#"You help the user create OR improve the host agent for Switchboard (the main Pi agent — it can code and use tools).

The host system prompt is fully editable (Switchi). A live room roster is appended automatically each turn — do not invent roster lines.

Goal: clarify what they want, then produce a solid draft. When a Current draft JSON is provided, treat this as an EDIT — preserve what still fits, change only what the user asks.

Rules:
- Reply with ONLY one JSON object (no markdown fences, no commentary outside JSON).
- Shape: {{"message":"...","draft":{{"prompt":"...","mcps":[],"skills":[]}}|null,"ready":false|true}}
- message: short, in the user's language (default English). Ask at most 2 focused questions when info is missing. When updating, say what changed.
- draft: if a current draft exists, ALWAYS return a full updated draft. Otherwise null until you have something useful.
- ready: true when the prompt is clear enough to save (edits can be ready immediately after a clear change).
- prompt: full host system prompt (2–12 sentences). Keep @mention / PASS / invite_agent behavior unless the user wants a change.
- mcps: subset of [{mcps}]. Empty = every tool (Switchi default).
- skills: subset of [{skills}]. Default includes artifacts when useful.

Example (edit):
{{"message":"Made the host prefer Spanish and keep all tools. Ready to save?","draft":{{"prompt":"You are Switchi… Prefer Spanish.","mcps":[],"skills":["artifacts"]}},"ready":true}}"#
    )
}

fn skill_chat_instructions(ctx: &DraftContext) -> String {
    let mcps = ctx.available_mcps.join(", ");
    let guide = skill_creator_guide();
    format!(
        r#"You help the user create OR improve a reusable skill pack in Create → Skills. Follow the skill-creator pack below.

Goal: clarify the procedure, then produce a solid draft. When a Current draft JSON is provided, treat this as an EDIT — keep the name, preserve what still fits, change only what the user asks (or clear gaps).

Rules:
- Reply with ONLY one JSON object (no markdown fences, no commentary outside JSON).
- Shape: {{"message":"...","draft":{{...}}|null,"ready":false|true}}
- message: short, in the user's language (default English). Ask at most 2 focused questions when info is missing. When updating the draft, say what changed.
- draft: null only for a brand-new skill with no name/procedure yet. If a current draft exists, ALWAYS return a full updated draft (merge edits into the whole skill, including files you keep).
- ready: true when name + body are clear enough to save (edits can be ready immediately after a clear change).
- Draft fields:
  - name: lowercase letters, digits or - only (no underscores), max 40. On edit, keep the existing name unless the user renames.
  - description: pushy — what it does AND when to trigger.
  - body: lean imperative markdown; point to references/ for long docs.
  - mcps: subset of [{mcps}] that this pack needs. Empty is fine.
  - files: optional [{{"path":"references/x.md","content":"..."}}]. On edit, include files you still want; omit only those the user asked to remove.

Example (edit):
{{"message":"Updated the SLA reference and tightened the body. Ready to save?","draft":{{"name":"soporte","description":"…","mcps":["switchboard"],"body":"…","files":[{{"path":"references/sla.md","content":"…"}}]}},"ready":true}}{guide}"#
    )
}

fn parse_agent_chat_reply(reply: &str, ctx: &DraftContext) -> Result<AgentChatReply, String> {
    let v = extract_json(reply)?;
    let message = v
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Ready — review the draft.")
        .to_string();
    let ready = v.get("ready").and_then(|r| r.as_bool()).unwrap_or(false);
    let draft = match v.get("draft") {
        None | Some(Value::Null) => None,
        Some(d) => Some(parse_agent_draft(&d.to_string(), ctx)?),
    };
    let ready = ready && draft.as_ref().is_some_and(|d| !d.name.is_empty() && !d.prompt.is_empty());
    Ok(AgentChatReply { message, draft, ready })
}

fn parse_skill_chat_reply(reply: &str, ctx: &DraftContext) -> Result<SkillChatReply, String> {
    let v = extract_json(reply)?;
    let message = v
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Ready — review the draft.")
        .to_string();
    let ready = v.get("ready").and_then(|r| r.as_bool()).unwrap_or(false);
    let draft = match v.get("draft") {
        None | Some(Value::Null) => None,
        Some(d) => Some(parse_skill_draft(&d.to_string(), ctx)?),
    };
    let ready = ready && draft.as_ref().is_some_and(|d| !d.name.is_empty() && !d.body.is_empty());
    Ok(SkillChatReply { message, draft, ready })
}

fn parse_host_chat_reply(reply: &str, ctx: &DraftContext) -> Result<HostChatReply, String> {
    let v = extract_json(reply)?;
    let message = v
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Ready — review the draft.")
        .to_string();
    let ready = v.get("ready").and_then(|r| r.as_bool()).unwrap_or(false);
    let draft = match v.get("draft") {
        None | Some(Value::Null) => None,
        Some(d) => {
            let prompt = d
                .get("prompt")
                .and_then(|p| p.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            if prompt.is_empty() {
                None
            } else {
                let mcps = d
                    .get("mcps")
                    .and_then(|m| m.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let skills = d
                    .get("skills")
                    .and_then(|m| m.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Some(HostDraft {
                    prompt,
                    mcps: filter_known(&mcps, &ctx.available_mcps),
                    skills: filter_known(&skills, &ctx.available_skills),
                })
            }
        }
    };
    let ready = ready && draft.as_ref().is_some_and(|d| !d.prompt.is_empty());
    Ok(HostChatReply { message, draft, ready })
}

fn validate_chat_messages(messages: &[DraftChatMessage]) -> Result<(), String> {
    if messages.is_empty() {
        return Err("send at least one message".into());
    }
    let last = messages.last().unwrap();
    if !last.role.eq_ignore_ascii_case("user") {
        return Err("last message must be from the user".into());
    }
    if last.content.trim().chars().count() < 1 {
        return Err("message cannot be empty".into());
    }
    if messages.iter().map(|m| m.content.len()).sum::<usize>() > 24_000 {
        return Err("conversation is too long — start a new one".into());
    }
    Ok(())
}

async fn run_draft(driver: &Arc<dyn AgentDriver>, thread_key: &str, instructions: String, text: String, ctx: &DraftContext) -> Result<String, String> {
    let out = driver
        .run_turn(AgentTurnInput {
            thread_key: thread_key.into(),
            session_ref: None,
            text,
            workdir: ctx.workdir.clone(),
            model: ctx.model.clone(),
            agent: None,
            driver: None,
            answer_questions: false,
            request_id: Some(format!("{thread_key}:{}", uuid::Uuid::new_v4())),
            mcps_override: Some(vec![]),
            instructions_override: Some(instructions),
        })
        .await?;
    Ok(out.reply)
}

pub async fn draft_agent(
    driver: &Arc<dyn AgentDriver>,
    brief: &str,
    current: Option<&AgentDraft>,
    ctx: &DraftContext,
) -> Result<AgentDraft, String> {
    if brief.trim().chars().count() < 3 {
        return Err("brief needs at least 3 characters".into());
    }
    let improve = current.is_some();
    let cur = current.map(|c| serde_json::to_string_pretty(c).unwrap_or_default());
    let reply = run_draft(
        driver,
        "ai-draft/agent",
        agent_instructions(ctx, improve),
        user_text(brief, cur.as_deref()),
        ctx,
    )
    .await?;
    parse_agent_draft(&reply, ctx)
}

pub async fn draft_skill(
    driver: &Arc<dyn AgentDriver>,
    brief: &str,
    current: Option<&SkillDraft>,
    ctx: &DraftContext,
) -> Result<SkillDraft, String> {
    if brief.trim().chars().count() < 3 {
        return Err("brief needs at least 3 characters".into());
    }
    let improve = current.is_some();
    let cur = current.map(|c| serde_json::to_string_pretty(c).unwrap_or_default());
    let reply = run_draft(
        driver,
        "ai-draft/skill",
        skill_instructions(ctx, improve),
        user_text(brief, cur.as_deref()),
        ctx,
    )
    .await?;
    parse_skill_draft(&reply, ctx)
}

pub async fn draft_agent_chat(
    driver: &Arc<dyn AgentDriver>,
    messages: &[DraftChatMessage],
    current: Option<&AgentDraft>,
    ctx: &DraftContext,
) -> Result<AgentChatReply, String> {
    validate_chat_messages(messages)?;
    let cur = current.map(|c| serde_json::to_string_pretty(c).unwrap_or_default());
    let reply = run_draft(
        driver,
        "ai-draft/chat-agent",
        agent_chat_instructions(ctx),
        chat_history_text(messages, cur.as_deref()),
        ctx,
    )
    .await?;
    parse_agent_chat_reply(&reply, ctx)
}

pub async fn draft_skill_chat(
    driver: &Arc<dyn AgentDriver>,
    messages: &[DraftChatMessage],
    current: Option<&SkillDraft>,
    ctx: &DraftContext,
) -> Result<SkillChatReply, String> {
    validate_chat_messages(messages)?;
    let cur = current.map(|c| serde_json::to_string_pretty(c).unwrap_or_default());
    let reply = run_draft(
        driver,
        "ai-draft/chat-skill",
        skill_chat_instructions(ctx),
        chat_history_text(messages, cur.as_deref()),
        ctx,
    )
    .await?;
    parse_skill_chat_reply(&reply, ctx)
}

pub async fn draft_host_chat(
    driver: &Arc<dyn AgentDriver>,
    messages: &[DraftChatMessage],
    current: Option<&HostDraft>,
    ctx: &DraftContext,
) -> Result<HostChatReply, String> {
    validate_chat_messages(messages)?;
    let cur = current.map(|c| serde_json::to_string_pretty(c).unwrap_or_default());
    let reply = run_draft(
        driver,
        "ai-draft/chat-host",
        host_chat_instructions(ctx),
        chat_history_text(messages, cur.as_deref()),
        ctx,
    )
    .await?;
    parse_host_chat_reply(&reply, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> DraftContext {
        DraftContext {
            available_mcps: vec!["coding".into(), "google-drive".into(), "agents".into(), "engram".into()],
            available_skills: vec!["finanzas".into()],
            workdir: ".".into(),
            model: None,
        }
    }

    #[test]
    fn skill_creator_is_not_attachable_to_agents() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("skill-creator")).unwrap();
        std::fs::write(
            dir.path().join("skill-creator/SKILL.md"),
            "---\nname: skill-creator\ndescription: meta\n---\nGuide.\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("finanzas")).unwrap();
        std::fs::write(dir.path().join("finanzas/SKILL.md"), "---\nname: finanzas\n---\nBody.\n").unwrap();
        crate::skills::set_dirs(vec![dir.path().to_path_buf()]);
        let names = available_skill_names();
        assert!(names.contains(&"finanzas".into()));
        assert!(!names.contains(&"skill-creator".into()));
        assert!(!skill_creator_guide().is_empty());
    }

    #[test]
    fn parses_fenced_agent_json_and_filters_unknown() {
        let reply = r#"Here you go:
```json
{"name":"@Ventas_Pro","prompt":"Ayuda con cotizaciones.","mcps":["google-drive","nope"],"skills":["finanzas","ghost"],"listen":"all","respondTo":"anyone"}
```
"#;
        let d = parse_agent_draft(reply, &ctx()).unwrap();
        assert_eq!(d.name, "ventas_pro");
        assert_eq!(d.mcps, vec!["google-drive", "engram"]);
        assert_eq!(d.skills, vec!["finanzas"]);
        assert_eq!(d.listen.as_deref(), Some("all"));
        assert!(d.respond_to.is_none());
    }

    #[test]
    fn empty_agent_mcps_default_to_engram_when_available() {
        let reply = r#"{"name":"memo","prompt":"Recuerda.","mcps":[]}"#;
        let d = parse_agent_draft(reply, &ctx()).unwrap();
        assert_eq!(d.mcps, vec!["engram"]);
    }

    #[test]
    fn parses_skill_and_rejects_bad_name() {
        let ok = parse_skill_draft(
            r#"{"name":"cotizaciones","description":"Precios","mcps":["google-drive","x"],"body":"No inventar precios."}"#,
            &ctx(),
        )
        .unwrap();
        assert_eq!(ok.name, "cotizaciones");
        assert_eq!(ok.mcps, vec!["google-drive"]);
        assert!(parse_skill_draft(r#"{"name":"@@@","description":"x","body":"y"}"#, &ctx()).is_err());
        assert!(parse_skill_draft(r#"{"name":"ok","description":"x","body":""}"#, &ctx()).is_err());
    }

    #[test]
    fn extract_json_from_raw_object() {
        let v = extract_json("prefix {\"name\":\"a\",\"prompt\":\"p\"} suffix").unwrap();
        assert_eq!(v["name"], "a");
    }

    #[test]
    fn parses_agent_chat_reply_with_null_draft() {
        let r = parse_agent_chat_reply(
            r#"{"message":"Mentions only?","draft":null,"ready":false}"#,
            &ctx(),
        )
        .unwrap();
        assert_eq!(r.message, "Mentions only?");
        assert!(r.draft.is_none());
        assert!(!r.ready);
    }

    #[test]
    fn ready_requires_valid_draft() {
        let r = parse_agent_chat_reply(
            r#"{"message":"ok","draft":{"name":"ventas","prompt":"Vende.","mcps":["google-drive"]},"ready":true}"#,
            &ctx(),
        )
        .unwrap();
        assert!(r.ready);
        assert_eq!(r.draft.as_ref().unwrap().name, "ventas");
    }
}
