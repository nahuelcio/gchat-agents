use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

pub const ENDPOINT: &str = "https://drivemcp.googleapis.com/mcp/v1";
pub const CALENDAR_ENDPOINT: &str = "https://calendarmcp.googleapis.com/mcp/v1";
pub const GMAIL_ENDPOINT: &str = "https://gmailmcp.googleapis.com/mcp/v1";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPES: &str =
    "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const CALENDAR_SCOPES: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.events";
const GMAIL_SCOPES: &str =
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const PROTOCOL: &str = "2025-03-26";

#[derive(Debug, Clone, Copy)]
pub enum GoogleMcpKind {
    Drive,
    Calendar,
    Gmail,
}

impl GoogleMcpKind {
    fn file(self) -> &'static str {
        match self {
            Self::Drive => "drive-mcp.json",
            Self::Calendar => "calendar-mcp.json",
            Self::Gmail => "gmail-mcp.json",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Drive => ENDPOINT,
            Self::Calendar => CALENDAR_ENDPOINT,
            Self::Gmail => GMAIL_ENDPOINT,
        }
    }

    fn scopes(self) -> &'static str {
        match self {
            Self::Drive => DRIVE_SCOPES,
            Self::Calendar => CALENDAR_SCOPES,
            Self::Gmail => GMAIL_SCOPES,
        }
    }

    pub fn callback_path(self) -> &'static str {
        match self {
            Self::Drive => "/api/google/drive-mcp/callback",
            Self::Calendar => "/api/google/calendar-mcp/callback",
            Self::Gmail => "/api/google/gmail-mcp/callback",
        }
    }

    pub fn group(self) -> &'static str {
        match self {
            Self::Drive => "google-drive",
            Self::Calendar => "google-calendar",
            Self::Gmail => "google-gmail",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveMcpStatus {
    pub configured: bool,
    pub connected: bool,
    pub client_id: Option<String>,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Creds {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    #[serde(default)]
    refresh_token: String,
}

struct Pending {
    redirect: String,
    at: SystemTime,
}

struct Access {
    token: String,
    expires: SystemTime,
}

struct Live {
    creds: Creds,
    pending: HashMap<String, Pending>,
    access: Option<Access>,
    session: Option<String>,
    tools: Vec<Value>,
    tools_at: Option<SystemTime>,
    next: u64,
}

pub struct DriveMcp {
    http: reqwest::Client,
    file: PathBuf,
    kind: GoogleMcpKind,
    endpoint: String,
    scopes: String,
    auth_url: String,
    token_url: String,
    inner: Mutex<Live>,
}

impl DriveMcp {
    pub fn open(dir: &Path) -> Self {
        Self::open_kind(dir, GoogleMcpKind::Drive)
    }

    pub fn open_calendar(dir: &Path) -> Self {
        Self::open_kind(dir, GoogleMcpKind::Calendar)
    }

    pub fn open_gmail(dir: &Path) -> Self {
        Self::open_kind(dir, GoogleMcpKind::Gmail)
    }

    pub fn open_kind(dir: &Path, kind: GoogleMcpKind) -> Self {
        Self::with_endpoints(dir, kind, kind.endpoint(), AUTH_URL, TOKEN_URL)
    }

    pub fn kind(&self) -> GoogleMcpKind {
        self.kind
    }

    pub fn with_endpoints(dir: &Path, kind: GoogleMcpKind, endpoint: &str, auth_url: &str, token_url: &str) -> Self {
        let file = dir.join(kind.file());
        let creds = std::fs::read_to_string(&file).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
        Self {
            http: reqwest::Client::new(),
            file,
            kind,
            endpoint: endpoint.into(),
            scopes: kind.scopes().into(),
            auth_url: auth_url.into(),
            token_url: token_url.into(),
            inner: Mutex::new(Live { creds, pending: HashMap::new(), access: None, session: None, tools: Vec::new(), tools_at: None, next: 1 }),
        }
    }

    pub async fn status(&self, redirect_uri: &str) -> DriveMcpStatus {
        let live = self.inner.lock().await;
        DriveMcpStatus {
            configured: !live.creds.client_id.is_empty() && !live.creds.client_secret.is_empty(),
            connected: !live.creds.refresh_token.is_empty(),
            client_id: if live.creds.client_id.is_empty() { None } else { Some(live.creds.client_id.clone()) },
            redirect_uri: redirect_uri.into(),
        }
    }

    pub async fn set_client(&self, client_id: &str, client_secret: &str) -> Result<DriveMcpStatus, String> {
        let client_id = client_id.trim();
        if client_id.is_empty() {
            return Err("client id is required".into());
        }
        let mut live = self.inner.lock().await;
        let secret = client_secret.trim();
        let secret = if secret.is_empty() { live.creds.client_secret.clone() } else { secret.to_string() };
        if secret.is_empty() {
            return Err("client secret is required".into());
        }
        if live.creds.client_id != client_id {
            live.creds.refresh_token.clear();
            live.access = None;
            live.session = None;
            live.tools.clear();
            live.tools_at = None;
        }
        live.creds.client_id = client_id.into();
        live.creds.client_secret = secret;
        persist(&self.file, &live)?;
        Ok(status_of(&live, ""))
    }

    pub async fn clear(&self) -> Result<(), String> {
        let mut live = self.inner.lock().await;
        live.creds = Creds::default();
        live.access = None;
        live.session = None;
        live.tools.clear();
        live.pending.clear();
        tokio::fs::remove_file(&self.file).await.ok();
        Ok(())
    }

    pub async fn start_url(&self, redirect: &str) -> Result<String, String> {
        let mut live = self.inner.lock().await;
        if live.creds.client_id.is_empty() || live.creds.client_secret.is_empty() {
            return Err("save the OAuth client id and secret first".into());
        }
        let state = uuid::Uuid::new_v4().simple().to_string();
        live.pending.retain(|_, p| p.at.elapsed().unwrap_or_default() < Duration::from_secs(600));
        live.pending.insert(state.clone(), Pending { redirect: redirect.into(), at: SystemTime::now() });
        let url = format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={state}",
            self.auth_url,
            urlencoding(&live.creds.client_id),
            urlencoding(redirect),
            urlencoding(&self.scopes),
        );
        Ok(url)
    }

    pub async fn exchange(&self, code: &str, state: &str) -> Result<(), String> {
        let (redirect, id, secret) = {
            let mut live = self.inner.lock().await;
            let pending = live.pending.remove(state).ok_or("that sign-in expired; start it again from Settings")?;
            if pending.at.elapsed().unwrap_or_default() > Duration::from_secs(600) {
                return Err("that sign-in expired; start it again from Settings".into());
            }
            (pending.redirect, live.creds.client_id.clone(), live.creds.client_secret.clone())
        };
        let token = token_request(&self.http, &self.token_url, &[("code", code), ("client_id", &id), ("client_secret", &secret), ("redirect_uri", &redirect), ("grant_type", "authorization_code")]).await?;
        let refresh = token.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if refresh.is_empty() {
            return Err("Google did not return a refresh token; remove the app's access and connect again".into());
        }
        let mut live = self.inner.lock().await;
        live.creds.refresh_token = refresh;
        live.access = access_from(&token);
        live.session = None;
        live.tools.clear();
        persist(&self.file, &live)?;
        Ok(())
    }

    pub async fn tools(&self) -> Result<Vec<Value>, String> {
        let mut live = self.inner.lock().await;
        if live.creds.refresh_token.is_empty() {
            return Ok(Vec::new());
        }
        if live.tools_at.and_then(|t| t.elapsed().ok()).is_some_and(|e| e < Duration::from_secs(300)) && !live.tools.is_empty() {
            return Ok(live.tools.clone());
        }
        refresh_tools(&self.http, &self.endpoint, &self.token_url, &mut live).await?;
        Ok(live.tools.clone())
    }

    pub async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        let mut live = self.inner.lock().await;
        if live.creds.refresh_token.is_empty() {
            return Err(format!("unknown tool: {name}"));
        }
        let known = live.tools.iter().any(|t| t["name"].as_str() == Some(name));
        let fresh = live.tools_at.and_then(|t| t.elapsed().ok()).is_some_and(|e| e < Duration::from_secs(300));
        if !known {
            if fresh && !live.tools.is_empty() {
                return Err(format!("unknown tool: {name}"));
            }
            refresh_tools(&self.http, &self.endpoint, &self.token_url, &mut live).await?;
            if !live.tools.iter().any(|t| t["name"].as_str() == Some(name)) {
                return Err(format!("unknown tool: {name}"));
            }
        }
        let token = access(&self.http, &self.token_url, &mut live).await?;
        let session = live.session.clone();
        let id = live.next;
        live.next += 1;
        let result = rpc(&self.http, &self.endpoint, &token, session.as_deref(), "tools/call", json!({ "name": name, "arguments": args }), Some(id)).await;
        match result {
            Ok((session, result)) => {
                if let Some(session) = session {
                    live.session = Some(session);
                }
                Ok(result)
            }
            Err(err) => {
                live.session = None;
                Err(err)
            }
        }
    }

}

