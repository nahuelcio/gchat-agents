use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::config::AgentDriverKind;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentQuestion {
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentTurnInput {
    pub thread_key: String,
    pub session_ref: Option<String>,
    pub text: String,
    pub workdir: String,
    pub model: Option<String>,
    pub agent: Option<String>,
    pub driver: Option<AgentDriverKind>,
    pub answer_questions: bool,
    pub request_id: Option<String>,
    pub mcps_override: Option<Vec<String>>,
    pub instructions_override: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextUsage {
    pub context_tokens: u64,
    pub context_window: Option<u64>,
    pub cost_usd: Option<f64>,
}

pub struct PendingAgent {
    pub questions: Vec<AgentQuestion>,
    resume: Box<dyn Fn(String) -> futures::future::BoxFuture<'static, Result<AgentTurnResult, String>> + Send + Sync>,
    cancel: Box<dyn Fn() + Send + Sync>,
}

impl PendingAgent {
    pub fn new(
        questions: Vec<AgentQuestion>,
        resume: impl Fn(String) -> futures::future::BoxFuture<'static, Result<AgentTurnResult, String>>
            + Send
            + Sync
            + 'static,
        cancel: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            questions,
            resume: Box::new(resume),
            cancel: Box::new(cancel),
        }
    }

    pub async fn resume(self, answer: String) -> Result<AgentTurnResult, String> {
        (self.resume)(answer).await
    }

    pub fn cancel(&self) {
        (self.cancel)();
    }
}

pub struct AgentTurnResult {
    pub reply: String,
    pub session_ref: Option<String>,
    pub usage: Option<ContextUsage>,
    pub pending: Option<PendingAgent>,
}

#[async_trait]
pub trait AgentDriver: Send + Sync {
    async fn run_turn(&self, input: AgentTurnInput) -> Result<AgentTurnResult, String>;

    async fn steer(&self, _thread_key: &str, _session_ref: &str, _request_id: &str, _text: &str) -> Result<Option<SteerResult>, String> {
        Ok(None)
    }

    async fn compact(&self, _session_ref: &str) -> Option<Result<String, String>> {
        None
    }

    async fn reset(&self, _session_ref: &str) -> Option<Result<(), String>> {
        None
    }
}

pub enum SteerResult {
    Joined,
    Answered(AgentTurnResult),
}
