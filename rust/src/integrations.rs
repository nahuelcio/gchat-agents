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
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAdo {
    org: String,
    pat: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_project: Option<String>,
}

pub fn ado_config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("ado.json")
}

pub fn env_ado_pat() -> Option<String> {
    std::env::var("AZURE_DEVOPS_PAT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn load_stored_ado(data_dir: &Path) -> Option<DetectedAdo> {
    let raw = std::fs::read_to_string(ado_config_path(data_dir)).ok()?;
    let stored: StoredAdo = serde_json::from_str(&raw).ok()?;
    let org = stored.org.trim().to_string();
    if org.is_empty() {
        return None;
    }
    let stored_pat = stored.pat.trim().to_string();
    let (pat, source) = if !stored_pat.is_empty() {
        (stored_pat, "settings")
    } else if let Some(p) = env_ado_pat() {
        (p, "env")
    } else {
        return None;
    };
    let default_project = stored
        .default_project
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some(DetectedAdo {
        org,
        pat,
        profile: "settings".into(),
        projects: default_project.iter().cloned().collect(),
        default_project,
        source: source.into(),
    })
}

pub async fn save_ado(data_dir: &Path, org: &str, pat: &str, default_project: Option<&str>) -> Result<DetectedAdo, String> {
    let org = org.trim();
    let pat = pat.trim();
    if org.is_empty() {
        return Err("organization is required".into());
    }
    if pat.is_empty() {
        return Err("PAT (personal access token) is required".into());
    }
    let default_project = default_project
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let stored = StoredAdo {
        org: org.into(),
        pat: pat.into(),
        default_project: default_project.clone(),
    };
    let raw = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    crate::atomic::write_atomic(&ado_config_path(data_dir), &raw)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(err) = sync_ado_cli_config(org, pat, default_project.as_deref()) {
        tracing::warn!("could not sync @cioffinahuel/opencode-ado CLI config: {err}");
    }
    Ok(DetectedAdo {
        org: org.into(),
        pat: pat.into(),
        profile: "settings".into(),
        projects: default_project.iter().cloned().collect(),
        default_project,
        source: "settings".into(),
    })
}

pub async fn clear_ado(data_dir: &Path) -> Result<(), String> {
    let path = ado_config_path(data_dir);
    if path.exists() {
        tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    }
    if let Err(err) = clear_ado_cli_switchboard_profile() {
        tracing::warn!("could not clear @cioffinahuel/opencode-ado CLI profile: {err}");
    }
    Ok(())
}

const SWITCHBOARD_ADO_PROFILE: &str = "switchboard";

fn ado_cli_home() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SWITCHBOARD_ADO_CLI_HOME") {
        let path = PathBuf::from(p);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn sync_ado_cli_config(org: &str, pat: &str, project: Option<&str>) -> Result<(), String> {
    let home = ado_cli_home().ok_or_else(|| "home directory not found".to_string())?;
    let cli_dir = home.join(".azure-devops-cli");
    std::fs::create_dir_all(&cli_dir).map_err(|e| e.to_string())?;
    std::fs::write(cli_dir.join("pat"), pat.trim()).map_err(|e| e.to_string())?;
    let _ = std::fs::write(cli_dir.join("active-profile"), SWITCHBOARD_ADO_PROFILE);

    let org_url = if org.starts_with("http://") || org.starts_with("https://") {
        org.trim_end_matches('/').to_string()
    } else {
        format!("https://dev.azure.com/{org}")
    };
    let profile = serde_json::json!({
        "org": org_url,
        "project": project.unwrap_or(""),
        "patEnvVar": "AZURE_DEVOPS_PAT",
        "repos": [],
        "default": true,
    });

    let oc_dir = home.join(".config").join("opencode");
    std::fs::create_dir_all(&oc_dir).map_err(|e| e.to_string())?;
    for path in [oc_dir.join("ado.json"), cli_dir.join("config.json")] {
        upsert_switchboard_ado_profile(&path, &profile)?;
    }
    Ok(())
}

fn upsert_switchboard_ado_profile(path: &Path, profile: &serde_json::Value) -> Result<(), String> {
    let mut value = if path.exists() {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !value.is_object() {
        value = serde_json::json!({});
    }
    if value.get("profiles").is_none() {
        if let Some(ado) = value.get("ado").cloned() {
            if ado.get("profiles").is_some() {
                value = ado;
            }
        }
    }
    let obj = value.as_object_mut().ok_or_else(|| "invalid ado config".to_string())?;
    let profiles = obj
        .entry("profiles")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "profiles must be an object".to_string())?;
    for p in profiles.values_mut() {
        if let Some(o) = p.as_object_mut() {
            o.insert("default".into(), serde_json::json!(false));
        }
    }
    profiles.insert(SWITCHBOARD_ADO_PROFILE.into(), profile.clone());
    obj.insert("defaultProfile".into(), serde_json::json!(SWITCHBOARD_ADO_PROFILE));
    let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_ado_cli_switchboard_profile() -> Result<(), String> {
    let Some(home) = ado_cli_home() else {
        return Ok(());
    };
    for path in [
        home.join(".azure-devops-cli").join("config.json"),
        home.join(".config").join("opencode").join("ado.json"),
    ] {
        if !path.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let was_default = value.get("defaultProfile").and_then(|d| d.as_str()) == Some(SWITCHBOARD_ADO_PROFILE);
        let Some(profiles) = value.get_mut("profiles").and_then(|p| p.as_object_mut()) else {
            continue;
        };
        profiles.remove(SWITCHBOARD_ADO_PROFILE);
        if profiles.is_empty() {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if was_default {
            let next = profiles.keys().next().cloned();
            match next {
                Some(name) => value["defaultProfile"] = serde_json::json!(name),
                None => {
                    value.as_object_mut().map(|o| o.remove("defaultProfile"));
                }
            }
        }
        let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn resolve_ado(data_dir: &Path) -> Option<DetectedAdo> {
    load_stored_ado(data_dir).or_else(detect_ado_from_env)
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
        source: "cli".into(),
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
    use std::sync::Mutex;
    use tempfile::tempdir;

    static ADO_CLI_HOME_LOCK: Mutex<()> = Mutex::new(());

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
        assert_eq!(d.source, "cli");
    }

    #[tokio::test]
    async fn stored_ado_beats_cli_and_mirrors_opencode_ado() {
        let _guard = ADO_CLI_HOME_LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        let cli_home = tempdir().unwrap();
        unsafe { std::env::set_var("SWITCHBOARD_ADO_CLI_HOME", cli_home.path()) };

        let oc = cli_home.path().join(".config/opencode");
        std::fs::create_dir_all(&oc).unwrap();
        std::fs::write(
            oc.join("ado.json"),
            r#"{"defaultProfile":"work","profiles":{"work":{"org":"https://dev.azure.com/keep","project":"K","patEnvVar":"AZURE_DEVOPS_PAT","default":true}}}"#,
        )
        .unwrap();

        save_ado(dir.path(), "from-ui", "ui-pat", Some("P1")).await.unwrap();
        let raw = std::fs::read_to_string(oc.join("ado.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v["profiles"]["work"].is_object());
        assert!(v["profiles"]["switchboard"].is_object());
        assert_eq!(v["defaultProfile"], "switchboard");
        assert_eq!(v["profiles"]["work"]["default"], false);
        assert!(raw.contains("dev.azure.com/from-ui"));
        assert_eq!(
            std::fs::read_to_string(cli_home.path().join(".azure-devops-cli/pat")).unwrap(),
            "ui-pat"
        );

        let resolved = resolve_ado(dir.path()).unwrap();
        assert_eq!(resolved.org, "from-ui");
        assert_eq!(resolved.pat, "ui-pat");
        assert_eq!(resolved.source, "settings");
        unsafe { std::env::remove_var("SWITCHBOARD_ADO_CLI_HOME") };
    }

    #[test]
    fn auth_header_is_basic() {
        let h = ado_auth_header("pat");
        assert!(h.starts_with("Basic "));
    }

    #[test]
    fn load_stored_reads_azure_devops_pat_env_when_pat_blank() {
        let _guard = ADO_CLI_HOME_LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        std::fs::write(
            ado_config_path(dir.path()),
            r#"{"org":"env-org","pat":"","defaultProject":"P"}"#,
        )
        .unwrap();
        unsafe { std::env::set_var("AZURE_DEVOPS_PAT", "from-env-pat") };
        let d = load_stored_ado(dir.path()).unwrap();
        assert_eq!(d.org, "env-org");
        assert_eq!(d.pat, "from-env-pat");
        assert_eq!(d.source, "env");
        unsafe { std::env::remove_var("AZURE_DEVOPS_PAT") };
    }
}