async fn refresh_tools(http: &reqwest::Client, endpoint: &str, token_url: &str, live: &mut Live) -> Result<(), String> {
    let token = access(http, token_url, live).await?;
    let id = live.next;
    live.next += 1;
    let (session, listed) = rpc(http, endpoint, &token, live.session.as_deref(), "tools/list", json!({}), Some(id)).await?;
    if let Some(session) = session {
        live.session = Some(session);
    }
    live.tools = listed.get("tools").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    live.tools_at = Some(SystemTime::now());
    Ok(())
}

async fn access(http: &reqwest::Client, token_url: &str, live: &mut Live) -> Result<String, String> {
    if let Some(access) = &live.access {
        if access.expires > SystemTime::now() + Duration::from_secs(60) {
            return Ok(access.token.clone());
        }
    }
    let token = token_request(http, token_url, &[("refresh_token", live.creds.refresh_token.as_str()), ("client_id", live.creds.client_id.as_str()), ("client_secret", live.creds.client_secret.as_str()), ("grant_type", "refresh_token")]).await?;
    let access = access_from(&token).ok_or("Google did not return an access token")?;
    let bearer = access.token.clone();
    live.access = Some(access);
    Ok(bearer)
}

async fn rpc(http: &reqwest::Client, endpoint: &str, token: &str, session: Option<&str>, method: &str, params: Value, id: Option<u64>) -> Result<(Option<String>, Value), String> {
    if session.is_none() && method != "initialize" {
        let (session, _) = Box::pin(rpc(http, endpoint, token, None, "initialize", json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "switchboard", "version": "0.1.0" } }), Some(0))).await?;
        let session = session.ok_or("Drive MCP did not start a session")?;
        let _ = Box::pin(rpc(http, endpoint, token, Some(&session), "notifications/initialized", json!({}), None)).await;
        return Box::pin(rpc(http, endpoint, token, Some(&session), method, params, id)).await;
    }
    let mut body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    if let Some(id) = id {
        body["id"] = json!(id);
    }
    let mut req = http
        .post(endpoint)
        .bearer_auth(token)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", PROTOCOL)
        .body(body.to_string())
        .timeout(Duration::from_secs(60));
    if let Some(session) = session {
        req = req.header("mcp-session-id", session);
    }
    let res = req.send().await.map_err(|e| format!("Drive MCP: {e}"))?;
    let new_session = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_string).or_else(|| session.map(str::to_string));
    let status = res.status();
    let kind = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Drive MCP {status}: {}", &text[..text.len().min(300)]));
    }
    if id.is_none() {
        return Ok((new_session, Value::Null));
    }
    let msg = if kind.contains("text/event-stream") { sse_message(&text, id.unwrap())? } else { serde_json::from_str(&text).map_err(|e| e.to_string())? };
    if let Some(err) = msg.get("error") {
        return Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("Drive MCP error").to_string());
    }
    Ok((new_session, msg.get("result").cloned().unwrap_or(Value::Null)))
}

