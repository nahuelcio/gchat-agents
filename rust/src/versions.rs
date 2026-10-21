use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::atomic::write_atomic;
use crate::settings::{Persona, Settings};

const MAX_VERSIONS: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillRef {
    pub name: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Version {
    pub id: String,
    pub agent: String,
    pub at: String,
    pub harness: String,
    pub model: String,
    pub prompt: String,
    pub skills: Vec<SkillRef>,
    pub mcps: Vec<String>,
}

impl Version {
    fn fingerprint(&self) -> String {
        let skills: Vec<String> = self.skills.iter().map(|s| format!("{}={}", s.name, s.hash)).collect();
        short(&format!("{}\n{}\n{}\n{}\n{}", self.harness, self.model, self.prompt, skills.join(","), self.mcps.join(",")))
    }
}

fn short(s: &str) -> String {
    let h = Sha256::digest(s.as_bytes());
    h.iter().take(3).map(|b| format!("{b:02x}")).collect()
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf).unwrap_or_default()
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).current_dir(root).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn harness_now(root: &Path) -> String {
    let Some(sha) = git(root, &["rev-parse", "--short=7", "HEAD"]) else {
        return format!("build-{}", env!("CARGO_PKG_VERSION"));
    };
    let diff = git(root, &["diff", "HEAD", "--", "rust/src", "harness", "skills"]).unwrap_or_default();
    if diff.is_empty() {
        sha
    } else {
        format!("{sha}+{}", short(&diff))
    }
}

fn harness_cached() -> String {
    static CACHE: Mutex<Option<(Instant, String)>> = Mutex::new(None);
    let mut c = CACHE.lock().unwrap();
    if let Some((at, v)) = c.as_ref() {
        if at.elapsed() < Duration::from_secs(30) {
            return v.clone();
        }
    }
    let v = harness_now(&repo_root());
    *c = Some((Instant::now(), v.clone()));
    v
}

fn describe(p: &Persona, model: String, harness: &str) -> Version {
    let skills = p
        .skills
        .iter()
        .map(|n| {
            let hash = crate::skills::load(n)
                .map(|s| {
                    let files: Vec<String> = s.files.iter().map(|f| format!("{}\n{}", f.path, f.content)).collect();
                    short(&format!("{}\n{}\n{}", s.description, s.body, files.join("\n")))
                })
                .unwrap_or_else(|| "missing".into());
            SkillRef { name: n.clone(), hash }
        })
        .collect();
    let mut v = Version {
        id: String::new(),
        agent: p.name.clone(),
        at: chrono::Local::now().to_rfc3339(),
        harness: harness.to_string(),
        model,
        prompt: p.prompt.trim().to_string(),
        skills,
        mcps: crate::skills::mcps(p),
    };
    v.id = v.fingerprint();
    v
}

pub fn current(settings: &Settings) -> Vec<Version> {
    let harness = harness_cached();
    let default_model = settings.models.pi.clone().unwrap_or_else(|| "default".into());
    let mut out = vec![describe(&crate::driver::pi::host_persona(settings), default_model.clone(), &harness)];
    for p in &settings.personas {
        out.push(describe(p, p.model.clone().unwrap_or_else(|| default_model.clone()), &harness));
    }
    out
}

pub struct VersionStore {
    path: PathBuf,
    list: Mutex<Vec<Version>>,
}

impl VersionStore {
    pub fn open(path: PathBuf) -> Self {
        let list = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, list: Mutex::new(list) }
    }

    pub fn all(&self) -> Vec<Version> {
        self.list.lock().unwrap().clone()
    }

    pub async fn record(&self, now: Vec<Version>) -> Result<Vec<Version>, String> {
        let changed = {
            let mut list = self.list.lock().unwrap();
            let mut changed = false;
            for v in &now {
                let last = list.iter().rev().find(|x| x.agent == v.agent);
                if last.map(|l| l.id != v.id).unwrap_or(true) {
                    list.push(v.clone());
                    changed = true;
                }
            }
            let n = list.len();
            if n > MAX_VERSIONS {
                list.drain(..n - MAX_VERSIONS);
            }
            changed
        };
        if changed {
            let body = serde_json::to_string_pretty(&*self.list.lock().unwrap()).map_err(|e| e.to_string())?;
            write_atomic(&self.path, &body).await.map_err(|e| e.to_string())?;
        }
        Ok(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(agent: &str, prompt: &str) -> Version {
        let mut v = Version { id: String::new(), agent: agent.into(), at: "t".into(), harness: "abc".into(), model: "m".into(), prompt: prompt.into(), skills: vec![], mcps: vec![] };
        v.id = v.fingerprint();
        v
    }

    #[test]
    fn fingerprint_tracks_every_part() {
        let a = v("host", "hi");
        let mut b = a.clone();
        b.skills.push(SkillRef { name: "s".into(), hash: "1".into() });
        assert_ne!(a.fingerprint(), b.fingerprint());
        let mut c = a.clone();
        c.harness = "abc+ff".into();
        assert_ne!(a.fingerprint(), c.fingerprint());
        assert_eq!(a.id.len(), 6);
    }

    #[tokio::test]
    async fn records_only_changes() {
        let dir = std::env::temp_dir().join(format!("versions-{}", uuid::Uuid::new_v4()));
        let store = VersionStore::open(dir.join("v.json"));
        store.record(vec![v("host", "a"), v("bot", "x")]).await.unwrap();
        store.record(vec![v("host", "a"), v("bot", "x")]).await.unwrap();
        assert_eq!(store.all().len(), 2);
        store.record(vec![v("host", "b"), v("bot", "x")]).await.unwrap();
        assert_eq!(store.all().len(), 3);
        assert_eq!(VersionStore::open(dir.join("v.json")).all().len(), 3);
        let _ = std::fs::remove_dir_all(dir);
    }
}
