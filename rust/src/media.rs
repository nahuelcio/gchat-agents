use std::path::{Path, PathBuf};

use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::transcripts::MessageAttachment;

const ID_RE: &str = r"^[a-f0-9]{24}$";

#[derive(Debug, Clone)]
pub struct StoredMedia {
    pub id: String,
    pub path: PathBuf,
    pub content_type: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaMeta {
    content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    file: String,
}

pub struct MediaStore {
    pub dir: PathBuf,
}

impl MediaStore {
    pub fn open(dir: impl AsRef<Path>) -> Self {
        let dir = std::fs::canonicalize(dir.as_ref()).unwrap_or_else(|_| dir.as_ref().to_path_buf());
        let _ = std::fs::create_dir_all(&dir);
        Self { dir }
    }

    pub async fn save(
        &self,
        bytes: &[u8],
        content_type: &str,
        name: Option<&str>,
    ) -> Result<StoredMedia, String> {
        let mut id_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let id = hex::encode(id_bytes);
        let ext = ext_for(content_type, name);
        let file_name = format!("{id}{ext}");
        let path = self.dir.join(&file_name);
        let meta = MediaMeta {
            content_type: content_type.to_string(),
            name: name.map(str::to_string),
            file: file_name,
        };
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(
            self.dir.join(format!("{id}.json")),
            format!("{}\n", serde_json::to_string(&meta).map_err(|e| e.to_string())?),
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(StoredMedia {
            id,
            path,
            content_type: content_type.to_string(),
            name: name.map(str::to_string),
        })
    }

    pub async fn read(&self, id: &str) -> Option<(Vec<u8>, String, Option<String>)> {
        if !regex::Regex::new(ID_RE).unwrap().is_match(id) {
            return None;
        }
        let meta_path = self.dir.join(format!("{id}.json"));
        let raw = tokio::fs::read_to_string(&meta_path).await.ok()?;
        let meta: MediaMeta = serde_json::from_str(&raw).ok()?;
        let file = Path::new(&meta.file)
            .file_name()
            .and_then(|s| s.to_str())?
            .to_string();
        if !file.starts_with(id) {
            return None;
        }
        let bytes = tokio::fs::read(self.dir.join(&file)).await.ok()?;
        Some((bytes, meta.content_type, meta.name))
    }
}

fn ext_for(content_type: &str, name: Option<&str>) -> String {
    if let Some(name) = name {
        let ext = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        if !ext.is_empty() && ext.len() <= 8 {
            return ext;
        }
    }
    match content_type.to_lowercase().as_str() {
        "image/png" => ".png".into(),
        "image/jpeg" | "image/jpg" => ".jpg".into(),
        "image/gif" => ".gif".into(),
        "image/webp" => ".webp".into(),
        "image/svg+xml" => ".svg".into(),
        _ => String::new(),
    }
}

pub fn to_message_attachment(m: &StoredMedia) -> MessageAttachment {
    MessageAttachment {
        id: m.id.clone(),
        content_type: m.content_type.clone(),
        name: m.name.clone(),
    }
}

pub fn attachment_prompt_line(m: &StoredMedia) -> String {
    let label = m
        .name
        .as_deref()
        .map(|n| format!("\"{n}\""))
        .unwrap_or_else(|| m.content_type.clone());
    format!(
        "[Attached {} {}: {}]",
        m.content_type,
        label,
        m.path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn save_and_read_roundtrip() {
        let dir = tempdir().unwrap();
        let store = MediaStore::open(dir.path());
        let saved = store
            .save(b"png-bytes", "image/png", Some("shot.png"))
            .await
            .unwrap();
        assert_eq!(saved.content_type, "image/png");
        let (bytes, ct, name) = store.read(&saved.id).await.unwrap();
        assert_eq!(bytes, b"png-bytes");
        assert_eq!(ct, "image/png");
        assert_eq!(name.as_deref(), Some("shot.png"));
        assert!(attachment_prompt_line(&saved).contains(saved.path.to_str().unwrap()));
    }
}
