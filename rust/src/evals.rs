use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ai_draft::DraftContext;
use crate::atomic::write_atomic;
use crate::driver::types::{AgentDriver, AgentTurnInput};
use crate::handler::TurnOptions;
use crate::personas::{host_preamble, persona_preamble};

const MAX_RUNS: usize = 60;
const MAX_JUDGMENTS: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Expect {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contains: Vec<String>,
    #[serde(default, rename = "notContains", skip_serializing_if = "Vec::is_empty")]
    pub not_contains: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rubric: Option<String>,
    #[serde(default, rename = "maxCost", skip_serializing_if = "Option::is_none")]
    pub max_cost: Option<f64>,
    #[serde(default, rename = "maxSeconds", skip_serializing_if = "Option::is_none")]
    pub max_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Case {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub expect: Expect,
    /// The reply that was rated, when the case came from a chat vote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// "up" or "down".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseResult {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub pass: bool,
    #[serde(default)]
    pub checks: Vec<Check>,
    pub reply: String,
    pub seconds: f64,
    pub cost: f64,
    #[serde(rename = "tokensIn")]
    pub tokens_in: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub pass: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub status: String,
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub versions: std::collections::BTreeMap<String, String>,
    pub total: usize,
    pub results: Vec<CaseResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Judgment {
    pub id: String,
    pub at: String,
    #[serde(rename = "judgedAt")]
    pub judged_at: String,
    pub agent: String,
    pub model: String,
    pub prompt: String,
    pub resolved: f64,
    pub instructions: f64,
    pub tools: f64,
    pub concise: f64,
    pub note: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    cases: Vec<Case>,
    #[serde(default)]
    runs: Vec<Run>,
    #[serde(default)]
    judgments: Vec<Judgment>,
}

pub struct EvalStore {
    path: PathBuf,
    data: Mutex<Data>,
}

impl EvalStore {
    pub fn open(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    async fn save(&self) -> Result<(), String> {
        let body = serde_json::to_string_pretty(&*self.data.lock().unwrap()).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &body).await.map_err(|e| e.to_string())
    }

    pub fn cases(&self) -> Vec<Case> {
        self.data.lock().unwrap().cases.clone()
    }

    pub async fn set_cases(&self, mut cases: Vec<Case>) -> Result<Vec<Case>, String> {
        for c in &mut cases {
            c.name = c.name.trim().to_string();
            c.prompt = c.prompt.trim().to_string();
            if c.prompt.is_empty() {
                return Err(format!("case \"{}\" has no prompt", c.name));
            }
            if c.id.trim().is_empty() {
                c.id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
            }
            if c.name.is_empty() {
                c.name = c.prompt.chars().take(40).collect();
            }
        }
        self.data.lock().unwrap().cases = cases.clone();
        self.save().await?;
        Ok(cases)
    }

    /// A 👍 or 👎 on a real reply becomes a case. The prompt is the user's message; the sample is the reply.
    pub async fn add_feedback(&self, prompt: &str, reply: &str, vote: &str, reason: Option<&str>, agent: &str) -> Result<Case, String> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err("feedback needs the user message".into());
        }
        let vote = if vote == "up" { "up" } else { "down" };
        let reason = reason.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let sample: String = reply.chars().take(8000).collect();
        let mut rubric = if vote == "down" {
            "The previous reply was rejected. A new reply should fix that.".to_string()
        } else {
            "The previous reply was accepted. A new reply should be at least as helpful.".to_string()
        };
        if let Some(why) = &reason {
            rubric.push_str(" Reason: ");
            rubric.push_str(why);
        }
        rubric.push_str("\nSample reply:\n");
        rubric.push_str(&sample);
        let case = Case {
            id: String::new(),
            name: format!("{vote} {}", prompt.chars().take(40).collect::<String>()),
            agent: agent.trim().trim_start_matches('@').to_string(),
            prompt: prompt.to_string(),
            expect: Expect { rubric: Some(rubric), ..Default::default() },
            sample: Some(sample),
            reason,
            vote: Some(vote.to_string()),
        };
        let mut cases = self.cases();
        cases.push(case);
        let saved = self.set_cases(cases).await?;
        saved.last().cloned().ok_or_else(|| "case was not saved".to_string())
    }

    pub fn runs(&self) -> Vec<Run> {
        self.data.lock().unwrap().runs.iter().rev().cloned().collect()
    }

    pub fn judgments(&self) -> Vec<Judgment> {
        self.data.lock().unwrap().judgments.clone()
    }

    async fn put_run(&self, run: &Run) -> Result<(), String> {
        {
            let mut d = self.data.lock().unwrap();
            match d.runs.iter_mut().find(|r| r.id == run.id) {
                Some(r) => *r = run.clone(),
                None => d.runs.push(run.clone()),
            }
            let n = d.runs.len();
            if n > MAX_RUNS {
                d.runs.drain(..n - MAX_RUNS);
            }
        }
        self.save().await
    }

    pub async fn delete_run(&self, id: &str) -> Result<(), String> {
        self.data.lock().unwrap().runs.retain(|r| r.id != id);
        self.save().await
    }

    async fn add_judgments(&self, js: Vec<Judgment>) -> Result<(), String> {
        {
            let mut d = self.data.lock().unwrap();
            for j in js {
                d.judgments.retain(|x| x.id != j.id);
                d.judgments.push(j);
            }
            let n = d.judgments.len();
            if n > MAX_JUDGMENTS {
                d.judgments.drain(..n - MAX_JUDGMENTS);
            }
        }
        self.save().await
    }
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn json_block(reply: &str, open: char, close: char) -> Option<&str> {
    let start = reply.find(open)?;
    let end = reply.rfind(close)?;
    (end > start).then(|| &reply[start..=end])
}

fn check_text(reply: &str, expect: &Expect) -> Vec<Check> {
    let low = reply.to_lowercase();
    let mut out = vec![];
    for c in &expect.contains {
        out.push(Check { name: format!("contains \"{c}\""), pass: low.contains(&c.to_lowercase()), detail: None });
    }
    for c in &expect.not_contains {
        out.push(Check { name: format!("does not contain \"{c}\""), pass: !low.contains(&c.to_lowercase()), detail: None });
    }
    out
}

const CASE_JUDGE: &str = r#"You grade one reply of a chat agent against a rubric. Be strict and literal: a reply that only partly meets the rubric does not pass.
Answer with JSON only: {"score": 1-5, "pass": true|false, "why": "one short sentence"}. pass is true only when score >= 4."#;

async fn judge_case(driver: &Arc<dyn AgentDriver>, case: &Case, rubric: &str, reply: &str, ctx: &DraftContext) -> Result<(f64, bool, String), String> {
    let text = format!("Rubric:\n{rubric}\n\nUser message:\n{}\n\nAgent reply:\n{reply}", case.prompt);
    let out = crate::ai_draft::run_draft(driver, "ai-draft/eval-judge", CASE_JUDGE.into(), text, ctx).await?;
    let v: Value = json_block(&out, '{', '}').and_then(|s| serde_json::from_str(s).ok()).ok_or_else(|| format!("judge gave no JSON: {}", out.chars().take(200).collect::<String>()))?;
    let score = v.get("score").and_then(Value::as_f64).unwrap_or(0.0);
    let pass = v.get("pass").and_then(Value::as_bool).unwrap_or(score >= 4.0);
    Ok((score, pass, v.get("why").and_then(Value::as_str).unwrap_or("").to_string()))
}

async fn run_case(driver: &Arc<dyn AgentDriver>, run_id: &str, case: &Case, model: Option<&str>, options: &TurnOptions, ctx: &DraftContext) -> CaseResult {
    let persona = options.personas.iter().find(|p| !case.agent.is_empty() && p.name.eq_ignore_ascii_case(case.agent.trim_start_matches('@')));
    let (text, agent_model, agent, driver_kind) = match persona {
        Some(p) => (format!("{}\n\n---\n\n{}", persona_preamble(p, &options.personas), case.prompt), p.model.clone(), p.agent.clone(), p.driver),
        None if options.personas.is_empty() => (case.prompt.clone(), options.default_model.clone(), None, Some(options.default_driver)),
        None => (
            format!("{}\n\n---\n\n{}", host_preamble(&options.personas, options.host_prompt.as_deref()), case.prompt),
            options.default_model.clone(),
            None,
            Some(options.default_driver),
        ),
    };
    let name = persona.map(|p| p.name.clone()).unwrap_or_else(|| "host".into());
    let start = Instant::now();
    let out = driver
        .run_turn(AgentTurnInput {
            thread_key: format!("eval/{run_id}/{}", case.id),
            session_ref: None,
            text,
            workdir: ctx.workdir.clone(),
            model: model.map(str::to_string).or(agent_model),
            agent,
            driver: driver_kind,
            answer_questions: false,
            request_id: Some(format!("eval/{run_id}/{}", case.id)),
            mcps_override: None,
            instructions_override: None,
            effort: None,
        })
        .await;
    let seconds = start.elapsed().as_secs_f64();
    let mut res = CaseResult { id: case.id.clone(), name: case.name.clone(), agent: name, pass: false, checks: vec![], reply: String::new(), seconds, cost: 0.0, tokens_in: 0, score: None, error: None };
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            res.error = Some(e);
            return res;
        }
    };
    res.reply = out.reply.clone();
    if let Some(u) = &out.usage {
        res.cost = u.cost_usd.unwrap_or(0.0);
        res.tokens_in = u.tokens_in.unwrap_or(u.context_tokens);
    }
    let e = &case.expect;
    res.checks.push(Check { name: "replied".into(), pass: !out.reply.trim().is_empty(), detail: None });
    res.checks.extend(check_text(&out.reply, e));
    if let Some(max) = e.max_cost {
        res.checks.push(Check { name: format!("cost ≤ ${max}"), pass: res.cost <= max, detail: Some(format!("${:.4}", res.cost)) });
    }
    if let Some(max) = e.max_seconds {
        res.checks.push(Check { name: format!("time ≤ {max}s"), pass: seconds <= max, detail: Some(format!("{seconds:.1}s")) });
    }
    if let Some(rubric) = e.rubric.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        match judge_case(driver, case, rubric, &out.reply, ctx).await {
            Ok((score, pass, why)) => {
                res.score = Some(score);
                res.checks.push(Check { name: "rubric".into(), pass, detail: Some(format!("{score}/5 · {why}")) });
            }
            Err(err) => res.checks.push(Check { name: "rubric".into(), pass: false, detail: Some(err) }),
        }
    }
    res.pass = res.checks.iter().all(|c| c.pass);
    res
}

