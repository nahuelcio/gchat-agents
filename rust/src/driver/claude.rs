use async_trait::async_trait;
use futures::FutureExt;
use serde_json::{json, Map, Value};

use super::spawn::{spawn_live, LiveLine, LiveProcess};
use super::types::{AgentDriver, AgentQuestion, AgentTurnInput, AgentTurnResult, ContextUsage, PendingAgent};
use crate::mcp::{claude_mcp_config, SWITCHBOARD_HINT, SwitchboardMcp};
use crate::questions::{answers_map_from_text, format_questions, normalize_questions};

#[derive(Clone)]
pub struct ClaudeDriver {
    pub bin: String,
    pub model: Option<String>,
    pub timeout_ms: u64,
    pub switchboard: Option<SwitchboardMcp>,
    pub read_dirs: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedClaudeOutput {
    pub reply: String,
    pub session_id: Option<String>,
    pub error: Option<String>,
    pub usage: Option<ContextUsage>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClaudeStreamEvent {
    Ignore,
    Result(ParsedClaudeOutput),
    Question {
        request_id: String,
        questions: Vec<AgentQuestion>,
    },
    Permission {
        request_id: String,
    },
}

pub fn parse_claude_output(stdout: &str) -> ParsedClaudeOutput {
    let trimmed = stdout.trim();
    let Ok(obj) = serde_json::from_str::<Value>(trimmed) else {
        return ParsedClaudeOutput {
            error: Some(format!("unparseable claude output: {}", &stdout[..stdout.len().min(200)])),
            ..Default::default()
        };
    };
    if obj.get("type").and_then(|v| v.as_str()) != Some("result") {
        return ParsedClaudeOutput {
            error: Some(format!(
                "unexpected claude output type: {}",
                obj.get("type").and_then(|v| v.as_str()).unwrap_or("none")
            )),
            ..Default::default()
        };
    }
    let is_error = obj.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
    let result = obj.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string();
    ParsedClaudeOutput {
        reply: if is_error { String::new() } else { result.clone() },
        session_id: obj.get("session_id").and_then(|v| v.as_str()).map(str::to_string),
        error: if is_error {
            Some(if result.is_empty() {
                "claude reported an error".into()
            } else {
                result
            })
        } else {
            None
        },
        usage: context_usage(&obj),
    }
}

fn context_usage(obj: &Value) -> Option<ContextUsage> {
    let usage = obj.get("usage")?;
    let context_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
        + usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
        + usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
    let model_usage = obj.get("modelUsage").and_then(|v| v.as_object());
    let context_window = model_usage.and_then(|models| {
        models
            .values()
            .max_by_key(|m| {
                m.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0)
                    + m.get("cacheCreationInputTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0)
                    + m.get("cacheReadInputTokens").and_then(|v| v.as_u64()).unwrap_or(0)
            })
            .and_then(|m| m.get("contextWindow").and_then(|v| v.as_u64()))
    });
    Some(ContextUsage {
        context_tokens,
        context_window,
    })
}

pub fn interpret_claude_line(line: &str) -> ClaudeStreamEvent {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ClaudeStreamEvent::Ignore;
    }
    let Ok(obj) = serde_json::from_str::<Value>(trimmed) else {
        return ClaudeStreamEvent::Ignore;
    };
    if obj.get("type").and_then(|v| v.as_str()) == Some("result") {
        return ClaudeStreamEvent::Result(parse_claude_output(trimmed));
    }
    if obj.get("type").and_then(|v| v.as_str()) == Some("control_request")
        && obj.pointer("/request/subtype").and_then(|v| v.as_str()) == Some("can_use_tool")
    {
        let Some(request_id) = obj.get("request_id").and_then(|v| v.as_str()).map(str::to_string) else {
            return ClaudeStreamEvent::Ignore;
        };
        if obj.pointer("/request/tool_name").and_then(|v| v.as_str()) == Some("AskUserQuestion") {
            let qs = normalize_questions(obj.pointer("/request/input/questions").unwrap_or(&Value::Null));
            if !qs.is_empty() {
                return ClaudeStreamEvent::Question {
                    request_id,
                    questions: qs,
                };
            }
        }
        return ClaudeStreamEvent::Permission { request_id };
    }
    ClaudeStreamEvent::Ignore
}

fn control_response(request_id: &str, response: Value) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response
        }
    })
    .to_string()
}

fn user_message(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    })
    .to_string()
}

