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

pub fn available_skill_names() -> Vec<String> {
    skills::available().into_iter().map(|s| s.name).collect()
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
- prompt: concise role + know-how in Spanish or the brief's language (2–8 sentences). Prefer putting reusable procedures in skills when a matching skill exists.
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
        "Create a new skill pack (SKILL.md) from the brief."
    };
    format!(
        r#"You draft reusable skill packs for Switchboard agents (Pi runtime).
{mode}

Rules:
- Reply with ONLY one JSON object (no markdown, no commentary).
- name: lowercase letters, digits or - only (no underscores), max 40.
- description: one short line.
- body: markdown instructions — what to do, never do, and how to answer.
- mcps: subset of [{mcps}] that this pack needs. Empty is fine.

JSON shape:
{{"name":"cotizaciones","description":"Precios y planes","mcps":["google-drive"],"body":"..."}}"#
    )
}

fn user_text(brief: &str, current_json: Option<&str>) -> String {
    match current_json {
        Some(cur) if !cur.trim().is_empty() => format!("Brief:\n{}\n\nCurrent draft JSON:\n{}", brief.trim(), cur.trim()),
        _ => format!("Brief:\n{}", brief.trim()),
    }
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
}