#[allow(clippy::too_many_arguments)]
pub async fn start_run(store: Arc<EvalStore>, driver: Arc<dyn AgentDriver>, options: TurnOptions, ctx: DraftContext, model: Option<String>, label: Option<String>, only: Vec<String>, all: &[crate::versions::Version]) -> Result<Run, String> {
    let cases: Vec<Case> = store.cases().into_iter().filter(|c| only.is_empty() || only.contains(&c.id)).collect();
    if cases.is_empty() {
        return Err("add at least one case first".into());
    }
    let model = model.filter(|m| !m.trim().is_empty());
    let mut run = Run {
        id: chrono::Local::now().format("%Y%m%d-%H%M%S").to_string(),
        at: now(),
        model: model.clone(),
        label: label.filter(|l| !l.trim().is_empty()),
        status: "running".into(),
        harness: all.last().map(|v| v.harness.clone()).unwrap_or_default(),
        versions: cases
            .iter()
            .map(|c| if c.agent.is_empty() { "host".to_string() } else { c.agent.trim_start_matches('@').to_string() })
            .filter_map(|a| all.iter().rev().find(|v| v.agent.eq_ignore_ascii_case(&a)).map(|v| (v.agent.clone(), v.id.clone())))
            .collect(),
        total: cases.len(),
        results: vec![],
    };
    store.put_run(&run).await?;
    let first = run.clone();
    tokio::spawn(async move {
        for case in &cases {
            let r = run_case(&driver, &run.id, case, model.as_deref(), &options, &ctx).await;
            run.results.push(r);
            let _ = store.put_run(&run).await;
        }
        run.status = "done".into();
        let _ = store.put_run(&run).await;
    });
    Ok(first)
}

