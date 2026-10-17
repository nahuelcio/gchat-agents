use std::path::{Path, PathBuf};

use rand::RngCore;

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
        let Some(candidate) = candidate else {
            return false;
        };
        if candidate.len() != self.token.len() {
            return false;
        }
        candidate
            .as_bytes()
            .iter()
            .zip(self.token.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }
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
}