fn questions_value(questions: &[AgentQuestion]) -> Value {
    Value::Array(
        questions
            .iter()
            .map(|q| {
                let mut m = Map::new();
                m.insert("header".into(), Value::String(q.header.clone()));
                m.insert("question".into(), Value::String(q.question.clone()));
                m.insert(
                    "options".into(),
                    Value::Array(
                        q.options
                            .iter()
                            .map(|o| {
                                let mut om = Map::new();
                                om.insert("label".into(), Value::String(o.label.clone()));
                                if let Some(d) = &o.description {
                                    om.insert("description".into(), Value::String(d.clone()));
                                }
                                Value::Object(om)
                            })
                            .collect(),
                    ),
                );
                if q.multiple == Some(true) {
                    m.insert("multiSelect".into(), Value::Bool(true));
                }
                Value::Object(m)
            })
            .collect(),
    )
}

#[async_trait]
impl AgentDriver for ClaudeDriver {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
        let mut args = vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--permission-prompts".into(),
            "host".into(),
        ];
        let session_ref = input
            .session_ref
            .as_deref()
            .filter(|s| uuid::Uuid::parse_str(s).is_ok());
        if let Some(session) = session_ref {
            args.push("--resume".into());
            args.push(session.to_string());
        }
        if let Some(model) = input.model.as_ref().or(self.model.as_ref()) {
            args.push("--model".into());
            args.push(model.clone());
        }
        for dir in &self.read_dirs {
            args.push("--add-dir".into());
            args.push(dir.clone());
        }
        if let Some(sb) = &self.switchboard {
            args.push("--mcp-config".into());
            args.push(claude_mcp_config(
                &sb.server_path,
                &input.thread_key,
                &sb.admin_url,
            ));
            args.push("--append-system-prompt".into());
            args.push(SWITCHBOARD_HINT.into());
            args.push("--allowedTools".into());
            args.push("mcp__switchboard".into());
        }
        let live = spawn_live(&self.bin, &args, &input.workdir, self.timeout_ms);
        live.write(&user_message(&input.text));
        let session_seed = session_ref.map(str::to_string);
        self.clone_driver().pump(live, input, session_seed).await
    }
}

impl ClaudeDriver {
    fn clone_driver(&self) -> Self {
        Self {
            bin: self.bin.clone(),
            model: self.model.clone(),
            timeout_ms: self.timeout_ms,
            switchboard: self.switchboard.clone(),
            read_dirs: self.read_dirs.clone(),
        }
    }

