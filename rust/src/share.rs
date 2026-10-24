use std::path::{Path, PathBuf};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq)]
pub enum ShareAccess {
    All,
    Thread(String),
}

pub struct ShareToken {
    file: PathBuf,
    token: String,
}

impl ShareToken {
    pub fn open(file: impl AsRef<Path>) -> Self {
        let file = file.as_ref().to_path_buf();
        let saved = std::fs::read_to_string(&file).unwrap_or_default().trim().to_string();
        let token = if is_token(&saved) {
            saved
        } else {
            write_token(&file)
        };
        Self { file, token }
    }

    pub fn value(&self) -> &str {
        &self.token
    }

    pub fn rotate(&mut self) -> &str {
        self.token = write_token(&self.file);
        &self.token
    }

    pub fn check(&self, candidate: Option<&str>) -> bool {
        candidate.is_some_and(|c| same(c, &self.token))
    }

    pub fn scoped(&self, thread: &str) -> String {
        format!("{thread}.{}", self.sign(thread))
    }

    pub fn access(&self, candidate: Option<&str>) -> Option<ShareAccess> {
        let candidate = candidate?;
        if same(candidate, &self.token) {
            return Some(ShareAccess::All);
        }
        let (thread, sig) = candidate.rsplit_once('.')?;
        same(sig, &self.sign(thread)).then(|| ShareAccess::Thread(thread.to_string()))
    }

    fn sign(&self, thread: &str) -> String {
        let mut h = Sha256::new();
        h.update(self.token.as_bytes());
        h.update(b":thread:");
        h.update(thread.as_bytes());
        hex::encode(&h.finalize()[..16])
    }
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.as_bytes().iter().zip(b.as_bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn is_token(s: &str) -> bool {
    s.len() == 48 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn write_token(file: &Path) -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(file, format!("{token}\n"));
    token
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    pub name: String,
    pub role: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredUser {
    name: String,
    salt: String,
    password_hash: String,
    role: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredSession {
    token_hash: String,
    user: String,
    exp: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct UserFile {
    #[serde(default)]
    users: Vec<StoredUser>,
    #[serde(default)]
    sessions: Vec<StoredSession>,
}

fn hash_password(salt: &str, password: &str) -> String {
    let mut acc = {
        let mut h = Sha256::new();
        h.update(salt.as_bytes());
        h.update(password.as_bytes());
        h.finalize().to_vec()
    };
    for _ in 0..2000 {
        let mut h = Sha256::new();
        h.update(&acc);
        h.update(password.as_bytes());
        acc = h.finalize().to_vec();
    }
    hex::encode(acc)
}

fn token_hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

pub struct UserStore {
    path: PathBuf,
    file: std::sync::Mutex<UserFile>,
}

impl UserStore {
    pub fn open(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let file = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, file: std::sync::Mutex::new(file) }
    }

    pub fn is_empty(&self) -> bool {
        self.file.lock().unwrap().users.is_empty()
    }

    pub fn list(&self) -> Vec<(String, String)> {
        self.file.lock().unwrap().users.iter().map(|u| (u.name.clone(), u.role.clone())).collect()
    }

    pub fn add(&self, name: &str, password: &str, role: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.len() > 40 {
            return Err("name is required".into());
        }
        if password.len() < 8 {
            return Err("password must be at least 8 characters".into());
        }
        if !matches!(role, "admin" | "operator" | "guest") {
            return Err("role must be admin, operator or guest".into());
        }
        let mut file = self.file.lock().unwrap();
        if file.users.iter().any(|u| u.name.eq_ignore_ascii_case(name)) {
            return Err("that name is already used".into());
        }
        let mut salt_bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt_bytes);
        let salt = hex::encode(salt_bytes);
        file.users.push(StoredUser { name: name.to_string(), password_hash: hash_password(&salt, password), salt, role: role.to_string() });
        drop(file);
        self.persist()
    }

    pub fn remove(&self, name: &str) -> Result<(), String> {
        let mut file = self.file.lock().unwrap();
        let Some(idx) = file.users.iter().position(|u| u.name.eq_ignore_ascii_case(name)) else {
            return Err("no such user".into());
        };
        let removing_admin = file.users[idx].role == "admin";
        let admins = file.users.iter().filter(|u| u.role == "admin").count();
        if removing_admin && admins <= 1 && file.users.len() > 1 {
            return Err("keep at least one admin".into());
        }
        file.users.remove(idx);
        file.sessions.retain(|s| !s.user.eq_ignore_ascii_case(name));
        drop(file);
        self.persist()
    }

    pub fn login(&self, name: &str, password: &str) -> Result<String, String> {
        let mut file = self.file.lock().unwrap();
        let user = file.users.iter().find(|u| u.name.eq_ignore_ascii_case(name.trim())).ok_or("unknown user or password")?;
        if hash_password(&user.salt, password) != user.password_hash {
            return Err("unknown user or password".into());
        }
        let user_name = user.name.clone();
        let mut bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let exp = chrono::Utc::now().timestamp() + 14 * 24 * 3600;
        file.sessions.retain(|s| s.exp > chrono::Utc::now().timestamp());
        file.sessions.push(StoredSession { token_hash: token_hash(&token), user: user_name, exp });
        drop(file);
        self.persist()?;
        Ok(token)
    }

    pub fn logout(&self, token: &str) {
        self.file.lock().unwrap().sessions.retain(|s| s.token_hash != token_hash(token));
        let _ = self.persist();
    }

    pub fn actor_for_token(&self, token: Option<&str>) -> Option<Actor> {
        let token = token?;
        let mut file = self.file.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        file.sessions.retain(|s| s.exp > now);
        let session = file.sessions.iter().find(|s| s.token_hash == token_hash(token))?;
        let user = file.users.iter().find(|u| u.name == session.user)?;
        Some(Actor { name: user.name.clone(), role: user.role.clone() })
    }

    fn persist(&self) -> Result<(), String> {
        let body = serde_json::to_string_pretty(&*self.file.lock().unwrap()).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&self.path, body).map_err(|e| e.to_string())
    }
}

pub fn cookie_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (k, v) = part.trim().split_once('=')?;
        (k == "sb_session").then(|| v.trim().to_string())
    })
}

