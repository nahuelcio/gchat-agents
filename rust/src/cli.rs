use serde_json::{json, Value};

pub const VERBS: &[&str] = &[
    "health",
    "threads",
    "activity",
    "search",
    "thread get",
    "thread send",
    "thread repo",
    "members add",
    "members remove",
    "schedules list",
    "schedules add",
    "schedules run",
    "schedules delete",
    "approvals list",
    "approvals decide",
    "repos",
];

#[derive(Debug, PartialEq)]
pub struct Call {
    pub method: &'static str,
    pub path: String,
    pub body: Option<Value>,
}

struct Args<'a> {
    words: Vec<&'a str>,
    flags: Vec<(&'a str, Option<&'a str>)>,
}

impl<'a> Args<'a> {
    fn parse(raw: &'a [String]) -> Self {
        let (mut words, mut flags) = (Vec::new(), Vec::new());
        let mut it = raw.iter().map(String::as_str).peekable();
        while let Some(a) = it.next() {
            match a.strip_prefix("--") {
                Some(name) => {
                    let value = it.next_if(|v| !v.starts_with("--"));
                    flags.push((name, value));
                }
                None => words.push(a),
            }
        }
        Self { words, flags }
    }

    fn flag(&self, name: &str) -> Option<&'a str> {
        self.flags.iter().find(|(n, _)| *n == name).and_then(|(_, v)| *v)
    }

    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(n, _)| *n == name)
    }

    fn need(&self, name: &str) -> Result<&'a str, String> {
        self.flag(name).ok_or_else(|| format!("--{name} is required"))
    }
}

pub fn enc(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn plan(raw: &[String], stdin: Option<Value>) -> Result<Call, String> {
    let a = Args::parse(raw);
    let rest = a.words.get(2..).unwrap_or_default().join(" ");
    let get = |path: String| Ok(Call { method: "GET", path, body: None });
    let post = |path: &str, body: Value| Ok(Call { method: "POST", path: path.into(), body: Some(body) });
    let thread = || a.need("thread");
    match (a.words.first().copied(), a.words.get(1).copied()) {
        (Some("health"), _) => get("/api/health".into()),
        (Some("threads"), _) => get("/api/threads".into()),
        (Some("repos"), _) => get("/api/thread/repos".into()),
        (Some("activity"), _) => {
            let mut path = format!("/api/activity?limit={}", a.flag("limit").unwrap_or("50"));
            if let Some(kind) = a.flag("kind") {
                path.push_str(&format!("&kind={}", enc(kind)));
            }
            get(path)
        }
        (Some("search"), _) => get(format!("/api/search?q={}", enc(a.need("q")?))),
        (Some("thread"), Some("get")) => get(format!("/api/team/thread?thread={}", enc(thread()?))),
        (Some("thread"), Some("send")) => {
            let mut body = stdin.filter(|_| a.has("stdin")).unwrap_or_else(|| json!({ "text": rest, "name": a.flag("name").unwrap_or("cli") }));
            body["thread"] = json!(thread()?);
            if body["text"].as_str().is_none_or(|t| t.trim().is_empty()) {
                return Err("text is required (arguments or --stdin {\"text\":...})".into());
            }
            post("/api/team/send", body)
        }
        (Some("thread"), Some("repo")) => {
            if rest.trim().is_empty() {
                return Err("repo names are required".into());
            }
            post("/api/team/send", json!({ "thread": thread()?, "name": "cli", "text": format!("/repo {rest}") }))
        }
        (Some("members"), Some(op @ ("add" | "remove"))) => {
            let member = match (a.flag("agent"), a.flag("human")) {
                (Some(p), _) => json!({ "kind": "agent", "persona": p }),
                (None, Some(n)) => json!({ "kind": "human", "name": n }),
                _ => return Err("--agent or --human is required".into()),
            };
            post("/api/team/members", json!({ "thread": thread()?, "op": op, "member": member }))
        }
        (Some("schedules"), Some("list")) => get("/api/schedules".into()),
        (Some("schedules"), Some("add")) => post("/api/schedules", stdin.ok_or("schedules add reads the job JSON from --stdin")?),
        (Some("schedules"), Some(op @ ("run" | "delete"))) => post(&format!("/api/schedules/{op}"), json!({ "id": a.need("id")? })),
        (Some("approvals"), Some("list")) => get("/api/approvals".into()),
        (Some("approvals"), Some("decide")) => {
            let approve = match (a.has("approve"), a.has("deny")) {
                (true, false) => true,
                (false, true) => false,
                _ => return Err("pass exactly one of --approve or --deny".into()),
            };
            post("/api/approvals/decide", json!({ "id": a.need("id")?, "approve": approve }))
        }
        (Some(verb), sub) => Err(format!("unknown verb: {}", [Some(verb), sub].into_iter().flatten().collect::<Vec<_>>().join(" "))),
        (None, _) => Err("no verb".into()),
    }
}

pub fn admin_url() -> String {
    std::env::var("SWITCHBOARD_ADMIN_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", std::env::var("ADMIN_PORT").unwrap_or_else(|_| "8081".into())))
        .trim_end_matches('/')
        .to_string()
}

