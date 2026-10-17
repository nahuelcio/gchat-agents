use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct AdoAuth {
    pub org: String,
    pub pat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoProject {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoRepo {
    pub id: String,
    pub name: String,
    pub remote_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAdo {
    pub org: String,
    #[serde(skip_serializing)]
    pub pat: String,
    pub profile: String,
    pub projects: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_project: Option<String>,
}

pub fn ado_auth_header(pat: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!(":{pat}"));
    format!("Basic {encoded}")
}

pub async fn ado_projects(ado: &AdoAuth, client: &reqwest::Client) -> Result<Vec<AdoProject>, String> {
    let url = format!(
        "https://dev.azure.com/{}/_apis/projects?api-version=7.1&$top=500",
        ado.org
    );
    let body: serde_json::Value = get_json(client, &url, &ado_auth_header(&ado.pat)).await?;
    let values = body.get("value").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(values
        .into_iter()
        .filter_map(|v| {
            Some(AdoProject {
                id: v.get("id")?.as_str()?.to_string(),
                name: v.get("name")?.as_str()?.to_string(),
            })
        })
        .collect())
}

pub async fn ado_repos(
    ado: &AdoAuth,
    project: &str,
    client: &reqwest::Client,
) -> Result<Vec<AdoRepo>, String> {
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/git/repositories?api-version=7.1",
        ado.org,
        urlencoding(project)
    );
    let body: serde_json::Value = get_json(client, &url, &ado_auth_header(&ado.pat)).await?;
    let values = body.get("value").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(values
        .into_iter()
        .filter_map(|v| {
            let default_branch = v
                .get("defaultBranch")
                .and_then(|b| b.as_str())
                .map(|b| b.trim_start_matches("refs/heads/").to_string());
            Some(AdoRepo {
                id: v.get("id")?.as_str()?.to_string(),
                name: v.get("name")?.as_str()?.to_string(),
                remote_url: v.get("remoteUrl")?.as_str()?.to_string(),
                default_branch,
            })
        })
        .collect())
}

async fn get_json(client: &reqwest::Client, url: &str, auth: &str) -> Result<serde_json::Value, String> {
    let res = client
        .get(url)
        .header("authorization", auth)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let host = reqwest::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| "ado".into());
        return Err(format!("{host} answered {status}: {}", &text[..text.len().min(200)]));
    }
    res.json().await.map_err(|e| e.to_string())
}

fn urlencoding(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub async fn clone_repo(remote_url: &str, dest: &Path, pat: &str) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let header = format!("http.extraHeader=Authorization: {}", ado_auth_header(pat));
    let status = Command::new("git")
        .args(["-c", &header, "clone", "--quiet", remote_url])
        .arg(dest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("git clone failed with {:?}", status.code()));
    }
    let cfg = Command::new("git")
        .args([
            "-C",
            &dest.to_string_lossy(),
            "config",
            "http.extraHeader",
            &format!("Authorization: {}", ado_auth_header(pat)),
        ])
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if !cfg.success() {
        return Err("git config http.extraHeader failed".into());
    }
    Ok(())
}

#[derive(Deserialize)]
struct AdoCliConfig {
    #[serde(rename = "defaultProfile")]
    default_profile: Option<String>,
    profiles: Option<HashMap<String, AdoProfile>>,
}

#[derive(Deserialize)]
struct AdoProfile {
    org: Option<String>,
    project: Option<String>,
    pat: Option<String>,
    #[serde(rename = "patEnvVar")]
    pat_env_var: Option<String>,
    default: Option<bool>,
}

pub fn detect_ado(home: &Path, env: &HashMap<String, String>) -> Option<DetectedAdo> {
    let path = home.join(".config/opencode/ado.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let config: AdoCliConfig = serde_json::from_str(&raw).ok()?;
    let profiles = config.profiles.unwrap_or_default();
    let name = config
        .default_profile
        .filter(|n| profiles.contains_key(n))
        .or_else(|| {
            profiles
                .iter()
                .find(|(_, p)| p.default == Some(true))
                .map(|(k, _)| k.clone())
        })
        .or_else(|| profiles.keys().next().cloned())?;
    let profile = profiles.get(&name)?;
    let org = profile.org.clone()?;
    let file_pat = std::fs::read_to_string(home.join(".azure-devops-cli/pat"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let pat = profile
        .pat
        .clone()
        .or_else(|| {
            profile
                .pat_env_var
                .as_ref()
                .and_then(|k| env.get(k).cloned())
        })
        .or_else(|| env.get("AZURE_DEVOPS_PAT").cloned())
        .or(file_pat)?;
    let mut projects: Vec<String> = profiles
        .values()
        .filter(|p| p.org.as_deref() == Some(org.as_str()) && p.project.is_some())
        .filter_map(|p| p.project.clone())
        .collect();
    let set: HashSet<_> = projects.iter().cloned().collect();
    projects = set.into_iter().collect();
    projects.sort();
    Some(DetectedAdo {
        org,
        pat,
        profile: name,
        projects,
        default_project: profile.project.clone(),
    })
}

pub fn detect_ado_from_env() -> Option<DetectedAdo> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let env: HashMap<String, String> = std::env::vars().collect();
    detect_ado(&home, &env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn detects_ado_config() {
        let dir = tempdir().unwrap();
        let cfg = dir.path().join(".config/opencode");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join("ado.json"),
            r#"{"defaultProfile":"yoizen","profiles":{"yoizen":{"org":"myorg","project":"proj","pat":"secret"}}}"#,
        )
        .unwrap();
        let env = HashMap::new();
        let d = detect_ado(dir.path(), &env).unwrap();
        assert_eq!(d.org, "myorg");
        assert_eq!(d.pat, "secret");
        assert_eq!(d.default_project.as_deref(), Some("proj"));
        assert!(d.projects.contains(&"proj".to_string()));
    }

    #[test]
    fn auth_header_is_basic() {
        let h = ado_auth_header("pat");
        assert!(h.starts_with("Basic "));
    }
}
