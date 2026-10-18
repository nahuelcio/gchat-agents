pub mod activity;
pub mod admin;
pub mod agents;
pub mod atomic;
pub mod cli;
pub mod bridge;
pub mod config;
pub mod driver;
pub mod google;
pub mod google_drive;
pub mod handler;
pub mod health;
pub mod integrations;
pub mod mcp;
pub mod mcp_client;
pub mod media;
pub mod personas;
pub mod pi_keys;
pub mod pi_sidecar;
pub mod question_gate;
pub mod questions;
pub mod queue;
pub mod schedules;
pub mod session;
pub mod settings;
pub mod share;
pub mod skill_install;
pub mod skills;
pub mod state;
pub mod static_files;
pub mod team;
pub mod text;
pub mod transcripts;
pub mod turn_ledger;
pub mod tunnel;
pub mod verify;
pub mod workspace;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use tokio::sync::Mutex;

use crate::config::{load_config, Config};
use crate::driver::{ClaudeDriver, EchoDriver, OpenCodeDriver};
use crate::google::GoogleConnection;
use crate::handler::{settings_to_options, HandlerConfig, HandlerDeps};
use crate::health::Health;
use crate::mcp::SwitchboardMcp;
use crate::queue::TurnQueue;
use crate::schedules::{ScheduleStore, Scheduler};
use crate::session::SessionStore;
use crate::settings::{SettingsDefaults, SettingsStore};
use crate::share::ShareToken;
use crate::state::AppState;
use crate::transcripts::TranscriptStore;
use crate::verify::{AcceptAllVerifier, GoogleTokenVerifier};
use crate::workspace::Workspaces;

pub struct Runtime {
    pub state: Arc<AppState>,
    pub config: Config,
}

