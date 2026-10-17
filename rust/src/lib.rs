pub mod admin;
pub mod agents;
pub mod atomic;
pub mod bridge;
pub mod config;
pub mod driver;
pub mod google;
pub mod handler;
pub mod health;
pub mod integrations;
pub mod mcp;
pub mod media;
pub mod personas;
pub mod question_gate;
pub mod questions;
pub mod queue;
pub mod schedules;
pub mod session;
pub mod settings;
pub mod share;
pub mod state;
pub mod static_files;
pub mod team;
pub mod text;
pub mod transcripts;
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

    let settings = Arc::new(SettingsStore::open(
        config.data_dir.join("config.json"),
        SettingsDefaults {
            agent_driver: config.agent_driver,
            models: crate::settings::Models {
                opencode: config.opencode_model.clone(),
                claude: config.claude_model.clone(),
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

    let switchboard = SwitchboardMcp {
        server_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "switchboard".into()),
        admin_url: format!("http://127.0.0.1:{}", config.admin_port),
    };

    let driver: Arc<dyn crate::driver::AgentDriver> = if echo {
        Arc::new(EchoDriver)
    } else {
        match settings.get().agent_driver {
            crate::config::AgentDriverKind::Opencode => Arc::new(OpenCodeDriver {
                bin: config.opencode_bin.clone(),
                model: settings.get().models.opencode.clone(),
                agent: settings.get().agents.opencode.clone(),
                timeout_ms: config.turn_timeout_ms,
                switchboard: Some(switchboard.clone()),
            }),
            crate::config::AgentDriverKind::Claude => Arc::new(ClaudeDriver {
                bin: config.claude_bin.clone(),
                model: settings.get().models.claude.clone(),
                timeout_ms: config.turn_timeout_ms,
                switchboard: Some(switchboard.clone()),
                read_dirs: vec![config.data_dir.join("media").to_string_lossy().into_owned()],
            }),
        }
    };

    if config.token_audience.is_none() && !config.tunnel {
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
        options: Arc::new(move || settings_to_options(&settings_for_opts.get())),
        media: Some(media.clone()),
    });

    {
        let handler = handler.clone();
        let workspaces = workspaces.clone();
        settings.on_change(Arc::new(move |s| {
            handler.config.lock().unwrap().allowed_spaces = s.allowed_spaces.clone();
            workspaces.set_repos(s.repos.clone());
        }));
    }

    let schedules_for_run = schedules.clone();
    let driver_for_run = driver;
    let workdir = config.workdir.to_string_lossy().to_string();
    let scheduler = Arc::new(Scheduler::new(schedules.clone(), move |job| {
        let driver = driver_for_run.clone();
        let workdir = workdir.clone();
        let store = schedules_for_run.clone();
        async move {
            let _ = store;
            match driver
                .run_turn(crate::driver::types::AgentTurnInput {
                    thread_key: format!("schedule/{}", job.id),
                    session_ref: None,
                    text: job.prompt,
                    workdir,
                    model: None,
                    agent: None,
                    driver: None,
                    answer_questions: false,
                })
                .await
            {
                Ok(_) => true,
                Err(err) => {
                    tracing::error!(%err, "scheduled job failed");
                    false
                }
            }
        }
        .boxed()
    }));

    let web_dir = find_web_dir();
    let state = Arc::new(AppState {
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
    let public_url = if config.tunnel {
        tracing::info!("connecting tunnel (opentunnel)…");
        let url = crate::tunnel::ensure_tunnel(config.port).await?;
        tracing::info!("public endpoint: {url}/google/chat");
        if config.token_audience.is_none() {
            config.token_audience = Some(format!("{url}/google/chat"));
        }
        Some(url)
    } else {
        None
    };
    if config.token_audience.is_none() {
        config.token_audience = Some(format!("http://127.0.0.1:{}/google/chat", config.port));
        if !config.skip_token_verify {
            tracing::warn!(
                "GOOGLE_TOKEN_AUDIENCE not set with TUNNEL=off; using loopback audience"
            );
        }
    }
    let runtime = build_runtime(config, echo)?;
    *runtime.state.public_url.lock().unwrap() = public_url;
    Ok(runtime)
}

pub async fn serve(runtime: Runtime) -> Result<(), String> {
    let state = runtime.state.clone();
    let config = runtime.config;

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
