use async_trait::async_trait;
use futures::FutureExt;
use serde_json::Value;

use super::spawn::{spawn_live, LiveLine, LiveProcess};
use super::types::{AgentDriver, AgentQuestion, AgentTurnInput, AgentTurnResult, PendingAgent};
use crate::mcp::{switchboard_thread_note, SwitchboardMcp};
use crate::questions::{continuation, format_questions, normalize_questions};

const ASK_IDLE_MS: u64 = 200;

#[derive(Clone)]
pub struct OpenCodeDriver {
    pub bin: String,
    pub model: Option<String>,
    pub agent: Option<String>,
    pub timeout_ms: u64,
    pub switchboard: Option<SwitchboardMcp>,
}

#[derive(Debug, Default)]
struct RunLine {
    text: Option<String>,
    session_id: Option<String>,
    error: Option<String>,
    questions: Option<Vec<AgentQuestion>>,
    asking: bool,
}

fn parse_run_line(line: &str) -> RunLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return RunLine::default();
    }
    let Ok(obj) = serde_json::from_str::<Value>(trimmed) else {
        return RunLine::default();
    };
    let session_id = obj
        .get("sessionID")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if obj.get("type").and_then(|v| v.as_str()) == Some("error") {
        return RunLine {
            session_id,
            error: Some(
                obj.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("opencode error")
                    .to_string(),
            ),
            ..Default::default()
        };
    }
    if obj.get("type").and_then(|v| v.as_str()) == Some("question") {
        let qs = normalize_questions(obj.get("questions").unwrap_or(&Value::Null));
        return if qs.is_empty() {
            RunLine {
                session_id,
                ..Default::default()
            }
        } else {
            RunLine {
                session_id,
                questions: Some(qs),
                asking: true,
                ..Default::default()
            }
        };
    }
    let part = obj.get("part").or_else(|| obj.pointer("/properties/part"));
    if let Some(part) = part {
        if (obj.get("type").and_then(|v| v.as_str()) == Some("text")
            || part.get("type").and_then(|v| v.as_str()) == Some("text"))
            && part.get("type").and_then(|v| v.as_str()) == Some("text")
        {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                return RunLine {
                    session_id,
                    text: Some(text.to_string()),
                    ..Default::default()
                };
            }
        }
        if part.get("type").and_then(|v| v.as_str()) == Some("tool")
            && part.get("tool").and_then(|v| v.as_str()) == Some("question")
        {
            let qs = normalize_questions(part.pointer("/state/input/questions").unwrap_or(&Value::Null));
            if qs.is_empty() {
                return RunLine {
                    session_id,
                    ..Default::default()
                };
            }
            let done = matches!(
                part.pointer("/state/status").and_then(|v| v.as_str()),
                Some("completed") | Some("error")
            );
            return RunLine {
                session_id,
                questions: Some(qs),
                asking: !done,
                ..Default::default()
            };
        }
    }
    RunLine {
        session_id,
        ..Default::default()
    }
}

#[async_trait]
impl AgentDriver for OpenCodeDriver {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
        let live = self.spawn(&input);
        live.send_and_close(&self.prompt(&input));
        self.pump(live, &input, String::new()).await
    }
}

impl OpenCodeDriver {
    fn spawn(&self, input: &AgentTurnInput) -> LiveProcess {
        let mut args = vec!["run".into(), "--format".into(), "json".into()];
        let session_ref = input
            .session_ref
            .as_deref()
            .filter(|s| s.starts_with("ses_"));
        if let Some(session) = session_ref {
            args.push("--session".into());
            args.push(session.to_string());
        }
        if let Some(model) = input.model.as_ref().or(self.model.as_ref()) {
            args.push("--model".into());
            args.push(model.clone());
        }
        if let Some(agent) = input.agent.as_ref().or(self.agent.as_ref()) {
            args.push("--agent".into());
            args.push(agent.clone());
        }
        spawn_live(&self.bin, &args, &input.workdir, self.timeout_ms)
    }

    fn prompt(&self, input: &AgentTurnInput) -> String {
        match self.switchboard {
            Some(_) => format!("{}\n\n{}", input.text, switchboard_thread_note(&input.thread_key)),
            None => input.text.clone(),
        }
    }