async fn token_request(http: &reqwest::Client, token_url: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
    let body = fields.iter().map(|(k, v)| format!("{k}={}", urlencoding(v))).collect::<Vec<_>>().join("&");
    let res = http.post(token_url).header("content-type", "application/x-www-form-urlencoded").body(body).timeout(Duration::from_secs(30)).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Google token {status}: {}", &text[..text.len().min(300)]));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn persist(file: &Path, live: &Live) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(&live.creds).map_err(|e| e.to_string())?;
    crate::atomic::write_atomic_sync(file, &raw).map_err(|e| e.to_string())
}

fn status_of(live: &Live, redirect_uri: &str) -> DriveMcpStatus {
    DriveMcpStatus {
        configured: !live.creds.client_id.is_empty() && !live.creds.client_secret.is_empty(),
        connected: !live.creds.refresh_token.is_empty(),
        client_id: if live.creds.client_id.is_empty() { None } else { Some(live.creds.client_id.clone()) },
        redirect_uri: redirect_uri.into(),
    }
}

fn access_from(token: &Value) -> Option<Access> {
    let bearer = token.get("access_token")?.as_str()?.to_string();
    let secs = token.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    Some(Access { token: bearer, expires: SystemTime::now() + Duration::from_secs(secs) })
}

fn urlencoding(raw: &str) -> String {
    let mut out = String::new();
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn sse_message(body: &str, id: u64) -> Result<Value, String> {
    for block in body.split("\n\n") {
        let mut data = String::new();
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.trim_start());
            }
        }
        if data.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&data) else { continue };
        if msg.get("id").and_then(|v| v.as_u64()) == Some(id) {
            return Ok(msg);
        }
    }
    Err("Drive MCP stream had no result".into())
}