pub fn build_runtime(mut config: Config, echo: bool) -> Result<Runtime, String> {
    std::fs::create_dir_all(&config.data_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config.workdir).map_err(|e| e.to_string())?;
    crate::skills::set_dirs(vec![config.data_dir.join("skills"), PathBuf::from("skills")]);

    let settings = Arc::new(SettingsStore::open(
        config.data_dir.join("config.json"),
        SettingsDefaults {
            agent_driver: config.agent_driver,
            models: crate::settings::Models {
                opencode: config.opencode_model.clone(),
                claude: config.claude_model.clone(),
                pi: std::env::var("PI_MODEL").ok().filter(|m| !m.trim().is_empty()),
            },
            agents: Default::default(),
            repos: config.repos.clone(),
            allowed_spaces: config.allowed_spaces.clone(),
            ..Default::default()
        },
    ));

    let health = Arc::new(Mutex::new(Health::from_env(config.data_dir.join("health.json"))));
    let schedules = Arc::new(ScheduleStore::open(config.data_dir.join("schedules.json")));
    let workspaces = Arc::new(Workspaces::new(
        config.data_dir.join("worktrees"),
        settings.get().repos.clone(),
    ));
    let transcripts = Arc::new(TranscriptStore::open(config.data_dir.join("transcripts"), 500));
    let share = Arc::new(Mutex::new(ShareToken::open(config.data_dir.join("share-token"))));
    let google = Arc::new(GoogleConnection::open(
        config.data_dir.join("google-sa.json"),
        config.service_account_json.as_deref(),
    ));
    let store = Arc::new(SessionStore::open(config.data_dir.join("sessions.json")));
    let queue = Arc::new(TurnQueue::new());
    let media = Arc::new(crate::media::MediaStore::open(config.data_dir.join("media")));
    let activity = Arc::new(crate::activity::ActivityLog::open(config.data_dir.join("activity.json")));

    let switchboard = SwitchboardMcp {
        server_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "switchboard".into()),
        admin_url: format!("http://127.0.0.1:{}", config.admin_port),
    };

    let driver: Arc<dyn crate::driver::AgentDriver> = if echo {
        Arc::new(EchoDriver)
    } else {
        Arc::new(crate::driver::ConfiguredDriver {
            opencode: OpenCodeDriver {
                bin: config.opencode_bin.clone(),
                model: None,
                agent: None,
                timeout_ms: config.turn_timeout_ms,
                switchboard: Some(switchboard.clone()),
                engram: false,
            },
            claude: ClaudeDriver {
                bin: config.claude_bin.clone(),
                model: None,
                timeout_ms: config.turn_timeout_ms,
                switchboard: Some(switchboard.clone()),
                read_dirs: vec![config.data_dir.join("media").to_string_lossy().into_owned()],
                engram: false,
            },
            pi: crate::driver::PiDriver {
                base_url: format!("http://127.0.0.1:{}", crate::pi_sidecar::port()),
                model: None,
                settings: None,
                timeout_ms: config.turn_timeout_ms,
                retry_ms: 60_000,
            },
            settings: settings.clone(),
        })
    };

    if config.token_audience.is_none() {
        config.token_audience = Some(format!("http://127.0.0.1:{}/google/chat", config.port));
    }

    let verifier: Arc<dyn crate::verify::TokenVerifier> = if config.skip_token_verify {
        Arc::new(AcceptAllVerifier)
    } else {
        let audience = config
            .token_audience
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{}/google/chat", config.port));
        Arc::new(GoogleTokenVerifier::new(audience))
    };

    let settings_for_opts = settings.clone();
    let handler = Arc::new(HandlerDeps {
        verifier,
        driver: driver.clone(),
        chat: google.clone(),
        store,
        queue,
        config: std::sync::Mutex::new(HandlerConfig {
            allowed_spaces: settings.get().allowed_spaces.clone(),
            workdir: config.workdir.to_string_lossy().to_string(),
        }),
        workspaces: Some(workspaces.clone()),
        activity: Some(activity.clone()),
        scheduler: std::sync::OnceLock::new(),
        ledger: Some(Arc::new(crate::turn_ledger::TurnLedger::open(config.data_dir.join("turns.json")))),
        options: Arc::new(move || settings_to_options(&settings_for_opts.get())),
        media: Some(media.clone()),
    });

    {
        let handler = handler.clone();
        let workspaces = workspaces.clone();
        let servers = std::sync::Mutex::new(settings.get().mcp_servers);
        settings.on_change(Arc::new(move |s| {
            handler.config.lock().unwrap().allowed_spaces = s.allowed_spaces.clone();
            workspaces.set_repos(s.repos.clone());
            let mut known = servers.lock().unwrap();
            if *known != s.mcp_servers {
                *known = s.mcp_servers.clone();
                if tokio::runtime::Handle::try_current().is_ok() {
                    crate::pi_sidecar::reload();
                }
            }
        }));
    }

    let activity_for_run = activity.clone();
    let transcripts_for_run = transcripts.clone();
    let schedules_for_run = schedules.clone();
    let driver_for_run = driver;
    let workdir = config.workdir.to_string_lossy().to_string();
    let scheduler = Arc::new(Scheduler::new(schedules.clone(), move |job| {
        let driver = driver_for_run.clone();
        let workdir = workdir.clone();
        let store = schedules_for_run.clone();
        let activity = activity_for_run.clone();
        let transcripts = transcripts_for_run.clone();
        let (key, name, prompt) = (format!("schedule/{}", job.id), job.name.clone(), job.prompt.clone());
        async move {
            let _ = store;
            let result = driver
                .run_turn(crate::driver::types::AgentTurnInput {
                    thread_key: format!("schedule/{}", job.id),
                    session_ref: None,
                    text: job.prompt,
                    workdir,
                    model: None,
                    agent: None,
                    driver: None,
                    answer_questions: false,
                    request_id: None,
                })
                .await;
            let reply = match &result {
                Ok(out) => out.reply.clone(),
                Err(err) => format!("Failed: {err}"),
            };
            let entry = |author: &str, text: String, bot: bool| crate::transcripts::TranscriptMessage { author: author.into(), text, bot, at: None, questions: None, attachments: None };
            let _ = transcripts.append(&key, vec![entry("schedule", prompt, false), entry(crate::personas::BOT_NAME, reply, true)]).await;
            match result {
                Ok(_) => {
                    activity.record("schedule_ok", &key, name, "").await;
                    true
                }
                Err(err) => {
                    tracing::error!(%err, "scheduled job failed");
                    activity.record("schedule_fail", &key, name, err).await;
                    false
                }
            }
        }
        .boxed()
    }).with_activity(activity.clone()));
    let _ = handler.scheduler.set(scheduler.clone());

    let web_dir = find_web_dir();
    let state = Arc::new(AppState {
        drive: Arc::new(crate::google_drive::Drive::new(google.clone())),
        activity,
        settings,
        health,
        schedules,
        scheduler,
        share,
        transcripts,
        workspaces,
        handler,
        google,
        media,
        web_dir,
        public_url: std::sync::Mutex::new(None),
        data_dir: config.data_dir.clone(),
        opencode_bin: config.opencode_bin.clone(),
        claude_bin: config.claude_bin.clone(),
    });

    Ok(Runtime { state, config })
}

