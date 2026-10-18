use std::time::Duration;

use switchboard::driver::types::{AgentDriver, AgentTurnInput};
use switchboard::driver::PiDriver;
use tempfile::tempdir;

fn turn(text: &str, session: Option<String>, workdir: &std::path::Path) -> AgentTurnInput {
    AgentTurnInput {
        thread_key: "share/pi1".into(),
        session_ref: session,
        text: text.into(),
        workdir: workdir.to_string_lossy().into_owned(),
        model: None,
        agent: None,
        driver: None,
        answer_questions: false,
        request_id: None,
    }
}

#[tokio::test]
async fn pi_driver_talks_to_the_durable_harness() {
    let dir = tempdir().unwrap();
    let port = 18990;
    let mut child = tokio::process::Command::new(switchboard::driver::spawn::resolve_bin("node"))
        .args(["--experimental-strip-types", "--no-warnings", "harness/server.ts"])
        .current_dir("..")
        .env("DATA_DIR", dir.path())
        .env("PI_PORT", port.to_string())
        .env("PI_FAUX", "1")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    for _ in 0..100 {
        if reqwest::get(format!("{base}/health")).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    std::fs::write(dir.path().join("nota.txt"), "dato durable").unwrap();
    let driver = PiDriver { base_url: base, model: None, settings: None, timeout_ms: 30_000, retry_ms: 0 };
    let first = driver.run_turn(turn("hola pi", None, dir.path())).await.unwrap();
    assert_eq!(first.reply, "Echo: hola pi");
    let conversation = first.session_ref.clone().unwrap();
    let second = driver.run_turn(turn("READ:nota.txt", first.session_ref, dir.path())).await.unwrap();
    assert_eq!(second.session_ref.as_deref(), Some(conversation.as_str()));
    assert!(second.reply.contains("dato durable"), "{}", second.reply);
    child.kill().await.ok();
    let down = driver.run_turn(turn("hola", None, dir.path())).await.err();
    assert_eq!(down.as_deref(), Some("the Pi harness is not running"));
}
