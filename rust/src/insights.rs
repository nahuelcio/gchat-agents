use std::sync::Arc;

use serde_json::{json, Value};

use crate::ai_draft::DraftContext;
use crate::driver::types::AgentDriver;
use crate::session::SessionStore;

pub fn labels(store: &SessionStore) -> Value {
    let mut out = serde_json::Map::new();
    for (key, rec) in store.all() {
        let thread = rec.title.clone().map(|t| format!("{key} ({t})")).unwrap_or_else(|| key.clone());
        let host = if key.starts_with("schedule/") { "schedule" } else if key.starts_with("ai-draft/") { "ai-draft" } else { "host" };
        let repos = crate::handler::thread_repos(Some(&rec));
        if let Some(r) = &rec.session_ref {
            out.insert(r.clone(), json!({ "thread": thread, "agent": host, "repos": repos }));
        }
        for (persona, r) in rec.persona_sessions.clone().unwrap_or_default() {
            out.insert(r, json!({ "thread": thread, "agent": persona, "repos": repos }));
        }
    }
    Value::Object(out)
}

pub async fn collect(store: &SessionStore, days: u32, filter: Value, versions: &[crate::versions::Version]) -> Result<Value, String> {
    let versions: Vec<Value> = versions.iter().map(|v| json!({ "agent": v.agent, "id": v.id, "at": v.at, "harness": v.harness })).collect();
    crate::pi_sidecar::call(reqwest::Method::POST, "/insights", Some(json!({ "days": days, "labels": labels(store), "filter": filter, "versions": versions }))).await
}

const TALK_INSTRUCTIONS: &str = r#"You are reading what people actually talk about with the agents of Switchboard, a team chat-ops harness. You get condensed recent exchanges (user message, tools the agent called, the agent's reply, cost) plus per-agent stats.

Work out:
- Topics: what people ask about, grouped and counted, with one example quote each. Which repos, products and areas come up.
- Recurring questions or tasks that could become a skill, a schedule (digest, report), a template or a dedicated agent.
- Friction: misunderstandings, users repeating or correcting themselves, answers that were too long, off-topic or ignored the question, agents that jumped in when not asked.
- Gaps: things people asked for that the agents could not do (missing tool, missing access, missing knowledge).
- Tone and language: what language and register people use, and whether the agents match it.

Rules: quote the exchanges briefly as evidence, give counts, no generic advice. For each idea give the concrete change (prompt text, skill to create, schedule to add, tool to connect).

Answer in the language the users write in, as Markdown:
## Resumen (3 lines max)
## De qué se habla: table Tema | Veces | Ejemplo
## Fricciones: numbered, with **Evidencia** and **Cambio propuesto**
## Oportunidades: numbered (skill, schedule, agente o tool), each with the exact proposal
"#;

pub async fn analyze_talk(driver: &Arc<dyn AgentDriver>, digest: &Value, focus: &str, ctx: &DraftContext) -> Result<String, String> {
    let slim = json!({ "days": digest.get("days"), "agents": digest.get("agents"), "exchanges": digest.get("exchanges") });
    let mut data = serde_json::to_string(&slim).map_err(|e| e.to_string())?;
    if data.len() > 150_000 {
        let mut s = slim.clone();
        if let Some(ex) = s.get_mut("exchanges").and_then(|e| e.as_array_mut()) {
            ex.truncate(40);
        }
        data = serde_json::to_string(&s).map_err(|e| e.to_string())?;
    }
    let focus = focus.trim();
    let head = if focus.is_empty() { String::new() } else { format!("Focus especially on: {focus}\n\n") };
    crate::ai_draft::run_draft(driver, "ai-draft/insights-talk", TALK_INSTRUCTIONS.to_string(), format!("{head}Conversations:\n```json\n{data}\n```"), ctx).await
}

const INSTRUCTIONS: &str = r#"You are reviewing how a team uses LLM agents inside Switchboard, a chat-ops harness (Google Chat and a web team chat) running on the pi-durable harness. Hosts answer threads; personas (named agents) join rooms and must reply exactly PASS when a message is not for them; tools come from coding tools, MCP servers, pi.dev packages and codemode (scripts calling tools).

You get a JSON digest of real usage: totals, per-model and per-agent cost and tokens, per-tool calls, errors and payload sizes, the system prompts actually sent (with how often), the size of the codemode tool catalogue, error samples, and recent condensed exchanges.

Find concrete, evidence-backed improvements. Look for:
- System prompts: length vs. value, duplicated or contradictory rules, missing guidance that explains observed failures, language/tone mismatches with the users, rules the model visibly ignores.
- Tools: tools that fail often (and why, from the error samples), tools never used (dead weight in context), huge results or arguments that bloat context, missing tools the exchanges clearly needed, oversized tool catalogues.
- Prompting and flow: wasted turns (PASS rounds that cost tokens, empty replies), large inputs per call, low cache reuse, user messages that lead to retries, model choice per agent (cheaper model where quality is enough, stronger where it fails).
- Skills and files the agents reference that do not exist.

