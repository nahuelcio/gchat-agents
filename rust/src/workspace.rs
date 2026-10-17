use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::config::RepoConfig;
use crate::text::thread_slug;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitChangeFile {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitChangeSummary {
    pub clean: bool,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub files: Vec<GitChangeFile>,
}

struct RunningApp {
    port: u16,
    child: tokio::process::Child,
}

pub struct Workspaces {
    root: PathBuf,
    repos: Mutex<HashMap<String, RepoConfig>>,
    apps: Mutex<HashMap<String, RunningApp>>,
}

impl Workspaces {
    pub fn new(root: impl AsRef<Path>, repos: HashMap<String, RepoConfig>) -> Self {
        let root = root.as_ref().to_path_buf();
        let _ = std::fs::create_dir_all(&root);
        Self {
            root,
            repos: Mutex::new(repos),
            apps: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_repos(&self, repos: HashMap<String, RepoConfig>) {
        *self.repos.lock().unwrap() = repos;
    }

    pub fn repo_names(&self) -> Vec<String> {
        self.repos.lock().unwrap().keys().cloned().collect()
    }

    pub fn is_up(&self, key: &str) -> bool {
        self.apps.lock().unwrap().contains_key(key)
    }

    pub fn port(&self, key: &str) -> Option<u16> {
        self.apps.lock().unwrap().get(key).map(|a| a.port)
    }

    pub fn down(&self, key: &str) -> bool {
        let mut apps = self.apps.lock().unwrap();
        if let Some(mut app) = apps.remove(key) {
            let _ = app.child.start_kill();
            true
        } else {
            false
        }
    }

    pub fn kill_all(&self) {
        let keys: Vec<String> = self.apps.lock().unwrap().keys().cloned().collect();
        for key in keys {
            self.down(&key);
        }
    }

    pub fn logs(&self, key: &str, _lines: usize) -> String {
        let path = self.root.join(format!("{key}.log"));
        std::fs::read_to_string(path).unwrap_or_default()
    }

    pub async fn create(&self, repo_name: &str, slug: &str) -> Result<(String, String), String> {
        let repo = self
            .repos
            .lock()
            .unwrap()
            .get(repo_name)
            .cloned()
            .ok_or_else(|| format!("unknown repo {repo_name}"))?;
        let branch = format!("switchboard/{slug}");
        let worktree = self.root.join(slug).to_string_lossy().to_string();
        let base = repo.base.clone().unwrap_or_else(|| "HEAD".into());
        let status = Command::new("git")
            .args(["-C", &repo.path, "worktree", "add", "-B", &branch, &worktree, &base])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("git worktree add failed for {repo_name}"));
        }
        Ok((worktree, branch))
    }

    pub async fn remove(&self, _repo_name: &str, worktree: &str) -> Result<(), String> {
        let status = Command::new("git")
            .args(["worktree", "remove", "--force", worktree])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !status.success() {
            let _ = tokio::fs::remove_dir_all(worktree).await;
        }
        Ok(())
    }

    pub async fn up(&self, key: &str, repo_name: &str, worktree: &str) -> Result<u16, String> {
        if self.is_up(key) {
            return self.port(key).ok_or_else(|| "app missing".to_string());
        }
        let repo = self
            .repos
            .lock()
            .unwrap()
            .get(repo_name)
            .cloned()
            .ok_or_else(|| format!("unknown repo {repo_name}"))?;
        let cmd = repo.up.ok_or_else(|| format!("repo {repo_name} has no up command"))?;
        let port = free_port().await?;
        let rendered = cmd.replace("{port}", &port.to_string());
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/C", &rendered])
            .current_dir(worktree)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        let mut child = Command::new("sh")
            .args(["-c", &rendered])
            .current_dir(worktree)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let _ = &mut child;
        self.apps.lock().unwrap().insert(key.to_string(), RunningApp { port, child });
        Ok(port)
    }

    pub async fn changes(&self, worktree: &str) -> Option<GitChangeSummary> {
        let output = Command::new("git")
            .args(["-C", worktree, "status", "--porcelain"])
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut files = Vec::new();
        let mut staged = 0u32;
        let mut unstaged = 0u32;
        let mut untracked = 0u32;
        for line in text.lines() {
            if line.len() < 3 {
                continue;
            }
            let status = line[..2].to_string();
            let path = line[3..].to_string();
            if status.starts_with('?') {
                untracked += 1;
            } else {
                if !status.starts_with(' ') {
                    staged += 1;
                }
                if !status.ends_with(' ') {
                    unstaged += 1;
                }
            }
            files.push(GitChangeFile { path, status });
        }
        Some(GitChangeSummary {
            clean: files.is_empty(),
            staged,
            unstaged,
            untracked,
            files,
        })
    }
}

pub fn slug_for(thread_key: &str) -> String {
    thread_slug(thread_key)
}

async fn free_port() -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_stable() {
        assert_eq!(slug_for("a"), slug_for("a"));
        assert_ne!(slug_for("a"), slug_for("b"));
    }
}
