use serde::Serialize;

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

pub async fn detect_agents() -> Vec<DetectedAgent> {
    vec![probe_pi().await]
}

async fn probe_pi() -> DetectedAgent {
    let url = format!("http://127.0.0.1:{}/health", crate::pi_sidecar::port());
    let up = reqwest::Client::new().get(url).timeout(std::time::Duration::from_secs(2)).send().await.is_ok_and(|r| r.status().is_success());
    let present = crate::pi_sidecar::script().is_some();
    DetectedAgent {
        id: "pi".into(),
        name: "Pi (durable)".into(),
        installed: present,
        version: Some("pi-durable 1.3.0".into()),
        supported: true,
        ready: Some(up),
        detail: Some(if up {
            "harness running".into()
        } else if present {
            "harness starting or stopped".into()
        } else {
            "harness/server.ts not found".into()
        }),
    }
}

pub async fn pi_models() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn detect_lists_only_pi() {
        let agents = detect_agents().await;
        assert_eq!(agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["pi"]);
        assert!(agents[0].supported);
    }
}
