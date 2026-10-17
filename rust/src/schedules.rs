use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Datelike, Local, Timelike};
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
}

#[derive(Debug, Clone)]
pub struct NewJob {
    pub name: String,
    pub prompt: String,
    pub cron: String,
    pub space: String,
    pub created_by: String,
    pub repo: Option<String>,
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
        let next = next_run(&input.cron, now)?;
        let job = Job {
            id: Uuid::new_v4().to_string()[..8].to_string(),
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            space: input.space,
            repo: input.repo,
            enabled: true,
            created_by: input.created_by,
            created_at: now.to_rfc3339(),
            next_run_at: Some(next.to_rfc3339()),
            last_run_at: None,
            last_status: None,
            failures: 0,
        };
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
                next.next_run_at = Some(next_run(&next.cron, now)?.to_rfc3339());
                next.failures = 0;
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
}

const MAX_RETRIES: u32 = 3;
const RETRY_MS: i64 = 5 * 60_000;

pub struct Scheduler {
    store: std::sync::Arc<ScheduleStore>,
    run: Box<dyn Fn(Job) -> futures::future::BoxFuture<'static, bool> + Send + Sync>,
}

impl Scheduler {
    pub fn new(
        store: std::sync::Arc<ScheduleStore>,
        run: impl Fn(Job) -> futures::future::BoxFuture<'static, bool> + Send + Sync + 'static,
    ) -> Self {
        Self {
            store,
            run: Box::new(run),
        }
    }

    pub async fn tick(&self, now: chrono::DateTime<Local>) {
        let due: Vec<String> = self
            .store
            .all()
            .into_iter()
            .filter(|j| {
                j.enabled
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
            let _ = self.run_now(&id, now).await;
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
        let ok = (self.run)(job.clone()).await;
        if ok {
            return self
                .store
                .update(
                    id,
                    JobPatch {
                        last_status: Some(Some("ok".into())),
                        failures: Some(0),
                        next_run_at: Some(Some(next_run(&job.cron, now)?.to_rfc3339())),
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
                        next_run_at: Some(Some(next_run(&job.cron, now)?.to_rfc3339())),
                        ..Default::default()
                    },
                    now,
                )
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::tempdir;

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
}
