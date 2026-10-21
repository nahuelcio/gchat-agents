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

pub fn git_root(path: &str) -> Option<std::path::PathBuf> {
    let mut dir = std::fs::canonicalize(path.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`')).ok()?;
    if dir.is_file() {
        dir = dir.parent()?.to_path_buf();
    }
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
}

pub fn looks_like_path(s: &str) -> bool {
    let s = s.trim_matches(|c| c == '"' || c == '\'' || c == '`');
    let b = s.as_bytes();
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || s.starts_with('/') || s.starts_with("~/")
}

pub fn paths_in(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == ',' || c == ')' || c == '(' || c == '.'))
        .filter(|w| looks_like_path(w))
        .map(String::from)
        .collect()
}

pub struct Workspaces {
    root: PathBuf,
    repos: Mutex<HashMap<String, RepoConfig>>,
    apps: Mutex<HashMap<String, RunningApp>>,
    changes_cache: Mutex<HashMap<String, (std::time::Instant, Option<GitChangeSummary>)>>,
}

const CHANGES_TTL: std::time::Duration = std::time::Duration::from_secs(5);

impl Workspaces {
    pub fn new(root: impl AsRef<Path>, repos: HashMap<String, RepoConfig>) -> Self {
        let root = root.as_ref().to_path_buf();
        let _ = std::fs::create_dir_all(&root);
        Self {
            root,
            repos: Mutex::new(repos),
            apps: Mutex::new(HashMap::new()),
            changes_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_repos(&self, repos: HashMap<String, RepoConfig>) {
        *self.repos.lock().unwrap() = repos;
    }

    pub fn repo_for_path(&self, path: &str) -> Option<String> {
        let want = std::fs::canonicalize(path).ok()?;
        self.repos
            .lock()
            .unwrap()
            .iter()
            .find(|(_, r)| std::fs::canonicalize(&r.path).ok().as_ref() == Some(&want))
            .map(|(name, _)| name.clone())
    }

    pub fn register(&self, name: &str, repo: RepoConfig) {
        self.repos.lock().unwrap().insert(name.to_string(), repo);
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
        let dir = self.thread_dir(slug);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let worktree = dir.join(repo_name).to_string_lossy().to_string();
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

    pub fn thread_dir(&self, slug: &str) -> PathBuf {
        self.root.join(slug)
    }

    pub async fn remove_thread(&self, dir: &str) -> Result<(), String> {
        for repo in repo_dirs(Path::new(dir)) {
            let name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            self.remove(&name, &repo.to_string_lossy()).await?;
        }
        remove_dir(dir).await;
        Ok(())
    }

    pub async fn changes_in(&self, dir: &str) -> Option<GitChangeSummary> {
        if let Some((at, cached)) = self.changes_cache.lock().unwrap().get(dir) {
            if at.elapsed() < CHANGES_TTL {
                return cached.clone();
            }
        }
        let fresh = self.scan_changes(dir).await;
        self.changes_cache
            .lock()
            .unwrap()
            .insert(dir.to_string(), (std::time::Instant::now(), fresh.clone()));
        fresh
    }

    async fn scan_changes(&self, dir: &str) -> Option<GitChangeSummary> {
        if Path::new(dir).join(".git").exists() {
            return self.changes(dir).await;
        }
        let mut all = GitChangeSummary { clean: true, staged: 0, unstaged: 0, untracked: 0, files: Vec::new() };
        for repo in repo_dirs(Path::new(dir)) {
            let name = repo.file_name()?.to_string_lossy().into_owned();
            let Some(one) = self.changes(&repo.to_string_lossy()).await else { continue };
            all.staged += one.staged;
            all.unstaged += one.unstaged;
            all.untracked += one.untracked;
            all.files.extend(one.files.into_iter().map(|f| GitChangeFile { path: format!("{name}/{}", f.path), status: f.status }));
        }
        all.clean = all.files.is_empty();
        Some(all)
    }

    pub async fn remove(&self, repo_name: &str, worktree: &str) -> Result<(), String> {
        let repo = self.repos.lock().unwrap().get(repo_name).map(|r| r.path.clone());
        let mut cmd = Command::new("git");
        if let Some(path) = &repo {
            cmd.args(["-C", path]);
        }
        let removed = cmd
            .args(["worktree", "remove", "--force", worktree])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if !removed {
            remove_dir(worktree).await;
            if let Some(path) = &repo {
                let _ = Command::new("git").args(["-C", path, "worktree", "prune"]).status().await;
            }
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
        let log = std::fs::File::create(self.root.join(format!("{key}.log"))).map_err(|e| e.to_string())?;
        let err = log.try_clone().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/C", &rendered])
            .current_dir(worktree)
            .stdout(log)
            .stderr(err)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        let mut child = Command::new("sh")
            .args(["-c", &rendered])
            .current_dir(worktree)
            .stdout(log)
            .stderr(err)
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

async fn remove_dir(dir: &str) {
    for _ in 0..20 {
        if tokio::fs::remove_dir_all(dir).await.is_ok() || !Path::new(dir).exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

fn repo_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.join(".git").exists()).collect();
    out.sort();
    out
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
    fn finds_paths_and_git_roots() {
        let found = paths_in(r#"mirá "D:\code\app\src" y /home/me/x, no esto"#);
        assert_eq!(found, vec![r"D:\code\app\src".to_string(), "/home/me/x".to_string()]);
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("repo/.git")).unwrap();
        std::fs::create_dir_all(tmp.path().join("repo/src")).unwrap();
        let root = git_root(tmp.path().join("repo/src").to_str().unwrap()).unwrap();
        assert!(root.ends_with("repo"));
        assert!(git_root(tmp.path().to_str().unwrap()).is_none() || !git_root(tmp.path().to_str().unwrap()).unwrap().starts_with(tmp.path()));
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "safe.directory=*"])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo(root: &Path, name: &str) -> RepoConfig {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("README.md"), name).unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "init"]);
        RepoConfig { path: dir.to_string_lossy().into_owned(), up: None, base: None }
    }

    #[tokio::test]
    async fn one_thread_folder_holds_many_repos() {
        let tmp = tempfile::tempdir().unwrap();
        let repos = HashMap::from([("api".to_string(), repo(tmp.path(), "api")), ("web".to_string(), repo(tmp.path(), "web"))]);
        let ws = Workspaces::new(tmp.path().join("worktrees"), repos);
        let (api, _) = ws.create("api", "t1").await.unwrap();
        let (web, branch) = ws.create("web", "t1").await.unwrap();
        let dir = ws.thread_dir("t1");
        assert_eq!(Path::new(&api), dir.join("api"));
        assert_eq!(Path::new(&web), dir.join("web"));
        assert_eq!(branch, "switchboard/t1");
        std::fs::write(dir.join("web").join("new.txt"), "x").unwrap();
        let changes = ws.changes_in(&dir.to_string_lossy()).await.unwrap();
        assert_eq!(changes.untracked, 1);
        assert_eq!(changes.files[0].path, "web/new.txt");
        ws.remove_thread(&dir.to_string_lossy()).await.unwrap();
        assert!(!dir.exists());
        let list = std::process::Command::new("git").args(["-C", &tmp.path().join("api").to_string_lossy(), "worktree", "list"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&list.stdout).lines().count(), 1);
    }

    #[test]
    fn slug_stable() {
        assert_eq!(slug_for("a"), slug_for("a"));
        assert_ne!(slug_for("a"), slug_for("b"));
    }
}