const SAMPLE_JUDGE: &str = r#"You are the evaluator of Switchboard, a team chat-ops harness where LLM agents answer people in chat threads. You get real exchanges: the user's message, the tools the agent called, the agent's final reply and any error.

Score each exchange from 1 to 5 on:
- resolved: did the reply actually answer or complete what was asked (5 = fully, 1 = not at all or wrong)
- instructions: did it respect what the user asked for (language, format, scope) and stay on topic
- tools: were the tool calls appropriate (5 = right tools or rightly none, 1 = needed tools were not used, or calls were wasteful or failing)
- concise: length and clarity fit for a chat message (5 = tight, 1 = rambling or padded)

Judge only from what you see; if the reply is cut short ("…"), judge the visible part. The note says, in a few words, the main problem or what went well, in the users' language.

Answer with a JSON array only, one object per exchange: [{"i": 0, "resolved": 1-5, "instructions": 1-5, "tools": 1-5, "concise": 1-5, "note": "..."}]"#;

pub async fn judge_sample(store: &EvalStore, driver: &Arc<dyn AgentDriver>, digest: &Value, n: usize, ctx: &DraftContext) -> Result<Vec<Judgment>, String> {
    let done: std::collections::HashSet<String> = store.judgments().into_iter().map(|j| j.id).collect();
    let exchanges: Vec<&Value> = digest
        .get("exchanges")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|e| e.get("id").and_then(Value::as_str).is_some_and(|id| !done.contains(id))).take(n).collect())
        .unwrap_or_default();
    if exchanges.is_empty() {
        return Err("every exchange in this range is already judged".into());
    }
    let items: Vec<Value> = exchanges
        .iter()
        .enumerate()
        .map(|(i, e)| json!({ "i": i, "agent": e.get("agent"), "user": e.get("user"), "tools": e.get("tools"), "reply": e.get("reply"), "error": e.get("error") }))
        .collect();
    let text = format!("Exchanges:\n```json\n{}\n```", serde_json::to_string(&items).map_err(|e| e.to_string())?);
    let out = crate::ai_draft::run_draft(driver, "ai-draft/eval-sample", SAMPLE_JUDGE.into(), text, ctx).await?;
    let scores: Vec<Value> = json_block(&out, '[', ']').and_then(|s| serde_json::from_str(s).ok()).ok_or_else(|| format!("judge gave no JSON: {}", out.chars().take(200).collect::<String>()))?;
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 5.0);
    let field = |e: &Value, k: &str| e.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let judged_at = now();
    let js: Vec<Judgment> = scores
        .iter()
        .filter_map(|v| {
            let e = exchanges.get(v.get("i")?.as_u64()? as usize)?;
            Some(Judgment {
                id: field(e, "id"),
                at: field(e, "at"),
                judged_at: judged_at.clone(),
                agent: field(e, "agent"),
                model: field(e, "model"),
                prompt: field(e, "prompt"),
                resolved: s(v, "resolved"),
                instructions: s(v, "instructions"),
                tools: s(v, "tools"),
                concise: s(v, "concise"),
                note: v.get("note").and_then(Value::as_str).unwrap_or("").chars().take(240).collect(),
            })
        })
        .collect();
    if js.is_empty() {
        return Err("the judge scored nothing".into());
    }
    store.add_judgments(js.clone()).await?;
    Ok(js)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_checks_ignore_case() {
        let e = Expect { contains: vec!["Hola".into()], not_contains: vec!["error".into()], ..Default::default() };
        let c = check_text("hola, todo bien", &e);
        assert!(c.iter().all(|c| c.pass));
        let c = check_text("ERROR: nada", &e);
        assert!(c.iter().all(|c| !c.pass));
    }

    #[test]
    fn finds_json_inside_prose() {
        assert_eq!(json_block("ok: [{\"i\":0}] done", '[', ']'), Some("[{\"i\":0}]"));
        assert_eq!(json_block("nothing", '{', '}'), None);
    }

    #[tokio::test]
    async fn cases_get_ids_and_names() {
        let dir = std::env::temp_dir().join(format!("evals-{}", uuid::Uuid::new_v4()));
        let store = EvalStore::open(dir.join("evals.json"));
        let cases = store
            .set_cases(vec![Case { id: String::new(), name: String::new(), agent: String::new(), prompt: " hola ".into(), expect: Expect::default(), sample: None, reason: None, vote: None }])
            .await
            .unwrap();
        assert_eq!(cases[0].prompt, "hola");
        assert_eq!(cases[0].name, "hola");
        assert_eq!(cases[0].id.len(), 8);
        assert!(store.set_cases(vec![Case { id: "x".into(), name: "n".into(), agent: String::new(), prompt: " ".into(), expect: Expect::default(), sample: None, reason: None, vote: None }]).await.is_err());
        let voted = store.add_feedback("why is the build red", "I don't know", "down", Some(" missed the log "), "dev").await.unwrap();
        assert_eq!(voted.vote.as_deref(), Some("down"));
        assert_eq!(voted.prompt, "why is the build red");
        assert_eq!(voted.reason.as_deref(), Some("missed the log"));
        assert!(voted.expect.rubric.unwrap().contains("I don't know"));
        assert_eq!(store.cases().len(), 2);
        let again = EvalStore::open(dir.join("evals.json"));
        assert_eq!(again.cases().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
