use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::atomic::write_atomic;
use crate::pi_keys::{self, PROVIDERS};

const DEFAULT_CONTEXT: u32 = 128_000;
const DEFAULT_MAX_TOKENS: u32 = 32_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderStatus {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
    pub api_key_env: String,
    pub context_window: u32,
    pub max_tokens: u32,
    pub key_source: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderUpsert {
    pub id: Option<String>,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub models: Option<Vec<String>>,
    pub api_key: Option<String>,
    pub clear_key: Option<bool>,
    pub context_window: Option<u32>,
    pub max_tokens: Option<u32>,
}

pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("pi-custom-providers.json")
}

fn read(data_dir: &Path) -> Vec<CustomProvider> {
    std::fs::read_to_string(file(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

async fn write(data_dir: &Path, list: &[CustomProvider]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    write_atomic(&file(data_dir), &body).await.map_err(|e| e.to_string())
}

fn env_for(id: &str) -> String {
    let snake = id
        .chars()
        .map(|c| if c == '-' { '_' } else { c.to_ascii_uppercase() })
        .collect::<String>();
    format!("PI_CUSTOM_{snake}_API_KEY")
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("id must be 1–64 characters".into());
    }
    if !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("id must be lowercase letters, digits, or hyphens".into());
    }
    if id == "faux" || PROVIDERS.iter().any(|(p, _, _)| *p == id) {
        return Err(format!("id {id} is reserved for a built-in Pi provider"));
    }
    Ok(())
}

fn normalize_models(models: &[String]) -> Result<Vec<String>, String> {
    let out: Vec<String> = models.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
    if out.is_empty() {
        return Err("at least one model id is required".into());
    }
    Ok(out)
}

fn to_status(data_dir: &Path, p: &CustomProvider) -> CustomProviderStatus {
    let api_key_env = p.api_key_env.clone().unwrap_or_else(|| env_for(&p.id));
    CustomProviderStatus {
        id: p.id.clone(),
        name: p.name.clone(),
        base_url: p.base_url.clone(),
        models: p.models.clone(),
        api_key_env: api_key_env.clone(),
        context_window: p.context_window.unwrap_or(DEFAULT_CONTEXT),
        max_tokens: p.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        key_source: pi_keys::env_source(data_dir, &api_key_env),
    }
}

pub fn list(data_dir: &Path) -> Vec<CustomProviderStatus> {
    read(data_dir).iter().map(|p| to_status(data_dir, p)).collect()
}

pub async fn upsert(data_dir: &Path, body: CustomProviderUpsert) -> Result<Vec<CustomProviderStatus>, String> {
    let id = body.id.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    validate_id(&id)?;
    let name = body.name.as_deref().unwrap_or("").trim();
    let name = if name.is_empty() { id.clone() } else { name.to_string() };
    let base_url = body.base_url.as_deref().unwrap_or("").trim().to_string();
    if base_url.is_empty() {
        return Err("baseUrl is required".into());
    }
    let models = normalize_models(body.models.as_deref().unwrap_or(&[]))?;
    let api_key_env = env_for(&id);

    let mut saved = read(data_dir);
    let entry = CustomProvider {
        id: id.clone(),
        name,
        base_url,
        models,
        api_key_env: Some(api_key_env.clone()),
        context_window: body.context_window.filter(|&n| n > 0),
        max_tokens: body.max_tokens.filter(|&n| n > 0),
    };
    if let Some(i) = saved.iter().position(|p| p.id == id) {
        saved[i] = entry;
    } else {
        saved.push(entry);
    }
    write(data_dir, &saved).await?;

    if body.clear_key == Some(true) {
        pi_keys::set_env(data_dir, &api_key_env, "").await?;
    } else if let Some(key) = body.api_key.as_deref() {
        if !key.trim().is_empty() {
            pi_keys::set_env(data_dir, &api_key_env, key).await?;
        }
    }

    Ok(list(data_dir))
}

pub async fn remove(data_dir: &Path, id: &str) -> Result<Vec<CustomProviderStatus>, String> {
    let id = id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return Err("id is required".into());
    }
    let mut saved = read(data_dir);
    let Some(pos) = saved.iter().position(|p| p.id == id) else {
        return Err(format!("unknown custom provider {id}"));
    };
    let removed = saved.remove(pos);
    write(data_dir, &saved).await?;
    if let Some(env) = removed.api_key_env.as_deref().filter(|s| !s.is_empty()) {
        let _ = pi_keys::set_env(data_dir, env, "").await;
    } else {
        let _ = pi_keys::set_env(data_dir, &env_for(&id), "").await;
    }
    Ok(list(data_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn upserts_and_never_echoes_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let saved = upsert(
            dir.path(),
            CustomProviderUpsert {
                id: Some("ollama".into()),
                name: Some("Ollama".into()),
                base_url: Some("http://127.0.0.1:11434/v1".into()),
                models: Some(vec!["llama3.1".into(), " qwen ".into()]),
                api_key: Some(" sk-secret ".into()),
                clear_key: None,
                context_window: Some(64_000),
                max_tokens: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, "ollama");
        assert_eq!(saved[0].models, vec!["llama3.1", "qwen"]);
        assert_eq!(saved[0].key_source, "settings");
        assert_eq!(saved[0].api_key_env, "PI_CUSTOM_OLLAMA_API_KEY");
        let raw = serde_json::to_string(&saved).unwrap();
        assert!(!raw.contains("sk-secret"));
        assert!(std::fs::read_to_string(pi_keys::file(dir.path())).unwrap().contains("sk-secret"));
        remove(dir.path(), "ollama").await.unwrap();
        assert!(list(dir.path()).is_empty());
        assert_eq!(pi_keys::env_source(dir.path(), "PI_CUSTOM_OLLAMA_API_KEY"), "none");
    }

    #[tokio::test]
    async fn rejects_builtin_ids() {
        let dir = tempfile::tempdir().unwrap();
        let err = upsert(
            dir.path(),
            CustomProviderUpsert {
                id: Some("openai".into()),
                name: None,
                base_url: Some("http://localhost/v1".into()),
                models: Some(vec!["gpt".into()]),
                api_key: None,
                clear_key: None,
                context_window: None,
                max_tokens: None,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("reserved"));
    }
}