Rules:
- Every finding cites numbers or quotes from the digest. No generic advice.
- Prefer few, high-impact findings over many small ones. If the data is thin, say what to measure next.
- For each finding give the exact change: the text to add/remove in a prompt, the tool to drop or fix, the setting to change.

Answer in the language most users write in (look at the exchanges), as Markdown:
## Resumen (3 lines max)
## Hallazgos — numbered, each with **Área** (System prompt | Tools | Prompting | Modelo | Skills), **Evidencia**, **Cambio propuesto**, **Impacto** (alto/medio/bajo)
## Qué medir después
"#;

pub async fn collect_engram(project: Option<&str>) -> Result<Value, String> {
    let path = match project.filter(|p| !p.is_empty()) {
        Some(p) => {
            let mut url = reqwest::Url::parse("http://x/insights/engram").map_err(|e| e.to_string())?;
            url.query_pairs_mut().append_pair("project", p);
            format!("{}?{}", url.path(), url.query().unwrap_or(""))
        }
        None => "/insights/engram".into(),
    };
    crate::pi_sidecar::call(reqwest::Method::GET, &path, None).await
}

const ENGRAM_INSTRUCTIONS: &str = r#"You are auditing Engram, the persistent memory a developer's coding agents (Claude Code, Switchboard agents and others) write to across all their projects. You get the whole store as JSON: totals, counts by project/type/scope/source, relations between memories (judged and pending), same-title groups, repeated topic keys, the largest entries, recent user prompts, session summaries, and every live observation with a snippet.

Analyse everything, in two parts.

Part 1, memory health:
- Duplicates and near-duplicates (same or similar titles, same topic, same fact saved in several projects); say which ids to merge or delete.
- Noise: passive or auto-captured entries with little reuse value, overly long entries, session summaries that repeat each other, wrong project names (typos, split projects that are really one).
- Contradictions and stale facts: entries a later one supersedes; pending relations that should be judged and how.
- Hygiene: sessions never closed or summarised, scope misuse (personal vs project), nothing pinned that clearly should be, missing topic keys on evolving subjects.

Part 2, what the memory teaches about how this person works with agents:
- Recurring bugs, mistakes and gotchas across sessions and projects: each one is a candidate rule for a system prompt, AGENTS.md/CLAUDE.md, a coding standard or an automated check. Write the rule.
- Repeated decisions and conventions that should become a skill or a project doc.
- Tool and harness friction (shells, quoting, ports, builds, MCPs) that better tools or instructions would remove.
- How the agents use memory itself: what they save too much, too little, or in the wrong shape; propose a concrete saving policy.

Rules: cite ids, titles, counts. No generic advice. Prefer the few changes with the most leverage.

Answer in the language most entries are written in, as Markdown:
## Resumen (3 lines max)
## Salud de la memoria: numbered findings with **Evidencia** (ids) and **Acción** (merge/delete/judge/rename, exact)
## Lecciones para los agentes: numbered, each with **Evidencia**, **Dónde va** (system prompt | AGENTS.md | skill | check | tool) and the exact text or change
## Política de guardado propuesta (short)
"#;

pub async fn analyze_engram(driver: &Arc<dyn AgentDriver>, digest: &Value, focus: &str, ctx: &DraftContext) -> Result<String, String> {
    let data = serde_json::to_string(digest).map_err(|e| e.to_string())?;
    if data.len() > 400_000 {
        return Err("the Engram store is too large to analyse in one pass".into());
    }
    let focus = focus.trim();
    let head = if focus.is_empty() { String::new() } else { format!("Focus especially on: {focus}\n\n") };
    crate::ai_draft::run_draft(driver, "ai-draft/insights-engram", ENGRAM_INSTRUCTIONS.to_string(), format!("{head}Engram store:\n```json\n{data}\n```"), ctx).await
}

pub async fn analyze(driver: &Arc<dyn AgentDriver>, digest: &Value, focus: &str, ctx: &DraftContext) -> Result<String, String> {
    let mut data = serde_json::to_string(digest).map_err(|e| e.to_string())?;
    if data.len() > 120_000 {
        let mut slim = digest.clone();
        if let Some(ex) = slim.get_mut("exchanges").and_then(|e| e.as_array_mut()) {
            ex.truncate(10);
        }
        if let Some(p) = slim.get_mut("prompts").and_then(|e| e.as_array_mut()) {
            p.truncate(4);
        }
        data = serde_json::to_string(&slim).map_err(|e| e.to_string())?;
        data.truncate(120_000);
    }
    let focus = focus.trim();
    let text = if focus.is_empty() {
        format!("Usage digest:\n```json\n{data}\n```")
    } else {
        format!("Focus especially on: {focus}\n\nUsage digest:\n```json\n{data}\n```")
    };
    crate::ai_draft::run_draft(driver, "ai-draft/insights", INSTRUCTIONS.to_string(), text, ctx).await
}
