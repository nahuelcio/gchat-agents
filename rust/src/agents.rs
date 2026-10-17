use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub id: String,
    pub name: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub async fn detect_agents(opencode_bin: &str, claude_bin: &str) -> Vec<DetectedAgent> {
    vec![
        probe("opencode", "OpenCode", opencode_bin).await,
        probe("claude", "Claude Code", claude_bin).await,
    ]
}

async fn probe(id: &str, name: &str, bin: &str) -> DetectedAgent {
    let output = Command::new(bin).arg("--version").output().await;
    match output {
        Ok(out) if out.status.success() => DetectedAgent {
            id: id.into(),
            name: name.into(),
            installed: true,
            version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            supported: true,
            ready: Some(true),
            detail: None,
        },
        _ => DetectedAgent {
            id: id.into(),
            name: name.into(),
            installed: false,
            version: None,
            supported: true,
            ready: Some(false),
            detail: Some(format!("{bin} not found")),
        },
    }
}

pub async fn opencode_models(bin: &str) -> Vec<String> {
    let output = Command::new(bin).args(["models"]).output().await;
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

pub async fn opencode_agents(bin: &str) -> Vec<String> {
    let output = Command::new(bin).args(["agent", "list"]).output().await;
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

pub async fn claude_models(_bin: &str) -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn detect_returns_two() {
        let agents = detect_agents("opencode-missing-bin", "claude-missing-bin").await;
        assert_eq!(agents.len(), 2);
        assert!(!agents[0].installed);
    }
}
