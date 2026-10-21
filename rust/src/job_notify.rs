use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::google::{GoogleConnection, PostMessageBody};
use crate::schedules::Job;
use crate::transcripts::{TranscriptMessage, TranscriptStore};

pub const INBOX_KEY: &str = "share/notifications";

pub struct JobNotifier {
    google: Arc<GoogleConnection>,
    transcripts: Arc<TranscriptStore>,
    http: reqwest::Client,
}

impl JobNotifier {
    pub fn new(google: Arc<GoogleConnection>, transcripts: Arc<TranscriptStore>) -> Self {
        Self { google, transcripts, http: reqwest::Client::new() }
    }

    async fn inbox(&self, text: String) {
        let msg = |author: &str, text: String, bot: bool| TranscriptMessage {
            author: author.into(),
            text,
            bot,
            at: Some(chrono::Utc::now().to_rfc3339()),
            questions: None,
            attachments: None,
            reply_to: None,
        };
        let mut batch = Vec::new();
        if self.transcripts.get(INBOX_KEY).is_empty() {
            batch.push(msg("Switchboard", "Notifications".into(), false));
        }
        batch.push(msg("Jobs", text, true));
        if let Err(err) = self.transcripts.append(INBOX_KEY, batch).await {
            tracing::warn!(%err, "could not write notification inbox");
        }
    }

    pub async fn send(&self, job: &Job, ok: bool, text: &str) {
        if ok && text.trim().is_empty() {
            return;
        }
        if !ok && !job.notify_failures {
            return;
        }
        let title = if ok { job.name.clone() } else { format!("{} failed", job.name) };
        let body: String = format!("*{title}*\n{text}").chars().take(4000).collect();
        self.inbox(format!("**{title}**\n\n{text}")).await;
        if job.space.starts_with("spaces/") {
            let msg = PostMessageBody { text: body.clone(), thread: None, cards_v2: None };
            if let Err(err) = self.google.post_message(&job.space, &msg).await {
                tracing::warn!(%err, job = %job.id, "could not post job notification");
            }
        }
        if let Some(url) = job.webhook.as_deref() {
            let payload = json!({
                "text": body,
                "content": body,
                "job": job.name,
                "jobId": job.id,
                "status": if ok { "ok" } else { "failed" },
            });
            let res = self.http.post(url).json(&payload).timeout(Duration::from_secs(15)).send().await;
            match res {
                Ok(r) if !r.status().is_success() => tracing::warn!(status = %r.status(), job = %job.id, "job webhook rejected"),
                Err(err) => tracing::warn!(%err, job = %job.id, "job webhook failed"),
                _ => {}
            }
        }
    }
}
