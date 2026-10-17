use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::atomic::write_atomic_sync;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Persisted {
    starts: u64,
    crashes: u64,
    running: bool,
    #[serde(rename = "lastStartAt", skip_serializing_if = "Option::is_none")]
    last_start_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub starts: u64,
    pub crashes: u64,
    pub supervised: bool,
    pub started_at: String,
    pub uptime_sec: u64,
    pub last_beat_ago_sec: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

pub struct Health {
    file: PathBuf,
    state: Persisted,
    started_at: SystemTime,
    last_beat: SystemTime,
    pub supervised: bool,
}

impl Health {
    pub fn new(file: impl AsRef<Path>, supervised: bool, now: SystemTime) -> Self {
        let file = file.as_ref().to_path_buf();
        let prev = std::fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Persisted>(&raw).ok())
            .unwrap_or(Persisted {
                starts: 0,
                crashes: 0,
                running: false,
                last_start_at: None,
            });
        let state = Persisted {
            starts: prev.starts + 1,
            crashes: prev.crashes + u64::from(prev.running),
            running: true,
            last_start_at: Some(format_iso(now)),
        };
        let health = Self {
            file,
            state,
            started_at: now,
            last_beat: now,
            supervised,
        };
        health.save();
        health
    }

    pub fn from_env(file: impl AsRef<Path>) -> Self {
        let supervised = std::env::var("SWITCHBOARD_SUPERVISED").ok().as_deref() == Some("systemd");
        Self::new(file, supervised, SystemTime::now())
    }

    pub fn beat(&mut self, at: SystemTime) {
        self.last_beat = at;
    }

    pub fn mark_stopped(&mut self) {
        self.state.running = false;
        self.save();
    }

    pub fn snapshot(&self, now: SystemTime) -> HealthSnapshot {
        HealthSnapshot {
            starts: self.state.starts,
            crashes: self.state.crashes,
            supervised: self.supervised,
            started_at: format_iso(self.started_at),
            uptime_sec: elapsed_secs(self.started_at, now),
            last_beat_ago_sec: elapsed_secs(self.last_beat, now),
            endpoint: None,
        }
    }

    fn save(&self) {
        let body = format!("{}\n", serde_json::to_string(&self.state).unwrap_or_else(|_| "{}".into()));
        if let Err(err) = write_atomic_sync(&self.file, &body) {
            tracing::error!(?err, "could not persist health");
        }
    }
}

fn format_iso(t: SystemTime) -> String {
    let secs = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or(chrono::DateTime::UNIX_EPOCH)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn elapsed_secs(from: SystemTime, to: SystemTime) -> u64 {
    to.duration_since(from).unwrap_or_default().as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn counts_starts_and_crashes() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("health.json");
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let first = Health::new(&file, false, t0);
        assert_eq!(first.snapshot(t0).starts, 1);
        assert_eq!(first.snapshot(t0).crashes, 0);
        drop(first);
        let second = Health::new(&file, true, t0 + Duration::from_secs(10));
        assert_eq!(second.snapshot(t0).starts, 2);
        assert_eq!(second.snapshot(t0).crashes, 1);
        assert!(second.supervised);
    }
}
