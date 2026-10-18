use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::atomic::write_atomic;

pub const PROVIDERS: &[(&str, &str, &str)] = &[
    ("zai", "Z.AI (GLM coding plan)", "ZAI_API_KEY"),
    ("anthropic", "Anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OpenAI", "OPENAI_API_KEY"),
    ("deepseek", "DeepSeek", "DEEPSEEK_API_KEY"),
    ("openrouter", "OpenRouter", "OPENROUTER_API_KEY"),
    ("google", "Google Gemini", "GEMINI_API_KEY"),
    ("groq", "Groq", "GROQ_API_KEY"),
    ("mistral", "Mistral", "MISTRAL_API_KEY"),
    ("xai", "xAI", "XAI_API_KEY"),
];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKey {
    pub provider: &'static str,
    pub label: &'static str,
    pub env_var: &'static str,
    pub source: &'static str,
}

pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("pi-keys.json")
}

fn read(data_dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(file(data_dir)).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

pub fn status(data_dir: &Path) -> Vec<ProviderKey> {
    let saved = read(data_dir);
    PROVIDERS
        .iter()
        .map(|(provider, label, env_var)| ProviderKey {
            provider,
            label,
            env_var,
            source: if saved.contains_key(*env_var) {
                "settings"
            } else if std::env::var(env_var).is_ok_and(|v| !v.trim().is_empty()) {
                "env"
            } else {
                "none"
            },
        })
        .collect()
}

pub async fn set(data_dir: &Path, provider: &str, key: &str) -> Result<(), String> {
    let env_var = PROVIDERS.iter().find(|(p, _, _)| *p == provider).map(|(_, _, v)| *v).ok_or_else(|| format!("unknown provider {provider}"))?;
    let mut saved = read(data_dir);
    match key.trim() {
        "" => saved.remove(env_var),
        k => saved.insert(env_var.to_string(), k.to_string()),
    };
    let body = serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?;
    write_atomic(&file(data_dir), &body).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn keys_are_saved_by_provider_and_never_listed() {
        let dir = tempfile::tempdir().unwrap();
        set(dir.path(), "zai", " zk-123 ").await.unwrap();
        let zai = status(dir.path()).into_iter().find(|p| p.provider == "zai").unwrap();
        assert_eq!(zai.source, "settings");
        assert!(!serde_json::to_string(&status(dir.path())).unwrap().contains("zk-123"));
        assert!(std::fs::read_to_string(file(dir.path())).unwrap().contains("\"ZAI_API_KEY\": \"zk-123\""));
        set(dir.path(), "zai", "").await.unwrap();
        assert_eq!(status(dir.path()).into_iter().find(|p| p.provider == "zai").unwrap().source, "none");
        assert!(set(dir.path(), "nope", "x").await.is_err());
    }
}