pub async fn send(base: &str, call: Call) -> Result<Value, String> {
    let url = format!("{base}{}", call.path);
    let host = url.split('/').nth(2).unwrap_or("127.0.0.1").to_string();
    let client = reqwest::Client::new();
    let req = match call.method {
        "GET" => client.get(&url),
        _ => client.post(&url).json(&call.body.unwrap_or(Value::Null)),
    };
    let res = req.header("host", host).send().await.map_err(|_| "control plane is not running".to_string())?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(body["error"].as_str().map(String::from).unwrap_or_else(|| format!("HTTP {status}")))
    }
}

pub async fn run(raw: &[String]) -> i32 {
    if raw.is_empty() {
        println!("{}", json!({ "verbs": VERBS }));
        return 0;
    }
    let stdin = if raw.iter().any(|a| a == "--stdin") {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut text);
        match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("{}", json!({ "error": format!("stdin is not JSON: {e}") }));
                return 1;
            }
        }
    } else {
        None
    };
    let result = match plan(raw, stdin) {
        Ok(call) => send(&admin_url(), call).await,
        Err(e) => Err(e),
    };
    match result {
        Ok(v) => {
            println!("{v}");
            0
        }
        Err(e) => {
            eprintln!("{}", json!({ "error": e }));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn maps_verbs_to_admin_calls() {
        assert_eq!(plan(&args("activity --limit 5 --kind turn_fail"), None).unwrap().path, "/api/activity?limit=5&kind=turn_fail");
        assert_eq!(plan(&args("search --q token"), None).unwrap().path, "/api/search?q=token");
        assert_eq!(plan(&["search".into(), "--q".into(), "token de meta".into()], None).unwrap().path, "/api/search?q=token%20de%20meta");
        let send = plan(&args("thread send --thread t1 hola equipo"), None).unwrap();
        assert_eq!((send.method, send.path.as_str()), ("POST", "/api/team/send"));
        assert_eq!(send.body.unwrap(), json!({ "thread": "t1", "text": "hola equipo", "name": "cli" }));
        let decide = plan(&args("approvals decide --id ab12 --deny"), None).unwrap();
        assert_eq!(decide.body.unwrap(), json!({ "id": "ab12", "approve": false }));
        let piped = plan(&args("thread send --thread t1 --stdin"), Some(json!({ "text": "desde stdin", "name": "bot" }))).unwrap();
        assert_eq!(piped.body.unwrap()["text"], "desde stdin");
        assert_eq!(plan(&args("members add --thread t1 --agent qa"), None).unwrap().body.unwrap()["member"], json!({ "kind": "agent", "persona": "qa" }));
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(plan(&args("bogus"), None).unwrap_err(), "unknown verb: bogus");
        assert_eq!(plan(&args("thread get"), None).unwrap_err(), "--thread is required");
        assert!(plan(&args("approvals decide --id x"), None).is_err());
        assert!(plan(&args("thread send --thread t1"), None).is_err());
    }
}
