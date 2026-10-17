use switchboard::{load_runtime_from_env_async, serve};

fn load_dotenv() {
    let Ok(raw) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

#[tokio::main]
async fn main() {
    load_dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("json") {
        std::process::exit(switchboard::cli::run(&args[2..]).await);
    }
    if args.iter().any(|a| a == "mcp") {
        if let Err(err) = switchboard::mcp::serve_stdio().await {
            eprintln!("mcp error: {err}");
            std::process::exit(1);
        }
        return;
    }

    let echo = args.windows(2).any(|w| w[0] == "--driver" && w[1] == "echo");
    if echo {
        std::env::set_var("SWITCHBOARD_SKIP_VERIFY", "1");
        std::env::set_var("TUNNEL", "off");
    }

    let runtime = match load_runtime_from_env_async(echo).await {
        Ok(r) => r,
        Err(err) => {
            eprintln!("failed to start: {err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = serve(runtime).await {
        eprintln!("server error: {err}");
        std::process::exit(1);
    }
}