pub fn session_cookie(token: &str) -> String {
    format!("sb_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600")
}

pub fn clear_cookie() -> String {
    "sb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0".into()
}

/// No users yet: the local panel stays open as admin. Once someone creates a user, a session is required.
pub const INTERNAL_HEADER: &str = "x-switchboard-internal";

pub fn internal_token(data_dir: &Path) -> String {
    let path = data_dir.join("internal-token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if existing.len() >= 32 {
            return existing.to_string();
        }
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let _ = std::fs::write(&path, &token);
    token
}

pub fn resolve_actor(data_dir: &Path, headers: &axum::http::HeaderMap) -> Option<Actor> {
    let store = UserStore::open(data_dir.join("users.json"));
    if store.is_empty() {
        return Some(Actor { name: "local".into(), role: "admin".into() });
    }
    if let Some(sent) = headers.get(INTERNAL_HEADER).and_then(|v| v.to_str().ok()) {
        let expected = internal_token(data_dir);
        if Sha256::digest(sent.as_bytes()) == Sha256::digest(expected.as_bytes()) {
            return Some(Actor { name: "agent".into(), role: "admin".into() });
        }
    }
    store.actor_for_token(cookie_token(headers).as_deref())
}

pub fn role_allows(role: &str, method: &str, path: &str) -> bool {
    if path == "/api/login" || path == "/api/logout" || path == "/api/me" {
        return true;
    }
    match role {
        "admin" => true,
        "operator" => method == "GET" || method == "HEAD" || !operator_denied(path),
        _ => false,
    }
}

fn operator_denied(path: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "/api/settings",
        "/api/users",
        "/api/share",
        "/api/pi/key",
        "/api/pi/packages/install",
        "/api/pi/packages/remove",
        "/api/google/key",
        "/api/ado",
        "/api/mcp/catalog",
        "/api/mcp/import",
        "/api/triggers",
    ];
    PREFIXES.iter().any(|p| path.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn create_check_rotate() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("share-token");
        let mut token = ShareToken::open(&path);
        assert!(token.check(Some(token.value())));
        assert!(!token.check(Some("nope")));
        let old = token.value().to_string();
        token.rotate();
        assert_ne!(token.value(), old);
        assert!(!token.check(Some(&old)));
    }

    #[test]
    fn scoped_tokens_open_one_thread() {
        let dir = tempdir().unwrap();
        let mut token = ShareToken::open(dir.path().join("share-token"));
        let scoped = token.scoped("room1");
        assert_eq!(token.access(Some(&scoped)), Some(ShareAccess::Thread("room1".into())));
        assert_eq!(token.access(Some(token.value())), Some(ShareAccess::All));
        assert_eq!(token.access(Some(&scoped.replace("room1", "room2"))), None);
        token.rotate();
        assert_eq!(token.access(Some(&scoped)), None);
    }

    #[test]
    fn login_issues_a_session_and_operators_cannot_change_settings() {
        let dir = tempdir().unwrap();
        let store = UserStore::open(dir.path().join("users.json"));
        assert!(store.is_empty());
        store.add("Ana", "correcthorsebatterystaple", "admin").unwrap();
        assert!(store.add("Ana", "correcthorsebatterystaple", "admin").is_err());
        assert!(store.add("Bo", "short", "operator").is_err());
        store.add("Bo", "longenough", "operator").unwrap();
        let token = store.login("bo", "longenough").unwrap();
        assert_eq!(store.actor_for_token(Some(&token)).unwrap().role, "operator");
        assert!(store.login("bo", "wrongpass").is_err());
        assert!(role_allows("operator", "GET", "/api/settings"));
        assert!(!role_allows("operator", "PUT", "/api/settings"));
        assert!(role_allows("operator", "POST", "/api/team/send"));
        assert!(role_allows("admin", "PUT", "/api/settings"));
        assert!(!role_allows("guest", "GET", "/api/threads"));
    }
}
