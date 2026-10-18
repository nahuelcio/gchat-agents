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
    tokio::spawn(async move {
        loop {
            let started = std::time::Instant::now();
            let child = Command::new(crate::driver::spawn::resolve_bin("node"))
                .args(["--experimental-strip-types", "--no-warnings", &script.to_string_lossy()])
                .current_dir(&root)
                .env("DATA_DIR", &data_dir)
                .env("PI_PORT", port().to_string())
                .env("SWITCHBOARD_ADMIN_URL", format!("http://127.0.0.1:{admin_port}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .kill_on_drop(true)
                .spawn();
            match child {
                Ok(mut child) => {
                    tracing::info!("Pi harness started on 127.0.0.1:{}", port());
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
