use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::driver::types::ContextUsage;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub cost_usd: f64,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub at: String,
    pub thread: String,
    pub agent: String,
    #[serde(flatten)]
    pub delta: Totals,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub key: String,
    #[serde(flatten)]
    pub totals: Totals,
    pub turns: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub total: Row,
    pub by_day: Vec<Row>,
    pub by_agent: Vec<Row>,
    pub by_thread: Vec<Row>,
}

static GLOBAL: std::sync::OnceLock<UsageLedger> = std::sync::OnceLock::new();

pub fn init(dir: impl AsRef<Path>) {
    let _ = GLOBAL.set(UsageLedger::open(dir));
}

pub fn global() -> Option<&'static UsageLedger> {
    GLOBAL.get()
}

pub fn note(thread: &str, agent: &str, conversation: Option<&str>, usage: Option<&ContextUsage>) {
    if let Some(l) = global() {
        l.record(thread, agent, conversation, usage);
    }
}

pub struct UsageLedger {
    log: PathBuf,
    seen_file: PathBuf,
    seen: Mutex<HashMap<String, Totals>>,
}

impl UsageLedger {
    pub fn open(dir: impl AsRef<Path>) -> Self {
        let dir = dir.as_ref();
        let seen_file = dir.join("usage-seen.json");
        let seen = std::fs::read_to_string(&seen_file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { log: dir.join("usage.jsonl"), seen_file, seen: Mutex::new(seen) }
    }

    pub fn record(&self, thread: &str, agent: &str, conversation: Option<&str>, usage: Option<&ContextUsage>) {
        let (Some(conversation), Some(u)) = (conversation, usage) else { return };
        let now = Totals { cost_usd: u.cost_usd.unwrap_or(0.0), tokens_in: u.tokens_in.unwrap_or(0), tokens_out: u.tokens_out.unwrap_or(0) };
        let delta = {
            let mut seen = self.seen.lock().unwrap();
            let prev = seen.get(conversation).cloned().unwrap_or_default();
            let fresh = now.cost_usd < prev.cost_usd || now.tokens_in < prev.tokens_in;
            let base = if fresh { Totals::default() } else { prev };
            seen.insert(conversation.to_string(), now.clone());
            let _ = std::fs::write(&self.seen_file, serde_json::to_string(&*seen).unwrap_or_default());
            Totals { cost_usd: now.cost_usd - base.cost_usd, tokens_in: now.tokens_in - base.tokens_in, tokens_out: now.tokens_out.saturating_sub(base.tokens_out) }
        };
        if delta == Totals::default() {
            return;
        }
        let entry = UsageEntry { at: chrono::Local::now().to_rfc3339(), thread: thread.to_string(), agent: agent.to_string(), delta };
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            let _ = writeln!(f, "{}", serde_json::to_string(&entry).unwrap_or_default());
        }
    }

    pub fn entries(&self) -> Vec<UsageEntry> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    pub fn report(&self, since: &str) -> Report {
        report(&self.entries(), since)
    }
}

fn add(rows: &mut BTreeMap<String, Row>, key: &str, d: &Totals) {
    let row = rows.entry(key.to_string()).or_insert_with(|| Row { key: key.to_string(), ..Default::default() });
    row.totals.cost_usd += d.cost_usd;
    row.totals.tokens_in += d.tokens_in;
    row.totals.tokens_out += d.tokens_out;
    row.turns += 1;
}

fn by_cost(rows: BTreeMap<String, Row>) -> Vec<Row> {
    let mut v: Vec<Row> = rows.into_values().collect();
    v.sort_by(|a, b| b.totals.cost_usd.total_cmp(&a.totals.cost_usd).then(b.totals.tokens_in.cmp(&a.totals.tokens_in)));
    v
}

pub fn report(entries: &[UsageEntry], since: &str) -> Report {
    let (mut day, mut agent, mut thread, mut total) = (BTreeMap::new(), BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
    for e in entries.iter().filter(|e| e.at.as_str() >= since) {
        add(&mut day, &e.at[..10.min(e.at.len())], &e.delta);
        add(&mut agent, &e.agent, &e.delta);
        add(&mut thread, &e.thread, &e.delta);
        add(&mut total, "total", &e.delta);
    }
    Report {
        total: total.remove("total").unwrap_or_else(|| Row { key: "total".into(), ..Default::default() }),
        by_day: day.into_values().collect(),
        by_agent: by_cost(agent),
        by_thread: by_cost(thread),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(cost: f64, tin: u64, tout: u64) -> ContextUsage {
        ContextUsage { context_tokens: 1, context_window: None, cost_usd: Some(cost), tokens_in: Some(tin), tokens_out: Some(tout), tokens_per_sec: None }
    }

    #[test]
    fn records_deltas_per_conversation_and_reports() {
        let dir = tempfile::tempdir().unwrap();
        let ledger = UsageLedger::open(dir.path());
        ledger.record("dm/1", "Host", Some("c1"), Some(&usage(0.10, 1000, 100)));
        ledger.record("dm/1", "Host", Some("c1"), Some(&usage(0.25, 2500, 300)));
        ledger.record("dm/1", "Host", Some("c1"), Some(&usage(0.25, 2500, 300)));
        ledger.record("dm/1", "Reviewer", Some("c2"), Some(&usage(0.05, 500, 50)));
        let again = UsageLedger::open(dir.path());
        again.record("dm/1", "Host", Some("c1"), Some(&usage(0.30, 3000, 350)));
        let r = again.report("");
        assert_eq!(r.total.turns, 4);
        assert!((r.total.totals.cost_usd - 0.35).abs() < 1e-9);
        assert_eq!(r.by_agent[0].key, "Host");
        assert_eq!(r.by_agent[0].totals.tokens_in, 3000);
        assert_eq!(r.by_day.len(), 1);
        assert_eq!(r.by_thread[0].turns, 4);
    }
}
