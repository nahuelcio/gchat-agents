use std::path::{Path, PathBuf};

use rand::RngCore;
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
}
