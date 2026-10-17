use async_trait::async_trait;
use futures::FutureExt;

use super::types::{
    AgentDriver, AgentQuestion, AgentTurnInput, AgentTurnResult, PendingAgent, QuestionOption,
};
use crate::personas::PASS;
use crate::questions::{continuation, format_questions};

pub struct EchoDriver;

#[async_trait]
impl AgentDriver for EchoDriver {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String> {
        if input.text.contains("[Room message") {
            return Ok(AgentTurnResult {
                reply: PASS.into(),
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
            reply: format!("Echo: {}", input.text),
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
            })
            .await
            .unwrap();
        assert_eq!(out.reply, "Echo: hi");
        assert!(out.pending.is_none());
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
            })
            .await
            .unwrap();
        assert!(out.pending.is_some());
        assert!(out.reply.contains("Ship it?"));
    }
}
