use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

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
    let mut child = Command::new(&bin)
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