    async fn pump(
        &self,
        live: LiveProcess,
        input: &AgentTurnInput,
        preface: String,
    ) -> Result<AgentTurnResult, String> {
        let mut reply = String::new();
        let mut session_ref = input
            .session_ref
            .as_deref()
            .filter(|s| s.starts_with("ses_"))
            .map(str::to_string);
        let mut asking: Option<Vec<AgentQuestion>> = None;
        loop {
            let idle = asking.as_ref().map(|_| ASK_IDLE_MS);
            let line = live.read_line(idle).await?;
            match line {
                LiveLine::Idle if asking.is_some() => {
                    if !input.answer_questions {
                        asking = None;
                        continue;
                    }
                    live.pause_timeout();
                    let questions = asking.take().unwrap();
                    let shown = {
                        let body = format!("{preface}{reply}").trim().to_string();
                        [body, format_questions(&questions)]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    };
                    let driver = OpenCodeDriver {
                        bin: self.bin.clone(),
                        model: self.model.clone(),
                        agent: self.agent.clone(),
                        timeout_ms: self.timeout_ms,
                        switchboard: self.switchboard.clone(),
                    };
                    let base = input.clone();
                    let qs = questions.clone();
                    let session = session_ref.clone();
                    let pending = PendingAgent::new(
                        questions,
                        move |answer| {
                            let driver = OpenCodeDriver {
                                bin: driver.bin.clone(),
                                model: driver.model.clone(),
                                agent: driver.agent.clone(),
                                timeout_ms: driver.timeout_ms,
                                switchboard: driver.switchboard.clone(),
                            };
                            let base = base.clone();
                            let qs = qs.clone();
                            let session = session.clone();
                            async move {
                                let text = continuation(&qs, &answer, None);
                                driver
                                    .run_turn(AgentTurnInput {
                                        text,
                                        session_ref: session.or(base.session_ref.clone()),
                                        ..base
                                    })
                                    .await
                            }
                            .boxed()
                        },
                        {
                            let live = live.clone();
                            move || live.kill()
                        },
                    );
                    return Ok(AgentTurnResult {
                        reply: shown,
                        session_ref,
                        usage: None,
                        pending: Some(pending),
                    });
                }
                LiveLine::Eof | LiveLine::Idle => {
                    if live.timed_out() {
                        return Err(format!("opencode timed out after {}ms", self.timeout_ms));
                    }
                    if let Some(err) = live.start_error().await {
                        return Err(err);
                    }
                    if let Some(questions) = asking.take() {
                        if !input.answer_questions {
                            let body = format!("{preface}{reply}").trim().to_string();
                            return Ok(AgentTurnResult {
                                reply: if body.is_empty() {
                                    format_questions(&questions)
                                } else {
                                    body
                                },
                                session_ref,
                                usage: None,
                                pending: None,
                            });
                        }
                        let driver = OpenCodeDriver {
                            bin: self.bin.clone(),
                            model: self.model.clone(),
                            agent: self.agent.clone(),
                            timeout_ms: self.timeout_ms,
                            switchboard: self.switchboard.clone(),
                        };
                        let base = input.clone();
                        let qs = questions.clone();
                        let session = session_ref.clone();
                        let pending = PendingAgent::new(
                            questions.clone(),
                            move |answer| {
                                let driver = OpenCodeDriver {
                                    bin: driver.bin.clone(),
                                    model: driver.model.clone(),
                                    agent: driver.agent.clone(),
                                    timeout_ms: driver.timeout_ms,
                                    switchboard: driver.switchboard.clone(),
                                };
                                let base = base.clone();
                                let qs = qs.clone();
                                let session = session.clone();
                                async move {
                                    let text = continuation(&qs, &answer, None);
                                    driver
                                        .run_turn(AgentTurnInput {
                                            text,
                                            session_ref: session.or(base.session_ref.clone()),
                                            ..base
                                        })
                                        .await
                                }
                                .boxed()
                            },
                            || {},
                        );
                        return Ok(AgentTurnResult {
                            reply: format_questions(&questions),
                            session_ref,
                            usage: None,
                            pending: Some(pending),
                        });
                    }
                    let code = live.exit_code();
                    if let Some(code) = code {
                        if code != 0 {
                            return Err(format!("opencode exited with code {code}"));
                        }
                    }
                    if reply.is_empty() && preface.is_empty() {
                        return Err("opencode returned no reply text".into());
                    }
                    return Ok(AgentTurnResult {
                        reply: format!("{preface}{reply}"),
                        session_ref,
                        usage: None,
                        pending: None,
                    });
                }
                LiveLine::Text(line) => {
                    let parsed = parse_run_line(&line);
                    if let Some(id) = parsed.session_id {
                        session_ref = Some(id);
                    }
                    if let Some(err) = parsed.error {
                        return Err(err);
                    }
                    if parsed.asking {
                        if let Some(qs) = parsed.questions {
                            asking = Some(qs);
                            continue;
                        }
                    } else if parsed.questions.is_some() {
                        asking = None;
                    }
                    if let Some(text) = parsed.text {
                        reply.push_str(&text);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_text_parts() {
        let lines = [
            r#"{"type":"text","part":{"type":"text","text":"Hello"},"sessionID":"ses_1"}"#,
            r#"{"type":"text","part":{"type":"text","text":" world"},"sessionID":"ses_1"}"#,
        ];
        let mut reply = String::new();
        let mut session_id = None;
        for line in lines {
            let parsed = parse_run_line(line);
            if let Some(id) = parsed.session_id {
                session_id = Some(id);
            }
            if let Some(text) = parsed.text {
                reply.push_str(&text);
            }
        }
        assert_eq!(reply, "Hello world");
        assert_eq!(session_id.as_deref(), Some("ses_1"));
    }

    #[test]
    fn parses_question_event() {
        let line = r#"{"type":"question","questions":[{"header":"H","question":"Go?","options":[{"label":"Yes"},{"label":"No"}]}],"sessionID":"ses_1"}"#;
        let parsed = parse_run_line(line);
        assert!(parsed.asking);
        assert_eq!(parsed.questions.as_ref().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn parks_on_idle_after_question() {
        let dir = tempdir().unwrap();
        let script = dir.path().join("oc-ask.mjs");
        let args_file = dir.path().join("args.txt");
        let args_path = args_file.to_string_lossy().replace('\\', "/");
        std::fs::write(
            &script,
            format!(
                r#"#!/usr/bin/env node
import fs from 'node:fs';
const joined = fs.readFileSync(0, 'utf8');
fs.appendFileSync({args_path:?}, joined + '\n');
if (joined.includes('Which library?')) {{
  console.log(JSON.stringify({{
    type: 'text',
    sessionID: 'ses_q',
    part: {{ type: 'text', text: 'noted' }}
  }}));
}} else {{
  console.log(JSON.stringify({{
    type: 'question',
    sessionID: 'ses_q',
    questions: [{{
      question: 'Which library?',
      header: 'Library',
      options: [
        {{ label: 'date-fns', description: 'small' }},
        {{ label: 'luxon', description: 'tz' }}
      ]
    }}]
  }}));
  await new Promise((r) => setTimeout(r, 500));
}}
"#
            ),
        )
        .unwrap();
        let driver = OpenCodeDriver {
            bin: script.to_string_lossy().into_owned(),
            model: None,
            agent: None,
            timeout_ms: 10_000,
            switchboard: None,
        };
        let parked = driver
            .run_turn(AgentTurnInput {
                thread_key: "t".into(),
                session_ref: None,
                text: "pick".into(),
                workdir: dir.path().to_string_lossy().into_owned(),
                model: None,
                agent: None,
                driver: None,
                answer_questions: true,
                request_id: None,
            })
            .await
            .unwrap();
        assert!(parked.reply.contains("Which library?"));
        assert!(parked.pending.is_some());
        let done = parked.pending.unwrap().resume("luxon".into()).await.unwrap();
        assert!(done.reply.contains("noted"));
        let args = std::fs::read_to_string(&args_file).unwrap();
        assert!(args.contains("luxon"));
    }
}
