use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelMode {
    #[default]
    Auto,
    Opentunnel,
    Cloudflared,
    Off,
}

impl TunnelMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto" | "on" => Some(Self::Auto),
            "opentunnel" => Some(Self::Opentunnel),
            "cloudflared" => Some(Self::Cloudflared),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

pub async fn open_tunnel(mode: TunnelMode, port: u16, data_dir: &Path) -> Result<Option<String>, String> {
    match mode {
        TunnelMode::Off => Ok(None),
        TunnelMode::Opentunnel => ensure_tunnel(port).await.map(Some),
        TunnelMode::Cloudflared => cloudflared(port, data_dir).await.map(Some),
        TunnelMode::Auto if cfg!(windows) => cloudflared(port, data_dir).await.map(Some),
        TunnelMode::Auto => match ensure_tunnel(port).await {
            Ok(url) => Ok(Some(url)),
            Err(err) => {
                tracing::warn!("{err}; trying cloudflared");
                cloudflared(port, data_dir).await.map(Some)
            }
        },
    }
}

async fn cloudflared(port: u16, data_dir: &Path) -> Result<String, String> {
    let bin = cloudflared_bin(data_dir).await?;
    let mut child = Command::new(&bin)
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start cloudflared: {e}"))?;
    let mut lines = BufReader::new(child.stderr.take().ok_or("missing stderr")?).lines();
    let re = regex::Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").unwrap();
    let url = timeout(Duration::from_secs(60), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(m) = re.find(&line) {
                return Some(m.as_str().to_string());
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
    .ok_or("cloudflared returned no public URL")?;
    tokio::spawn(async move {
        while let Ok(Some(_)) = lines.next_line().await {}
        let _ = child.wait().await;
        tracing::warn!("cloudflared exited; the public URL is gone until restart");
    });
    Ok(url)
}

async fn cloudflared_bin(data_dir: &Path) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
    if let Some(found) = on_path(name) {
        return Ok(found);
    }
    let local = data_dir.join("bin").join(name);
    if local.is_file() {
        return Ok(local);
    }
    let asset = cloudflared_asset().ok_or("cloudflared is not installed: brew install cloudflared")?;
    tracing::info!("downloading cloudflared…");
    let bytes = reqwest::get(format!("https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}"))
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("cloudflared download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("cloudflared download failed: {e}"))?;
    tokio::fs::create_dir_all(local.parent().unwrap()).await.map_err(|e| e.to_string())?;
    tokio::fs::write(&local, &bytes).await.map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(local)
}

fn cloudflared_asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("cloudflared-windows-amd64.exe"),
        ("windows", "aarch64") => Some("cloudflared-windows-arm64.exe"),
        ("linux", "x86_64") => Some("cloudflared-linux-amd64"),
        ("linux", "aarch64") => Some("cloudflared-linux-arm64"),
        _ => None,
    }
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(name)).find(|p| p.is_file())
}

#[derive(Debug)]
pub struct RunError {
    pub message: String,
    pub not_found: bool,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub async fn default_run(bin: String, args: Vec<String>) -> Result<String, RunError> {
    let mut child = Command::new(crate::driver::spawn::resolve_bin(&bin))
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| RunError {
            not_found: e.kind() == std::io::ErrorKind::NotFound,
            message: e.to_string(),
        })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let read = async {
        let (out, err) = tokio::join!(
            async {
                let mut buf = Vec::new();
                let _ = stdout.read_to_end(&mut buf).await;
                buf
            },
            async {
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf).await;
                buf
            }
        );
        let status = child.wait().await.map_err(|e| RunError {
            message: e.to_string(),
            not_found: false,
        })?;
        let mut text = String::from_utf8_lossy(&out).into_owned();
        text.push_str(&String::from_utf8_lossy(&err));
        if status.success() {
            Ok(text)
        } else {
            Err(RunError {
                message: format!("exit code {:?}\n{}", status.code(), &text[..text.len().min(500)]),
                not_found: false,
            })
        }
    };
    match timeout(Duration::from_secs(60), read).await {
        Ok(r) => r,
        Err(_) => {
            let _ = child.start_kill();
            Err(RunError {
                message: "opentunnel did not answer in 60 s".into(),
                not_found: false,
            })
        }
    }
}

pub async fn ensure_tunnel(port: u16) -> Result<String, String> {
    ensure_tunnel_with(port, default_run).await
}

pub async fn ensure_tunnel_with<F, Fut>(port: u16, run: F) -> Result<String, String>
where
    F: Fn(String, Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, RunError>>,
{
    let out = match run("opentunnel".into(), vec!["route".into(), "add".into(), port.to_string()]).await {
        Ok(o) => o,
        Err(err) if err.not_found => {
            return Err(
                "opentunnel is not installed: npm i -g opentunnel (or set TUNNEL=off and GOOGLE_TOKEN_AUDIENCE)"
                    .into(),
            );
        }
        Err(err) => return Err(format!("opentunnel failed: {err}")),
    };
    let re = regex::Regex::new(r"(?i)https://[a-z0-9.-]+\.opentunnel\.xyz").unwrap();
    re.find(&out)
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| format!("opentunnel returned no public URL:\n{}", &out[..out.len().min(500)]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modes() {
        assert_eq!(TunnelMode::parse("on"), Some(TunnelMode::Auto));
        assert_eq!(TunnelMode::parse("Cloudflared"), Some(TunnelMode::Cloudflared));
        assert_eq!(TunnelMode::parse("off"), Some(TunnelMode::Off));
        assert_eq!(TunnelMode::parse("nope"), None);
    }

    #[tokio::test]
    async fn off_opens_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(open_tunnel(TunnelMode::Off, 8080, dir.path()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn parses_url() {
        let url = ensure_tunnel_with(8080, |_bin, args| async move {
            assert_eq!(args, vec!["route", "add", "8080"]);
            Ok("Tunnel ready\nhttps://abc.opentunnel.xyz\n".into())
        })
        .await
        .unwrap();
        assert_eq!(url, "https://abc.opentunnel.xyz");
    }

    #[tokio::test]
    async fn missing_binary() {
        let err = ensure_tunnel_with(8080, |_b, _a| async {
            Err(RunError {
                message: "enoent".into(),
                not_found: true,
            })
        })
        .await
        .unwrap_err();
        assert!(err.contains("npm i -g opentunnel"));
    }
}
