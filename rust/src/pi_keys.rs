use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::atomic::write_atomic;

/// Built-in Pi providers that resolve via a single API-key env var.
/// Kept in sync with `@earendil-works/pi-ai` `getApiKeyEnvVars` (pi-ai 1.4.0).
/// OpenAI-compatible custom endpoints (Ollama, vLLM, …) are not listed here —
/// they need `createProvider` with a base URL in the harness, not just a key.
pub const PROVIDERS: &[(&str, &str, &str)] = &[
    ("zai", "Z.AI (GLM coding plan)", "ZAI_API_KEY"),
    ("zai-coding-cn", "Z.AI Coding Plan (China)", "ZAI_CODING_CN_API_KEY"),
    ("anthropic", "Anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OpenAI", "OPENAI_API_KEY"),
    ("azure", "Azure OpenAI", "AZURE_OPENAI_API_KEY"),
    ("deepseek", "DeepSeek", "DEEPSEEK_API_KEY"),
    ("nvidia", "NVIDIA NIM", "NVIDIA_API_KEY"),
    ("google", "Google Gemini", "GEMINI_API_KEY"),
    ("google-vertex", "Google Vertex AI", "GOOGLE_CLOUD_API_KEY"),
    ("openrouter", "OpenRouter", "OPENROUTER_API_KEY"),
    ("groq", "Groq", "GROQ_API_KEY"),
    ("cerebras", "Cerebras", "CEREBRAS_API_KEY"),
    ("mistral", "Mistral", "MISTRAL_API_KEY"),
    ("xai", "xAI", "XAI_API_KEY"),
    ("fireworks", "Fireworks", "FIREWORKS_API_KEY"),
    ("together", "Together AI", "TOGETHER_API_KEY"),
    ("baseten", "Baseten", "BASETEN_API_KEY"),
    ("huggingface", "Hugging Face", "HF_TOKEN"),
    ("minimax", "MiniMax", "MINIMAX_API_KEY"),
    ("minimax-cn", "MiniMax (China)", "MINIMAX_CN_API_KEY"),
    ("moonshotai", "Moonshot AI", "MOONSHOT_API_KEY"),
    ("moonshotai-cn", "Moonshot AI (China)", "MOONSHOT_API_KEY"),
    ("kimi-coding", "Kimi For Coding", "KIMI_API_KEY"),
    ("meta", "Meta", "META_API_KEY"),
    ("opencode", "OpenCode Zen", "OPENCODE_API_KEY"),
    ("opencode-go", "OpenCode Go", "OPENCODE_API_KEY"),
    ("vercel-ai-gateway", "Vercel AI Gateway", "AI_GATEWAY_API_KEY"),
    ("cloudflare-workers-ai", "Cloudflare Workers AI", "CLOUDFLARE_API_KEY"),
    ("cloudflare-ai-gateway", "Cloudflare AI Gateway", "CLOUDFLARE_API_KEY"),
    ("ant-ling", "Ant Ling", "ANT_LING_API_KEY"),
    ("radius", "Radius", "RADIUS_API_KEY"),
    ("typesafe", "TypeSafe", "TYPESAFE_API_KEY"),
    ("qwen-token-plan", "Qwen Token Plan", "QWEN_TOKEN_PLAN_API_KEY"),
    ("qwen-token-plan-individual", "Qwen Token Plan (Individual)", "QWEN_TOKEN_PLAN_API_KEY"),
    ("qwen-token-plan-cn", "Qwen Token Plan (China)", "QWEN_TOKEN_PLAN_CN_API_KEY"),
    ("xiaomi", "Xiaomi MiMo", "XIAOMI_API_KEY"),
    ("xiaomi-token-plan-cn", "Xiaomi MiMo Token Plan (China)", "XIAOMI_TOKEN_PLAN_CN_API_KEY"),
    ("xiaomi-token-plan-ams", "Xiaomi MiMo Token Plan (Amsterdam)", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"),
    ("xiaomi-token-plan-sgp", "Xiaomi MiMo Token Plan (Singapore)", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"),
    ("github-copilot", "GitHub Copilot", "COPILOT_GITHUB_TOKEN"),
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
    PROVIDERS
        .iter()
        .map(|(provider, label, env_var)| ProviderKey {
            provider,
            label,
            env_var,
            source: env_source(data_dir, env_var),
        })
        .collect()
}

pub fn env_source(data_dir: &Path, env_var: &str) -> &'static str {
    let saved = read(data_dir);
    if saved.contains_key(env_var) {
        "settings"
    } else if std::env::var(env_var).is_ok_and(|v| !v.trim().is_empty()) {
        "env"
    } else {
        "none"
    }
}

pub async fn set_env(data_dir: &Path, env_var: &str, key: &str) -> Result<(), String> {
    if env_var.is_empty() || !env_var.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
        return Err(format!("invalid env var {env_var}"));
    }
    let mut saved = read(data_dir);
    match key.trim() {
        "" => {
            saved.remove(env_var);
        }
        k => {
            saved.insert(env_var.to_string(), k.to_string());
        }
    };
    let body = serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?;
    write_atomic(&file(data_dir), &body).await.map_err(|e| e.to_string())
}

pub async fn set(data_dir: &Path, provider: &str, key: &str) -> Result<(), String> {
    let env_var = PROVIDERS.iter().find(|(p, _, _)| *p == provider).map(|(_, _, v)| *v).ok_or_else(|| format!("unknown provider {provider}"))?;
    set_env(data_dir, env_var, key).await
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

    #[test]
    fn lists_every_pi_api_key_provider() {
        let ids: Vec<_> = PROVIDERS.iter().map(|(id, _, _)| *id).collect();
        for id in ["openai", "azure", "fireworks", "together", "kimi-coding", "github-copilot", "qwen-token-plan"] {
            assert!(ids.contains(&id), "missing provider {id}");
        }
        assert!(PROVIDERS.len() >= 35);
        assert!(!ids.contains(&"ollama"), "custom OpenAI-compatible endpoints are not API-key providers");
    }
}
