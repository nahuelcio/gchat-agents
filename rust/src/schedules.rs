use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Datelike, Local, Timelike};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::atomic::write_atomic;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub cron: String,
    pub space: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub enabled: bool,
    pub created_by: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    pub failures: u32,
    #[serde(default = "cron_trigger")]
    pub trigger: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default)]
    pub needs_approval: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precheck: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook: Option<String>,
    #[serde(default = "yes")]
    pub notify_failures: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingRun {
    pub id: String,
    pub at: String,
    pub reason: String,
}

fn yes() -> bool {
    true
}

fn cron_trigger() -> String {
    "cron".into()
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

#[derive(Debug, Clone, Default)]
pub struct NewJob {
    pub name: String,
    pub prompt: String,
    pub cron: String,
    pub space: String,
    pub created_by: String,
    pub repo: Option<String>,
    pub trigger: Option<String>,
    pub command: Option<String>,
    pub pattern: Option<String>,
    pub needs_approval: bool,
    pub precheck: Option<String>,
    pub webhook: Option<String>,
    pub notify_failures: Option<bool>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Job {
    pub fn fires_on_cron(&self) -> bool {
        self.trigger == "cron"
    }

    pub fn runs_in(&self, place: &str) -> bool {
        self.space == "*" || self.space == place || place.ends_with(&format!("/{}", self.space))
    }

    fn next_after(&self, now: chrono::DateTime<Local>) -> Result<Option<String>, String> {
        if self.fires_on_cron() {
            Ok(Some(next_run(&self.cron, now)?.to_rfc3339()))
        } else {
            Ok(None)
        }
    }
}

struct CronParts {
    minute: HashSet<u32>,
    hour: HashSet<u32>,
    dom: HashSet<u32>,
    month: HashSet<u32>,
    dow: HashSet<u32>,
    dom_any: bool,
    dow_any: bool,
}

fn parse_field(expr: &str, name: &str, min: u32, max: u32) -> Result<HashSet<u32>, String> {
    let mut values = HashSet::new();
    for part in expr.split(',') {
        let mut it = part.split('/');
        let range = it.next().unwrap_or("");
        let step = match it.next() {
            None => 1u32,
            Some(s) => s.parse::<u32>().map_err(|_| format!("cron {name}: bad step \"{s}\""))?,
        };
        if step < 1 {
            return Err(format!("cron {name}: bad step \"{step}\""));
        }
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (
                a.parse().map_err(|_| format!("cron {name}: \"{part}\" is out of range {min}-{max}"))?,
                b.parse().map_err(|_| format!("cron {name}: \"{part}\" is out of range {min}-{max}"))?,
            )
        } else {
            let v: u32 = range
                .parse()
                .map_err(|_| format!("cron {name}: \"{part}\" is out of range {min}-{max}"))?;
            let hi = if it.next().is_none() && !part.contains('/') {
                v
            } else if part.contains('/') {
                max
            } else {
                v
            };
            (v, hi)
        };
        if lo < min || hi > max || lo > hi {
            return Err(format!("cron {name}: \"{part}\" is out of range {min}-{max}"));
        }
        let mut v = lo;
        while v <= hi {
            values.insert(v);
            v += step;
        }
    }
    Ok(values)
}

fn parse_cron(cron: &str) -> Result<CronParts, String> {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(format!(r#"cron must have 5 fields (minute hour day month weekday), got "{cron}""#));
    }
    Ok(CronParts {
        minute: parse_field(parts[0], "minute", 0, 59)?,
        hour: parse_field(parts[1], "hour", 0, 23)?,
        dom: parse_field(parts[2], "day-of-month", 1, 31)?,
        month: parse_field(parts[3], "month", 1, 12)?,
        dow: parse_field(parts[4], "day-of-week", 0, 6)?,
        dom_any: parts[2] == "*",
        dow_any: parts[4] == "*",
    })
}

pub fn next_run(cron: &str, from: chrono::DateTime<Local>) -> Result<chrono::DateTime<Local>, String> {
    let c = parse_cron(cron)?;
    let mut t = from.with_second(0).unwrap().with_nanosecond(0).unwrap() + chrono::Duration::minutes(1);
    for _ in 0..(366 * 24 * 60) {
        let day_ok = if c.dom_any && c.dow_any {
            true
        } else if c.dom_any {
            c.dow.contains(&(t.weekday().num_days_from_sunday()))
        } else if c.dow_any {
            c.dom.contains(&(t.day()))
        } else {
            c.dom.contains(&(t.day())) || c.dow.contains(&(t.weekday().num_days_from_sunday()))
        };
        if c.minute.contains(&(t.minute())) && c.hour.contains(&(t.hour())) && c.month.contains(&(t.month())) && day_ok {
            return Ok(t);
        }
        t += chrono::Duration::minutes(1);
    }
    Err(format!(r#"cron "{cron}" never matches"#))
}

pub fn describe_cron(cron: &str) -> String {
    let re = regex::Regex::new(r"^(\d+) (\*|\d+) \* \* (\*|1-5|[0-6])$").unwrap();
    let Some(caps) = re.captures(cron.trim()) else {
        return cron.to_string();
    };
    let min = &caps[1];
    let hour = &caps[2];
    let dow = &caps[3];
    if hour == "*" {
        return if dow == "*" && min == "0" {
            "Every hour".into()
        } else {
            cron.to_string()
        };
    }
    let time = format!("{hour:0>2}:{min:0>2}");
    let days = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
    if dow == "*" {
        return format!("Every day at {time}");
    }
    if dow == "1-5" {
        return format!("Weekdays at {time}");
    }
    let idx: usize = dow.parse().unwrap_or(0);
    format!("{} at {time}", days.get(idx).copied().unwrap_or("Day"))
}

pub fn job_name(prompt: &str, max: usize) -> String {
    let compact: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max {
        compact
    } else {
        format!("{}…", compact.chars().take(max.saturating_sub(1)).collect::<String>())
    }
}

pub struct ScheduleStore {
    file_path: PathBuf,
    jobs: Mutex<Vec<Job>>,
}

impl ScheduleStore {
    pub fn open(file_path: impl AsRef<Path>) -> Self {
        let file_path = file_path.as_ref().to_path_buf();
        let jobs = std::fs::read_to_string(&file_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            file_path,
            jobs: Mutex::new(jobs),
        }
    }

    pub fn all(&self) -> Vec<Job> {
        self.jobs.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.jobs.lock().unwrap().iter().find(|j| j.id == id).cloned()
    }

    pub async fn add(&self, input: NewJob, now: chrono::DateTime<Local>) -> Result<Job, String> {
        let trigger = input.trigger.unwrap_or_else(cron_trigger);
        let command = input.command.map(|c| c.trim().trim_start_matches('/').to_string()).filter(|c| !c.is_empty());
        let pattern = input.pattern.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        match trigger.as_str() {
            "cron" => {}
            "command" if command.is_some() => {}
            "mention" if pattern.is_some() => {}
            "command" => return Err("a command trigger needs the command, e.g. ship".into()),
            "mention" => return Err("a mention trigger needs the text to look for".into()),
            other => return Err(format!("unknown trigger {other}")),
        }
        let mut job = Job {
            id: Uuid::new_v4().to_string()[..8].to_string(),
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            space: input.space,
            repo: input.repo,
            enabled: true,
            created_by: input.created_by,
            created_at: now.to_rfc3339(),
            next_run_at: None,
            last_run_at: None,
            last_status: None,
            failures: 0,
            trigger,
            command,
            pattern,
            needs_approval: input.needs_approval,
            precheck: input.precheck.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            webhook: input.webhook.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            notify_failures: input.notify_failures.unwrap_or(true),
            model: blank_to_none(input.model),
            effort: blank_to_none(input.effort),
            pending: None,
        };
        job.next_run_at = job.next_after(now)?;
        self.jobs.lock().unwrap().push(job.clone());
        self.save().await?;
        Ok(job)
    }

    pub async fn update(&self, id: &str, patch: JobPatch, now: chrono::DateTime<Local>) -> Result<Job, String> {
        let next = {
            let mut jobs = self.jobs.lock().unwrap();
            let idx = jobs.iter().position(|j| j.id == id).ok_or_else(|| format!("no job {id}"))?;
            let current = jobs[idx].clone();
            let mut next = current.clone();
            if let Some(v) = patch.enabled {
                next.enabled = v;
            }
            let cron_changed = patch.cron.is_some();
            if let Some(v) = patch.cron {
                next.cron = v;
            }
            if let Some(v) = patch.prompt {
                next.prompt = v;
            }
            if let Some(v) = patch.name {
                next.name = v;
            }
            if let Some(v) = patch.space.filter(|v| !v.trim().is_empty()) {
                next.space = v;
            }
            if let Some(v) = patch.webhook {
                next.webhook = Some(v.trim().to_string()).filter(|c| !c.is_empty());
            }
            if let Some(v) = patch.notify_failures {
                next.notify_failures = v;
            }
            if let Some(v) = patch.model {
                next.model = blank_to_none(Some(v));
            }
            if let Some(v) = patch.effort {
                next.effort = blank_to_none(Some(v));
            }
            if let Some(v) = patch.precheck {
                next.precheck = Some(v.trim().to_string()).filter(|c| !c.is_empty());
            }
            if let Some(v) = patch.last_status {
                next.last_status = v;
            }
            if let Some(v) = patch.last_run_at {
                next.last_run_at = v;
            }
            if let Some(v) = patch.failures {
                next.failures = v;
            }
            if let Some(v) = patch.next_run_at {
                next.next_run_at = v;
            } else if cron_changed || (patch.enabled == Some(true) && !current.enabled) {
                next.next_run_at = next.next_after(now)?;
                next.failures = 0;
            }
            if let Some(v) = patch.pending {
                next.pending = v;
            }
            jobs[idx] = next.clone();
            next
        };
        self.save().await?;
        Ok(next)
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        self.jobs.lock().unwrap().retain(|j| j.id != id);
        self.save().await
    }

    async fn save(&self) -> Result<(), String> {
        let jobs = self.jobs.lock().unwrap().clone();
        let body = format!("{}\n", serde_json::to_string_pretty(&jobs).map_err(|e| e.to_string())?);
        write_atomic(&self.file_path, &body).await.map_err(|e| e.to_string())
    }
}

#[derive(Debug, Default)]
pub struct JobPatch {
    pub enabled: Option<bool>,
    pub cron: Option<String>,
    pub prompt: Option<String>,
    pub name: Option<String>,
    pub last_status: Option<Option<String>>,
    pub last_run_at: Option<Option<String>>,
    pub failures: Option<u32>,
    pub next_run_at: Option<Option<String>>,
    pub pending: Option<Option<PendingRun>>,
    pub precheck: Option<String>,
    pub space: Option<String>,
    pub webhook: Option<String>,
    pub notify_failures: Option<bool>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

const PRECHECK_TIMEOUT_SECS: u64 = 300;

pub enum Precheck {
    Nothing,
    Found(String),
    Failed(String),
}

pub async fn run_precheck(script: &str) -> Precheck {
    let file = std::env::temp_dir().join(format!("switchboard-precheck-{}.mjs", Uuid::new_v4()));
    if let Err(e) = tokio::fs::write(&file, script).await {
        return Precheck::Failed(e.to_string());
    }
    let mut cmd = tokio::process::Command::new(crate::driver::spawn::resolve_bin("node"));
    cmd.arg(&file).kill_on_drop(true).stdin(std::process::Stdio::null());
    let result = tokio::time::timeout(std::time::Duration::from_secs(PRECHECK_TIMEOUT_SECS), cmd.output()).await;
    let _ = tokio::fs::remove_file(&file).await;
    let output = match result {
        Err(_) => return Precheck::Failed(format!("precheck timed out after {PRECHECK_TIMEOUT_SECS}s")),
        Ok(Err(e)) => return Precheck::Failed(e.to_string()),
        Ok(Ok(o)) => o,
    };
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().chars().take(500).collect::<String>();
        return Precheck::Failed(format!("precheck exited with {}: {err}", output.status));
    }
    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if out.is_empty() || out == "[]" || out == "{}" {
        Precheck::Nothing
    } else {
        Precheck::Found(out)
    }
}

const MAX_RETRIES: u32 = 3;
const RETRY_MS: i64 = 5 * 60_000;

type RunJob = Box<dyn Fn(Job) -> futures::future::BoxFuture<'static, bool> + Send + Sync>;

pub struct Scheduler {
    store: std::sync::Arc<ScheduleStore>,
    run: RunJob,
    activity: Option<std::sync::Arc<crate::activity::ActivityLog>>,
    notifier: Option<std::sync::Arc<crate::job_notify::JobNotifier>>,
}

impl Scheduler {
    pub fn new(
        store: std::sync::Arc<ScheduleStore>,
        run: impl Fn(Job) -> futures::future::BoxFuture<'static, bool> + Send + Sync + 'static,
    ) -> Self {
        Self {
            store,
            run: Box::new(run),
            activity: None,
            notifier: None,
        }
    }

    pub fn with_notifier(mut self, notifier: std::sync::Arc<crate::job_notify::JobNotifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    pub fn with_activity(mut self, activity: std::sync::Arc<crate::activity::ActivityLog>) -> Self {
        self.activity = Some(activity);
        self
    }

    /// Runs a job through the same closure schedules use, without storing it. Event triggers use trigger = "event".
    pub async fn run_ephemeral(&self, job: Job) -> bool {
        (self.run)(job).await
    }

    async fn note(&self, kind: &str, job: &Job, detail: &str) {
        if let Some(log) = &self.activity {
            log.record(kind, &format!("schedule/{}", job.id), job.name.clone(), detail.to_string()).await;
        }
    }

    pub fn jobs_for_command(&self, command: &str, place: &str) -> Vec<Job> {
        self.store
            .all()
            .into_iter()
            .filter(|j| j.enabled && j.trigger == "command" && j.command.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(command)) && j.runs_in(place))
            .collect()
    }

    pub fn jobs_for_text(&self, text: &str, place: &str) -> Vec<Job> {
        let lower = text.to_lowercase();
        self.store
            .all()
            .into_iter()
            .filter(|j| j.enabled && j.trigger == "mention" && j.pattern.as_deref().is_some_and(|p| lower.contains(&p.to_lowercase())) && j.runs_in(place))
            .collect()
    }

    pub fn approvals(&self) -> Vec<Job> {
        self.store.all().into_iter().filter(|j| j.pending.is_some()).collect()
    }

    pub async fn trigger(&self, id: &str, reason: &str, now: chrono::DateTime<Local>) -> Result<Job, String> {
        let job = self.store.get(id).ok_or_else(|| format!("no job {id}"))?;
        if !job.needs_approval {
            return self.run_now(id, now).await;
        }
        if job.pending.is_some() {
            return Ok(job);
        }
        let pending = PendingRun { id: Uuid::new_v4().to_string()[..6].to_string(), at: now.to_rfc3339(), reason: reason.to_string() };
        let job = self
            .store
            .update(
                id,
                JobPatch {
                    pending: Some(Some(pending.clone())),
                    last_status: Some(Some("pending".into())),
                    next_run_at: Some(job.next_after(now)?),
                    ..Default::default()
                },
                now,
            )
            .await?;
        self.note("approval_pending", &job, &format!("{reason} · /approve {0} or /deny {0}", pending.id)).await;
        Ok(job)
    }

    pub async fn decide(&self, approval_id: &str, approve: bool, now: chrono::DateTime<Local>) -> Result<Job, String> {
        let job = self
            .store
            .all()
            .into_iter()
            .find(|j| j.pending.as_ref().is_some_and(|p| p.id == approval_id))
            .ok_or_else(|| format!("no pending approval {approval_id}"))?;
        let cleared = self
            .store
            .update(
                &job.id,
                JobPatch {
                    pending: Some(None),
                    last_status: Some(Some(if approve { "approved" } else { "denied" }.into())),
                    ..Default::default()
                },
                now,
            )
            .await?;
        self.note("approval_decided", &cleared, if approve { "approved" } else { "denied" }).await;
        if approve {
            self.run_now(&job.id, now).await
        } else {
            Ok(cleared)
        }
    }

    pub async fn tick(&self, now: chrono::DateTime<Local>) {
        let due: Vec<String> = self
            .store
            .all()
            .into_iter()
            .filter(|j| {
                j.enabled
                    && j.fires_on_cron()
                    && j.pending.is_none()
                    && j.last_status.as_deref() != Some("running")
                    && j.next_run_at
                        .as_ref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|t| t <= now)
                        .unwrap_or(false)
            })
            .map(|j| j.id)
            .collect();
        for id in due {
            let _ = self.trigger(&id, "scheduled time", now).await;
        }
    }

    pub async fn run_now(&self, id: &str, now: chrono::DateTime<Local>) -> Result<Job, String> {
        let job = self
            .store
            .update(
                id,
                JobPatch {
                    last_status: Some(Some("running".into())),
                    last_run_at: Some(Some(now.to_rfc3339())),
                    ..Default::default()
                },
                now,
            )
            .await?;
        let mut work = job.clone();
        let ok = match job.precheck.as_deref().map(run_precheck) {
            None => (self.run)(work).await,
            Some(check) => match check.await {
                Precheck::Nothing => {
                    self.note("precheck_idle", &job, "nothing to do").await;
                    return self
                        .store
                        .update(
                            id,
                            JobPatch {
                                last_status: Some(Some("idle".into())),
                                failures: Some(0),
                                next_run_at: Some(job.next_after(now)?),
                                ..Default::default()
                            },
                            now,
                        )
                        .await;
                }
                Precheck::Found(out) => {
                    work.prompt = format!("{}

Precheck output:
{out}", job.prompt);
                    (self.run)(work).await
                }
                Precheck::Failed(err) => {
                    self.note("precheck_failed", &job, &err).await;
                    if let Some(n) = &self.notifier {
                        n.send(&job, false, &err).await;
                    }
                    false
                }
            },
        };
        if ok {
            return self
                .store
                .update(
                    id,
                    JobPatch {
                        last_status: Some(Some("ok".into())),
                        failures: Some(0),
                        next_run_at: Some(job.next_after(now)?),
                        ..Default::default()
                    },
                    now,
                )
                .await;
        }
        let failures = job.failures + 1;
        if failures <= MAX_RETRIES {
            self.store
                .update(
                    id,
                    JobPatch {
                        last_status: Some(Some("failed".into())),
                        failures: Some(failures),
                        next_run_at: Some(Some((now + chrono::Duration::milliseconds(RETRY_MS)).to_rfc3339())),
                        ..Default::default()
                    },
                    now,
                )
                .await
        } else {
            self.store
                .update(
                    id,
                    JobPatch {
                        last_status: Some(Some("failed".into())),
                        failures: Some(0),
                        next_run_at: Some(job.next_after(now)?),
                        ..Default::default()
                    },
                    now,
                )
                .await
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventTrigger {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub prompt: String,
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

pub struct TriggerStore {
    path: PathBuf,
    items: Mutex<Vec<EventTrigger>>,
}

impl TriggerStore {
    pub fn open(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let items = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, items: Mutex::new(items) }
    }

    pub fn list(&self) -> Vec<EventTrigger> {
        self.items.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<EventTrigger> {
        self.items.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }

    pub async fn upsert(&self, mut trigger: EventTrigger) -> Result<EventTrigger, String> {
        trigger.id = trigger.id.trim().to_string();
        trigger.name = trigger.name.trim().to_string();
        trigger.agent = trigger.agent.trim().trim_start_matches('@').to_string();
        trigger.prompt = trigger.prompt.trim().to_string();
        trigger.secret = trigger.secret.trim().to_string();
        if trigger.name.is_empty() || trigger.agent.is_empty() || trigger.prompt.is_empty() {
            return Err("name, agent and prompt are required".into());
        }
        if trigger.id.is_empty() {
            trigger.id = Uuid::new_v4().simple().to_string()[..12].to_string();
        }
        if !trigger.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("trigger id must be letters, digits, - or _".into());
        }
        if trigger.secret.is_empty() {
            let mut bytes = [0u8; 24];
            rand::thread_rng().fill_bytes(&mut bytes);
            trigger.secret = hex::encode(bytes);
        }
        {
            let mut items = self.items.lock().unwrap();
            if let Some(slot) = items.iter_mut().find(|t| t.id == trigger.id) {
                *slot = trigger.clone();
            } else {
                items.push(trigger.clone());
            }
        }
        self.persist().await?;
        Ok(trigger)
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        self.items.lock().unwrap().retain(|t| t.id != id);
        self.persist().await
    }

    async fn persist(&self) -> Result<(), String> {
        let body = serde_json::to_string_pretty(&*self.items.lock().unwrap()).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &body).await.map_err(|e| e.to_string())
    }
}

pub fn event_job(trigger: &EventTrigger, payload: &str) -> Job {
    let id: String = format!("e{}", &Uuid::new_v4().simple().to_string()[..11]);
    Job {
        id,
        name: trigger.name.clone(),
        prompt: event_prompt(trigger, payload),
        cron: String::new(),
        space: "team-chat".into(),
        repo: trigger.repo.clone(),
        enabled: true,
        created_by: "webhook".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        next_run_at: None,
        last_run_at: None,
        last_status: None,
        failures: 0,
        trigger: "event".into(),
        command: None,
        pattern: None,
        needs_approval: false,
        precheck: None,
        webhook: None,
        notify_failures: false,
        model: None,
        effort: None,
        pending: None,
    }
}

pub fn event_prompt(trigger: &EventTrigger, payload: &str) -> String {
    let payload: String = payload.chars().take(8000).collect();
    format!("@{}\n\n{}\n\nEvent payload:\n{}", trigger.agent, trigger.prompt, payload)
}

pub fn hmac_sha256_hex(key: &str, msg: &[u8]) -> String {
    fn sha(data: &[u8]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(data);
        let out = h.finalize();
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&out);
        bytes
    }
    let mut key = key.as_bytes().to_vec();
    if key.len() > 64 {
        key = sha(&key).to_vec();
    }
    key.resize(64, 0);
    let mut ipad = key.clone();
    let mut opad = key;
    for b in &mut ipad {
        *b ^= 0x36;
    }
    for b in &mut opad {
        *b ^= 0x5c;
    }
    let mut inner = ipad;
    inner.extend_from_slice(msg);
    let inner_hash = sha(&inner);
    let mut outer = opad;
    outer.extend_from_slice(&inner_hash);
    hex::encode(sha(&outer))
}

pub fn signature_ok(secret: &str, body: &[u8], header: &str) -> bool {
    let got = header.trim().strip_prefix("sha256=").unwrap_or(header.trim());
    let want = hmac_sha256_hex(secret, body);
    got.len() == want.len() && got.bytes().zip(want.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::tempdir;

    #[test]
    fn event_signature_matches_and_rejects_a_tampered_body() {
        let sig = hmac_sha256_hex("topsecret", b"{\"pull\":1}");
        assert!(signature_ok("topsecret", b"{\"pull\":1}", &format!("sha256={sig}")));
        assert!(!signature_ok("topsecret", b"{\"pull\":2}", &format!("sha256={sig}")));
        let prompt = event_prompt(
            &EventTrigger { id: "t".into(), name: "pr".into(), agent: "dev".into(), prompt: "review it".into(), secret: "s".into(), repo: None },
            "{}",
        );
        assert!(prompt.starts_with("@dev"));
        assert!(prompt.contains("review it"));
    }

    #[test]
    fn old_jobs_load_as_cron() {
        let raw = r#"[{"id":"a1","name":"n","prompt":"p","cron":"0 9 * * *","space":"team-chat","enabled":true,"createdBy":"x","createdAt":"2026-01-01T00:00:00Z","failures":0}]"#;
        let jobs: Vec<Job> = serde_json::from_str(raw).unwrap();
        assert_eq!(jobs[0].trigger, "cron");
        assert!(!jobs[0].needs_approval && jobs[0].pending.is_none());
        assert!(jobs[0].model.is_none() && jobs[0].effort.is_none());
    }

    #[tokio::test]
    async fn mention_jobs_match_text_in_their_space() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(ScheduleStore::open(dir.path().join("s.json")));
        store
            .add(
                NewJob { name: "deploy".into(), prompt: "p".into(), space: "room1".into(), trigger: Some("mention".into()), pattern: Some("Deploy Now".into()), ..Default::default() },
                Local::now(),
            )
            .await
            .unwrap();
        assert!(store.add(NewJob { trigger: Some("command".into()), ..Default::default() }, Local::now()).await.is_err());
        let scheduler = Scheduler::new(store, |_| futures::FutureExt::boxed(async { true }));
        assert_eq!(scheduler.jobs_for_text("ok, deploy now please", "share/room1").len(), 1);
        assert!(scheduler.jobs_for_text("ok, deploy now please", "share/other").is_empty());
        assert!(scheduler.jobs_for_text("nothing here", "share/room1").is_empty());
    }

    #[tokio::test]
    async fn precheck_skips_empty_and_feeds_output() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(ScheduleStore::open(dir.path().join("s.json")));
        let now = Local::now();
        let idle = store.add(NewJob { name: "a".into(), prompt: "p".into(), cron: "0 9 * * *".into(), precheck: Some("console.log(\"[]\")".into()), ..Default::default() }, now).await.unwrap();
        let busy = store.add(NewJob { name: "b".into(), prompt: "p".into(), cron: "0 9 * * *".into(), precheck: Some("console.log(42)".into()), ..Default::default() }, now).await.unwrap();
        let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        let scheduler = Scheduler::new(store, move |job| {
            sink.lock().unwrap().push(job.prompt);
            futures::FutureExt::boxed(async { true })
        });
        assert_eq!(scheduler.run_now(&idle.id, now).await.unwrap().last_status.as_deref(), Some("idle"));
        assert_eq!(scheduler.run_now(&busy.id, now).await.unwrap().last_status.as_deref(), Some("ok"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].ends_with("Precheck output:
42"));
    }

    #[test]
    fn next_run_hourly() {
        let from = Local.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        let next = next_run("0 * * * *", from).unwrap();
        assert_eq!(next.hour(), 11);
        assert_eq!(next.minute(), 0);
    }

    #[tokio::test]
    async fn store_add_persist() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("schedules.json");
        let store = ScheduleStore::open(&path);
        let now = Local.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        store
            .add(
                NewJob {
                    trigger: None,
                    command: None,
                    pattern: None,
                    needs_approval: false,
                    precheck: None,
                    webhook: None,
                    notify_failures: None,
                    model: None,
                    effort: None,
                    name: "n".into(),
                    prompt: "p".into(),
                    cron: "0 9 * * *".into(),
                    space: "team-chat".into(),
                    created_by: "test".into(),
                    repo: None,
                },
                now,
            )
            .await
            .unwrap();
        let again = ScheduleStore::open(&path);
        assert_eq!(again.all().len(), 1);
        assert_eq!(describe_cron("0 9 * * *"), "Every day at 09:00");
    }

    #[tokio::test]
    async fn job_keeps_model_and_effort_until_cleared() {
        let dir = tempdir().unwrap();
        let store = ScheduleStore::open(dir.path().join("s.json"));
        let now = Local::now();
        let job = store
            .add(
                NewJob {
                    name: "n".into(),
                    prompt: "p".into(),
                    cron: "0 9 * * *".into(),
                    model: Some("  anthropic/claude  ".into()),
                    effort: Some("max".into()),
                    ..Default::default()
                },
                now,
            )
            .await
            .unwrap();
        assert_eq!(job.model.as_deref(), Some("anthropic/claude"));
        assert_eq!(job.effort.as_deref(), Some("max"));
        let cleared = store
            .update(&job.id, JobPatch { model: Some(String::new()), effort: Some("  ".into()), ..Default::default() }, now)
            .await
            .unwrap();
        assert!(cleared.model.is_none() && cleared.effort.is_none());
        let kept = store
            .update(&job.id, JobPatch { name: Some("renamed".into()), ..Default::default() }, now)
            .await
            .unwrap();
        assert!(kept.model.is_none() && kept.effort.is_none());
        assert_eq!(kept.name, "renamed");
    }
}