fn find_web_dir() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("web/dist"),
        PathBuf::from("../web/dist"),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("../web/dist")))
            .unwrap_or_else(|| PathBuf::from("web/dist")),
    ];
    candidates.into_iter().find(|p| p.join("index.html").exists())
}

pub async fn prepare_runtime(echo: bool) -> Result<Runtime, String> {
    let mut config = load_config()?;
    let mode = config.tunnel.unwrap_or_else(|| {
        SettingsStore::open(config.data_dir.join("config.json"), Default::default()).get().tunnel
    });
    let fixed_audience = config.token_audience.is_some();
    if config.token_audience.is_none() {
        config.token_audience = Some(format!("http://127.0.0.1:{}/google/chat", config.port));
        if !config.skip_token_verify {
            tracing::warn!(
                "GOOGLE_TOKEN_AUDIENCE not set; using loopback audience until the tunnel is up"
            );
        }
    }
    let runtime = build_runtime(config, echo)?;
    let state = runtime.state.clone();
    state.settings.ensure_default_engram().await;
    if let Some(ledger) = state.handler.ledger.clone() {
        let cut = crate::turn_ledger::recover(state.handler.clone(), ledger, state.transcripts.clone()).await;
        if cut > 0 {
            tracing::warn!("{cut} turn(s) were unfinished at the last restart: resumed on Pi, announced as cut otherwise");
        }
    }
    let (port, data_dir) = (runtime.config.port, runtime.config.data_dir.clone());
    tokio::spawn(async move {
        match crate::tunnel::open_tunnel(mode, port, &data_dir).await {
            Ok(Some(url)) => {
                tracing::info!("public endpoint: {url}/google/chat");
                if !fixed_audience {
                    state.handler.verifier.set_audience(format!("{url}/google/chat"));
                }
                *state.public_url.lock().unwrap() = Some(url);
            }
            Ok(None) => {}
            Err(err) => tracing::warn!("tunnel unavailable: {err}"),
        }
    });
    Ok(runtime)
}

pub async fn serve(runtime: Runtime) -> Result<(), String> {
    let state = runtime.state.clone();
    let config = runtime.config;
    crate::pi_sidecar::spawn(&config.data_dir, config.admin_port);

    let health = state.health.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            health.lock().await.beat(std::time::SystemTime::now());
        }
    });

    let scheduler = state.scheduler.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            scheduler.tick(chrono::Local::now()).await;
        }
    });

    let bridge = crate::bridge::bridge_router(state.clone());
    let admin = crate::admin::admin_router(state.clone());

    let bridge_addr = std::net::SocketAddr::from(([0, 0, 0, 0], config.port));
    let admin_addr = std::net::SocketAddr::from(([127, 0, 0, 1], config.admin_port));

    let bridge_listener = tokio::net::TcpListener::bind(bridge_addr)
        .await
        .map_err(|e| e.to_string())?;
    let admin_listener = tokio::net::TcpListener::bind(admin_addr)
        .await
        .map_err(|e| e.to_string())?;

    tracing::info!("Switchboard listening on :{}", config.port);
    tracing::info!("control plane: http://127.0.0.1:{}", config.admin_port);

    let bridge_serve = axum::serve(bridge_listener, bridge);
    let admin_serve = axum::serve(admin_listener, admin);

    tokio::select! {
        r = bridge_serve => r.map_err(|e| e.to_string())?,
        r = admin_serve => r.map_err(|e| e.to_string())?,
    }
    Ok(())
}

pub fn load_runtime_from_env(echo: bool) -> Result<Runtime, String> {
    let config = load_config()?;
    build_runtime(config, echo)
}

pub async fn load_runtime_from_env_async(echo: bool) -> Result<Runtime, String> {
    prepare_runtime(echo).await
}