    fn pump(
        self,
        live: LiveProcess,
        input: AgentTurnInput,
        session_ref: Option<String>,
    ) -> futures::future::BoxFuture<'static, Result<AgentTurnResult, String>> {
        async move {
            let mut session_ref = session_ref;
            let mut reply = String::new();
            let mut usage = None;
            loop {
                let line = live.read_line(None).await?;
                match line {
                    LiveLine::Idle => continue,
                    LiveLine::Eof => {
                        if live.timed_out() {
                            return Err(format!("claude timed out after {}ms", self.timeout_ms));
                        }
                        if let Some(err) = live.start_error().await {
                            return Err(err);
                        }
                        let code = live.exit_code();
                        if let Some(code) = code {
                            if code != 0 {
                                return Err(format!("claude exited with code {code}"));
                            }
                        }
                        if reply.is_empty() {
                            return Err("claude returned no reply text".into());
                        }
                        return Ok(AgentTurnResult {
                            reply,
                            session_ref,
                            usage,
                            pending: None,
                        });
                    }
                    LiveLine::Text(line) => match interpret_claude_line(&line) {
                        ClaudeStreamEvent::Ignore => {}
                        ClaudeStreamEvent::Permission { request_id } => {
                            live.write(&control_response(
                                &request_id,
                                json!({
                                    "behavior": "deny",
                                    "message": "Denied from chat. Only clarifying questions are answered here."
                                }),
                            ));
                        }
                        ClaudeStreamEvent::Question {
                            request_id,
                            questions: _,
                        } if !input.answer_questions => {
                            live.write(&control_response(
                                &request_id,
                                json!({
                                    "behavior": "deny",
                                    "message": "Denied from chat. Only clarifying questions are answered here."
                                }),
                            ));
                        }
                        ClaudeStreamEvent::Question {
                            request_id,
                            questions,
                        } => {
                            live.pause_timeout();
                            let shown = format_questions(&questions);
                            let live2 = live.clone();
                            let input2 = input.clone();
                            let driver = self.clone_driver();
                            let qs = questions.clone();
                            let session_ref_parked = session_ref.clone();
                            let pending = PendingAgent::new(
                                questions,
                                move |answer| {
                                    let live = live2.clone();
                                    let input = input2.clone();
                                    let driver = driver.clone_driver();
                                    let qs = qs.clone();
                                    let request_id = request_id.clone();
                                    let session_ref = session_ref_parked.clone();
                                    async move {
                                        live.arm_timeout();
                                        let answers = answers_map_from_text(&qs, &answer);
                                        live.write(&control_response(
                                            &request_id,
                                            json!({
                                                "behavior": "allow",
                                                "updatedInput": {
                                                    "questions": questions_value(&qs),
                                                    "answers": answers
                                                }
                                            }),
                                        ));
                                        driver.pump(live, input, session_ref).await
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
                        ClaudeStreamEvent::Result(parsed) => {
                            if let Some(err) = parsed.error {
                                return Err(err);
                            }
                            reply = parsed.reply;
                            usage = parsed.usage;
                            session_ref = parsed.session_id.or(session_ref);
                            live.pause_timeout();
                            live.end_input();
                            if reply.is_empty() {
                                return Err("claude returned no reply text".into());
                            }
                            return Ok(AgentTurnResult {
                                reply,
                                session_ref,
                                usage,
                                pending: None,
                            });
                        }
                    },
                }
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::types::AgentTurnInput;
    use tempfile::tempdir;

    #[test]
    fn parses_result() {
        let stdout = r#"{"type":"result","result":"hi","session_id":"11111111-1111-1111-1111-111111111111","is_error":false}"#;
        let parsed = parse_claude_output(stdout);
        assert_eq!(parsed.reply, "hi");
        assert!(parsed.error.is_none());
    }

    #[test]
    fn interprets_ask_user_question() {
        let line = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which library?","header":"Library","options":[{"label":"date-fns","description":"small"},{"label":"luxon","description":"tz"}],"multiSelect":false}]}}}"#;
        match interpret_claude_line(line) {
            ClaudeStreamEvent::Question { request_id, questions } => {
                assert_eq!(request_id, "r1");
                assert_eq!(questions[0].question, "Which library?");
            }
            other => panic!("unexpected {other:?}"),
        }
        let deny = interpret_claude_line(
            r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{}}}"#,
        );
        assert_eq!(
            deny,
            ClaudeStreamEvent::Permission {
                request_id: "r2".into()
            }
        );
    }

    #[tokio::test]
    async fn parks_and_resumes_via_control_response() {
        let dir = tempdir().unwrap();
        let script = dir.path().join("claude-ask.mjs");
        let answer_file = dir.path().join("answer.txt");
        let answer_path = answer_file.to_string_lossy().replace('\\', "/");
        std::fs::write(
            &script,
            format!(
                r#"#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const rl = readline.createInterface({{ input: process.stdin }});
let gotUser = false;
for await (const line of rl) {{
  if (!gotUser) {{
    gotUser = true;
    console.log(JSON.stringify({{
      type: 'control_request',
      request_id: 'r1',
      request: {{
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {{
          questions: [{{
            question: 'Which library?',
            header: 'Library',
            options: [
              {{ label: 'date-fns', description: 'small' }},
              {{ label: 'luxon', description: 'tz' }}
            ],
            multiSelect: false
          }}]
        }}
      }}
    }}));
    continue;
  }}
  if (line.includes('control_response')) {{
    fs.writeFileSync({answer_path:?}, line);
    console.log(JSON.stringify({{
      type: 'result',
      result: 'Using it',
      session_id: '3113400e-a4f2-4bae-9eae-94df1490de60',
      is_error: false
    }}));
    process.exit(0);
  }}
}}
"#
            ),
        )
        .unwrap();
        let driver = ClaudeDriver {
            bin: script.to_string_lossy().into_owned(),
            model: None,
            timeout_ms: 10_000,
            switchboard: None,
            read_dirs: vec![],
        };
        let parked = driver
            .run_turn(AgentTurnInput {
                thread_key: "t".into(),
                session_ref: None,
                text: "pick one".into(),
                workdir: dir.path().to_string_lossy().into_owned(),
                model: None,
                agent: None,
                driver: None,
                answer_questions: true,
            })
            .await
            .unwrap();
        assert!(parked.pending.is_some());
        assert_eq!(
            parked.pending.as_ref().unwrap().questions[0].question,
            "Which library?"
        );
        let done = parked.pending.unwrap().resume("1".into()).await.unwrap();
        assert_eq!(done.reply, "Using it");
        let saved = std::fs::read_to_string(&answer_file).unwrap();
        assert!(saved.contains("date-fns"));
    }
}
