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
        name: "Pi".into(),
        installed: present,
        version: Some(pi_durable_version()),
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

fn pi_durable_version() -> String {
    let Some(script) = crate::pi_sidecar::script() else {
        return "pi-durable".into();
    };
    let Some(root) = script.parent().and_then(|dir| dir.parent()) else {
        return "pi-durable".into();
    };
    let pkg = root.join("node_modules/@earendil-works/pi-durable/package.json");
    let Ok(text) = std::fs::read_to_string(pkg) else {
        return "pi-durable".into();
    };
    package_version(&text).map(|version| format!("pi-durable {version}")).unwrap_or_else(|| "pi-durable".into())
}

fn package_version(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let version = value.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

pub async fn pi_models() -> Vec<String> {
    Vec::new()
}

/// Custom OpenAI-compatible models as `provider/model` chips for Settings.
pub fn custom_pi_models(data_dir: &std::path::Path) -> Vec<String> {
    crate::pi_custom_providers::list(data_dir)
        .into_iter()
        .flat_map(|p| p.models.into_iter().map(move |m| format!("{}/{}", p.id, m)))
        .collect()
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

    #[test]
    fn package_version_reads_the_installed_pin() {
        assert_eq!(package_version(r#"{"name":"@earendil-works/pi-durable","version":"1.4.0"}"#).as_deref(), Some("1.4.0"));
        assert_eq!(package_version("{}"), None);
    }
}
