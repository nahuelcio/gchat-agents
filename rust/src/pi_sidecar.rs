use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

pub fn port() -> u16 {
    std::env::var("PI_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8090)
}

pub fn script() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("harness/server.ts"),
        PathBuf::from("../harness/server.ts"),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("../../../harness/server.ts")))
            .unwrap_or_default(),
    ];
    candidates.into_iter().find(|p| p.is_file()).and_then(|p| absolute(&p))
}

fn absolute(path: &Path) -> Option<PathBuf> {
    let full = std::fs::canonicalize(path).ok()?;
    Some(PathBuf::from(full.to_string_lossy().trim_start_matches(r"\\?\").to_string()))
}

pub fn spawn(data_dir: &Path, admin_port: u16) {
    if std::env::var("PI_HARNESS").as_deref() == Ok("off") {
        return;
    }
    let Some(script) = script() else {
        tracing::info!("Pi harness not found (harness/server.ts); the pi driver is unavailable");
        return;
    };
    let root = script.parent().and_then(|p| p.parent()).map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let data_dir = absolute(data_dir).unwrap_or_else(|| data_dir.to_path_buf());
    let bin_dir = root.join("node_modules").join(".bin");
    let path_with_bins = {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let mut joined = bin_dir.into_os_string();
        if !existing.is_empty() {
            joined.push(sep);
            joined.push(existing);
        }
        joined
    };
    tokio::spawn(async move {
        loop {
            let started = std::time::Instant::now();
            let mut cmd = Command::new(crate::driver::spawn::resolve_bin("node"));
            cmd.args(["--experimental-transform-types", "--no-warnings", &script.to_string_lossy()])
                .current_dir(&root)
                .env("DATA_DIR", &data_dir)
                .env("PI_PORT", port().to_string())
                .env("SWITCHBOARD_ADMIN_URL", format!("http://127.0.0.1:{admin_port}"))
                .env("PI_PARENT_PIPE", "1")
                .env("SWITCHBOARD_BIN", std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "switchboard".into()))
                .env("PATH", &path_with_bins);
            let env_has_pat = std::env::var("AZURE_DEVOPS_PAT")
                .ok()
                .is_some_and(|s| !s.trim().is_empty());
            if !env_has_pat {
                if let Some(pat) = crate::integrations::resolve_ado(&data_dir).map(|a| a.pat) {
                    cmd.env("AZURE_DEVOPS_PAT", pat);
                }
            }
            let child = cmd
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .kill_on_drop(true)
                .spawn();
            match child {
                Ok(mut child) => {
                    tracing::info!("Pi harness started on 127.0.0.1:{}", port());
                    let _parent_pipe = child.stdin.take();
                    let status = child.wait().await;
                    tracing::warn!(?status, "Pi harness exited; restarting");
                }
                Err(err) => {
                    tracing::warn!(%err, "could not start the Pi harness (is Node 22.19+ installed?)");
                    return;
                }
            }
            if started.elapsed() < Duration::from_secs(5) {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    });
}

pub async fn call(method: reqwest::Method, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let mut req = reqwest::Client::new().request(method, format!("http://127.0.0.1:{}{path}", port())).timeout(Duration::from_secs(600));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|_| "the Pi harness is not running".to_string())?;
    let ok = res.status().is_success();
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if ok {
        Ok(v)
    } else {
        Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("harness error").to_string())
    }
}

/// Aborts the sidecar runs of a thread key; `<thread>#<Agent>` aborts only that agent.
pub async fn abort(thread_key: &str) {
    let _ = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/abort", port()))
        .json(&serde_json::json!({ "thread": thread_key }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
}

pub fn reload() {
    tokio::spawn(async {
        let _ = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{}/reload", port()))
            .timeout(Duration::from_secs(30))
            .send()
            .await;
    });
}