pub fn redirect_uri(host: &str) -> String {
    redirect_uri_for(host, GoogleMcpKind::Drive)
}

pub fn redirect_uri_for(host: &str, kind: GoogleMcpKind) -> String {
    format!("http://{host}{}", kind.callback_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::routing::post;
    use axum::{Json, Router};
    use std::sync::Arc;

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
    }

    async fn token() -> Json<Value> {
        Json(json!({ "access_token": "tok", "expires_in": 3600, "refresh_token": "ref" }))
    }

    async fn mcp(State(fake): State<Arc<Fake>>, headers: axum::http::HeaderMap, body: String) -> axum::response::Response {
        use axum::response::IntoResponse;
        let msg: Value = serde_json::from_str(&body).unwrap_or(json!({}));
        let method = msg["method"].as_str().unwrap_or("");
        fake.calls.lock().await.push(method.into());
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer tok") {
            return (axum::http::StatusCode::UNAUTHORIZED, "no").into_response();
        }
        if method == "initialize" {
            let mut res = Json(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "protocolVersion": PROTOCOL, "capabilities": { "tools": {} }, "serverInfo": { "name": "drive" } } })).into_response();
            res.headers_mut().insert("mcp-session-id", axum::http::HeaderValue::from_static("sess"));
            return res;
        }
        if headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) != Some("sess") {
            return (axum::http::StatusCode::BAD_REQUEST, "session").into_response();
        }
        if method == "notifications/initialized" {
            return axum::http::StatusCode::ACCEPTED.into_response();
        }
        if method == "tools/list" {
            return Json(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "tools": [ { "name": "search_files", "description": "Search", "inputSchema": { "type": "object" } }, { "name": "create_file", "description": "Create a Doc, Sheet, Slide or file", "inputSchema": { "type": "object" } } ] } })).into_response();
        }
        Json(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "content": [{ "type": "text", "text": "found plan" }] } })).into_response()
    }

    #[tokio::test]
    async fn lists_and_calls_the_remote_drive_server() {
        let fake = Arc::new(Fake::default());
        let app = Router::new().route("/token", post(token)).route("/mcp", post(mcp)).with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.ok() });
        let dir = tempfile::tempdir().unwrap();
        let drive = DriveMcp::with_endpoints(
            dir.path(),
            GoogleMcpKind::Drive,
            &format!("http://{addr}/mcp"),
            &format!("http://{addr}/auth"),
            &format!("http://{addr}/token"),
        );
        let status = drive.set_client("client", "secret").await.unwrap();
        assert!(status.configured && !status.connected);
        let url = drive.start_url("http://127.0.0.1/cb").await.unwrap();
        let state = url.split("state=").nth(1).unwrap();
        drive.exchange("code", state).await.unwrap();
        assert!(drive.status("http://127.0.0.1/cb").await.connected);
        let tools = drive.tools().await.unwrap();
        assert_eq!(tools[0]["name"], "search_files");
        assert!(tools.iter().any(|t| t["name"] == "create_file"));
        let found = drive.call("search_files", json!({ "query": "plan" })).await.unwrap();
        assert_eq!(found["content"][0]["text"], "found plan");
        assert!(drive.call("nope", json!({})).await.unwrap_err().contains("unknown tool"));
        let again = drive.tools().await.unwrap();
        assert_eq!(again.len(), 2);
        let calls = fake.calls.lock().await.clone();
        assert!(calls.contains(&"initialize".into()), "{calls:?}");
        assert!(calls.iter().filter(|c| *c == "tools/list").count() >= 1);
    }
}
