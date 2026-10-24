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
        mcps_override: None,
        instructions_override: None,
        effort: None,
    }
}

#[tokio::test]
async fn pi_driver_talks_to_the_durable_harness() {
    let dir = tempdir().unwrap();
    let port = 18990;
    let mut child = tokio::process::Command::new(switchboard::driver::spawn::resolve_bin("node"))
        .args(["--experimental-transform-types", "--no-warnings", "harness/server.ts"])
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
    let slow = PiDriver { timeout_ms: 600, ..driver.clone() };
    let long = slow.run_turn(turn("SLEEP:3", second.session_ref.clone(), dir.path())).await.unwrap();
    assert_eq!(long.reply, "Slept 3s");
    assert_eq!(long.session_ref.as_deref(), Some(conversation.as_str()));
    child.kill().await.ok();
    let down = driver.run_turn(turn("hola", None, dir.path())).await.err();
    assert_eq!(down.as_deref(), Some("the Pi harness is not running"));
}

#[tokio::test]
async fn a_restart_resumes_pi_turns_without_empty_or_duplicate_replies() {
    let dir = tempdir().unwrap();
    let port = 18991;
    std::env::set_var("PI_PORT", port.to_string());
    let mut child = tokio::process::Command::new(switchboard::driver::spawn::resolve_bin("node"))
        .args(["--experimental-transform-types", "--no-warnings", "harness/server.ts"])
        .current_dir("..")
        .env("DATA_DIR", dir.path().join("pi"))
        .env("PI_PORT", port.to_string())
        .env("PI_FAUX", "1")
        .env("PI_MODEL", "faux/echo")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if reqwest::get(format!("http://127.0.0.1:{port}/health")).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let config = switchboard::config::Config {
        port: 0,
        token_audience: Some("http://test/google/chat".into()),
        tunnel: Some(switchboard::tunnel::TunnelMode::Off),
        service_account_json: None,
        allowed_spaces: vec![],
        agent_driver: switchboard::config::AgentDriverKind::Pi,
        workdir: dir.path().join("ws"),
        turn_timeout_ms: 30_000,
        data_dir: dir.path().join("data"),
        repos: Default::default(),
        admin_port: 0,
        skip_token_verify: true,
    };
    let state = switchboard::build_runtime(config, false).unwrap().state;
    state
        .settings
        .update(switchboard::settings::SettingsPatch {
            agent_driver: Some(switchboard::config::AgentDriverKind::Pi),
            personas: Some(vec![serde_json::from_value(serde_json::json!({ "name": "finanzas", "prompt": "F", "driver": "pi" })).unwrap()]),
            ..Default::default()
        })
        .await
        .unwrap();
    let ledger = state.handler.ledger.clone().unwrap();
    use switchboard::turn_ledger::TurnState;
    ledger.begin("cut-before-pi", "share/r1", "team-chat", None).await;
    ledger.remember_prompt("cut-before-pi", "Ana: hola pi").await;
    ledger.set("cut-before-pi", TurnState::Running).await;
    ledger.begin("already-posted", "share/r3", "team-chat", None).await;
    ledger.set("already-posted", TurnState::Posted).await;
    ledger.begin_persona("room#finanzas#0", "share/r2", "finanzas", "team-chat", None, "cierre de marzo").await;
    let resumed = switchboard::turn_ledger::recover(state.handler.clone(), ledger.clone(), state.transcripts.clone()).await;
    assert_eq!(resumed, 2);
    for _ in 0..100 {
        if ledger.state("cut-before-pi") == Some(TurnState::Posted) && ledger.state("room#finanzas#0") == Some(TurnState::Posted) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let host = state.transcripts.get("share/r1");
    assert_eq!(host.len(), 1);
    assert_eq!(host[0].text, "Echo: Ana: hola pi");
    let room = state.transcripts.get("share/r2");
    assert_eq!(room[0].text, "*@finanzas*\nEcho: cierre de marzo");
    assert!(state.transcripts.get("share/r3").is_empty());
    let sessions = state.handler.store.get("share/r2").unwrap().persona_sessions.unwrap();
    assert!(sessions.contains_key("finanzas"));
    child.kill().await.ok();
}

#[tokio::test]
async fn a_steer_joins_the_running_turn_and_compact_and_reset_keep_the_conversation() {
    use switchboard::driver::types::SteerResult;
    let dir = tempdir().unwrap();
    let port = 18992;
    let mut child = tokio::process::Command::new(switchboard::driver::spawn::resolve_bin("node"))
        .args(["--experimental-transform-types", "--no-warnings", "harness/server.ts"])
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
    let driver = PiDriver { base_url: base, model: None, settings: None, timeout_ms: 30_000, retry_ms: 0 };
    let first = driver.run_turn(turn("hola", None, dir.path())).await.unwrap();
    let conversation = first.session_ref.clone().unwrap();
    assert!(driver.steer("share/pi1", &conversation, "idle-steer", "nadie corre").await.unwrap().is_none());
    let steer_during = |text: &'static str, id: &'static str| {
        let driver = driver.clone();
        let session = first.session_ref.clone();
        let workdir = dir.path().to_path_buf();
        let conversation = conversation.clone();
        async move {
            let running = {
                let driver = driver.clone();
                tokio::spawn(async move { driver.run_turn(turn(text, session, &workdir)).await })
            };
            tokio::time::sleep(Duration::from_millis(700)).await;
            let steer = driver.steer("share/pi1", &conversation, id, "usá pnpm").await.unwrap();
            let shape = match steer {
                None => "idle".to_string(),
                Some(SteerResult::Joined) => "joined".into(),
                Some(SteerResult::Answered(r)) => format!("answered {}", r.reply),
            };
            (shape, running.await.unwrap().unwrap().reply)
        }
    };
    let (shape, reply) = steer_during("BASH:node -e \"setTimeout(()=>{},2000)\"", "steer-1").await;
    assert_eq!((shape.as_str(), reply.as_str()), ("joined", "Echo: usá pnpm"));
    let (shape, reply) = steer_during("SLEEP:2", "steer-2").await;
    assert_eq!((shape.as_str(), reply.as_str()), ("answered Echo: usá pnpm", "Slept 2s"));
    assert!(driver.compact(&conversation).await.unwrap().is_ok());
    assert_eq!(driver.reset(&conversation).await, Some(Ok(())));
    let after = driver.run_turn(turn("de nuevo", Some(conversation.clone()), dir.path())).await.unwrap();
    assert_eq!(after.session_ref.as_deref(), Some(conversation.as_str()));
    assert_eq!(after.reply, "Echo: de nuevo");
    child.kill().await.ok();
    drop(child);
    let restarted = tokio::process::Command::new(switchboard::driver::spawn::resolve_bin("node"))
        .args(["--experimental-transform-types", "--no-warnings", "harness/server.ts"])
        .current_dir("..")
        .env("DATA_DIR", dir.path())
        .env("PI_PORT", port.to_string())
        .env("PI_FAUX", "1")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if reqwest::get(format!("http://127.0.0.1:{port}/health")).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!dir.path().join("harness-threads.json").exists());
    let again = driver.wait("steer-1").await.unwrap();
    assert!(again.is_some());
    drop(restarted);
}
