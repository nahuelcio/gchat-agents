use async_trait::async_trait;
use futures::FutureExt;

use super::types::{
    AgentDriver, AgentQuestion, AgentTurnInput, AgentTurnResult, PendingAgent, QuestionOption,
};
use crate::personas::PASS;
use crate::questions::{continuation, format_questions};

pub struct EchoDriver;

fn last_message(text: &str) -> &str {
    text.rsplit("
---
").next().unwrap_or(text).trim()
}

#[async_trait]
impl AgentDriver for EchoDriver {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
        if input.text.contains("[Room message") {
            let me = input.thread_key.rsplit_once('#').map(|(_, p)| format!("@{p}"));
            let body = input.text.split("[Room message").last().and_then(|t| t.split_once('\n')).map(|(_, b)| b).unwrap_or("");
            let reply = match me {
                Some(me) if body.contains(&me) => format!("Echo: {}", last_message(body)),
                _ => PASS.into(),
            };
            return Ok(AgentTurnResult {
                reply,
                session_ref: Some(format!("echo-{}", input.thread_key)),
                usage: None,
                pending: None,
            });
        }
        if input.answer_questions && input.text.contains("ASK:") {
            let prompt = input
                .text
                .split("ASK:")
                .nth(1)
                .unwrap_or("")
                .trim();
            let questions = vec![AgentQuestion {
                header: "Echo".into(),
                question: if prompt.is_empty() {
                    "Continue?".into()
                } else {
                    prompt.to_string()
                },
                options: vec![
                    QuestionOption {
                        label: "Yes".into(),
                        description: None,
                    },
                    QuestionOption {
                        label: "No".into(),
                        description: None,
                    },
                ],
                multiple: None,
            }];
            let shown = format_questions(&questions);
            let base = input.clone();
            let qs = questions.clone();
            let pending = PendingAgent::new(
                questions,
                move |answer| {
                    let base = base.clone();
                    let qs = qs.clone();
                    async move {
                        let text = continuation(&qs, &answer, None);
                        Ok(AgentTurnResult {
                            reply: format!("Echo: {text}"),
                            session_ref: Some(format!("echo-{}", base.thread_key)),
                            usage: None,
                            pending: None,
                        })
                    }
                    .boxed()
                },
                || {},
            );
            return Ok(AgentTurnResult {
                reply: shown,
                session_ref: Some(format!("echo-{}", input.thread_key)),
                usage: None,
                pending: Some(pending),
            });
        }
        Ok(AgentTurnResult {
            reply: format!("Echo: {}", last_message(&input.text)),
            session_ref: Some(format!("echo-{}", input.thread_key)),
            usage: None,
            pending: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echoes() {
        let d = EchoDriver;
        let out = d
            .run_turn(AgentTurnInput {
                thread_key: "t".into(),
                session_ref: None,
                text: "hi".into(),
                workdir: ".".into(),
                model: None,
                agent: None,
                driver: None,
                answer_questions: true,
                request_id: None,
            })
            .await
            .unwrap();
        assert_eq!(out.reply, "Echo: hi");
        assert_eq!(last_message("You are @qa.

---

Ana: hola"), "Ana: hola");
        assert!(out.pending.is_none());
    }

    #[tokio::test]
    async fn room_replies_only_when_mentioned() {
        let turn = |key: &str| AgentTurnInput {
            thread_key: key.into(),
            session_ref: None,
            text: "[Room message, not addressed to you.]
Ana: @qa check this".into(),
            workdir: ".".into(),
            model: None,
            agent: None,
            driver: None,
            answer_questions: true,
            request_id: None,
        };
        assert_eq!(EchoDriver.run_turn(turn("team/t#qa")).await.unwrap().reply, "Echo: Ana: @qa check this");
        assert_eq!(EchoDriver.run_turn(turn("team/t#architect")).await.unwrap().reply, PASS);
    }

    #[tokio::test]
    async fn parks_question() {
        let d = EchoDriver;
        let out = d
            .run_turn(AgentTurnInput {
                thread_key: "t".into(),
                session_ref: None,
                text: "ASK:Ship it?".into(),
                workdir: ".".into(),
                model: None,
                agent: None,
                driver: None,
                answer_questions: true,
                request_id: None,
            })
            .await
            .unwrap();
        assert!(out.pending.is_some());
        assert!(out.reply.contains("Ship it?"));
    }
}
