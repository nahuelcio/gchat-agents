use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const CHAT_BOT_SCOPE: &str = "https://www.googleapis.com/auth/chat.bot";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    pub configured: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PostMessageBody {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<PostThread>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cards_v2: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostThread {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_key: Option<String>,
}

impl PostMessageBody {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            thread: None,
            cards_v2: None,
        }
    }
}

#[async_trait]
pub trait ChatClient: Send + Sync {
    async fn post_message(&self, space: &str, body: &PostMessageBody) -> Result<(), String>;
    fn status(&self) -> GoogleStatus;
    async fn download_media(&self, _resource_name: &str) -> Result<Vec<u8>, String> {
        Err("media download unavailable".into())
    }
}

pub struct NullChat;

#[async_trait]
impl ChatClient for NullChat {
    async fn post_message(&self, _space: &str, _body: &PostMessageBody) -> Result<(), String> {
        Ok(())
    }

    fn status(&self) -> GoogleStatus {
        GoogleStatus {
            configured: false,
            source: "none".into(),
            client_email: None,
            project_id: None,
            endpoint: None,
        }
    }
}

pub struct RecordingChat {
    pub posts: Mutex<Vec<(String, PostMessageBody)>>,
}

impl RecordingChat {
    pub fn new() -> Self {
        Self {
            posts: Mutex::new(Vec::new()),
        }
    }
}

impl Default for RecordingChat {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ChatClient for RecordingChat {
    async fn post_message(&self, space: &str, body: &PostMessageBody) -> Result<(), String> {
        self.posts.lock().unwrap().push((space.to_string(), body.clone()));
        Ok(())
    }

    fn status(&self) -> GoogleStatus {
        GoogleStatus {
            configured: true,
            source: "ui".into(),
            client_email: Some("bot@example.com".into()),
            project_id: None,
            endpoint: None,
        }
    }
}

#[derive(Clone)]
struct SaKey {
    client_email: String,
    private_key: String,
    project_id: Option<String>,
    raw: String,
}

struct TokenCache {
    access_token: String,
    expires_at: u64,
}

pub struct GoogleConnection {
    key_file: PathBuf,
    state: Mutex<GoogleStatus>,
    key: Mutex<Option<SaKey>>,
    token: Mutex<Option<TokenCache>>,
    http: reqwest::Client,
    token_url: String,
    chat_base: String,
}

impl GoogleConnection {
    pub fn open(key_file: impl AsRef<Path>, env_key: Option<&str>) -> Self {
        let key_file = key_file.as_ref().to_path_buf();
        let mut status = GoogleStatus {
            configured: false,
            source: "none".into(),
            client_email: None,
            project_id: None,
            endpoint: None,
        };
        let mut key = None;
        if let Some(raw) = env_key {
            if let Some(parsed) = parse_sa(raw) {
                status = status_from(&parsed, "env");
                key = Some(parsed);
            }
        } else if let Ok(raw) = std::fs::read_to_string(&key_file) {
            if let Some(parsed) = parse_sa(&raw) {
                status = status_from(&parsed, "ui");
                key = Some(parsed);
            }
        }
        Self {
            key_file,
            state: Mutex::new(status),
            key: Mutex::new(key),
            token: Mutex::new(None),
            http: reqwest::Client::new(),
            token_url: TOKEN_URL.into(),
            chat_base: "https://chat.googleapis.com/v1".into(),
        }
    }

    #[cfg(test)]
    pub fn with_endpoints(
        key_file: impl AsRef<Path>,
        raw: &str,
        token_url: &str,
        chat_base: &str,
    ) -> Self {
        let mut g = Self::open(key_file, Some(raw));
        g.token_url = token_url.into();
        g.chat_base = chat_base.into();
        g
    }

    pub fn status(&self) -> GoogleStatus {
        self.state.lock().unwrap().clone()
    }

    pub async fn set_key(&self, key: &str) -> Result<(), String> {
        let parsed = parse_sa(key).ok_or_else(|| "invalid service account JSON".to_string())?;
        if let Some(parent) = self.key_file.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&self.key_file, &parsed.raw)
            .await
            .map_err(|e| e.to_string())?;
        *self.state.lock().unwrap() = status_from(&parsed, "ui");
        *self.key.lock().unwrap() = Some(parsed);
        *self.token.lock().unwrap() = None;
        Ok(())
    }

    pub async fn clear_key(&self) -> Result<(), String> {
        let _ = tokio::fs::remove_file(&self.key_file).await;
        *self.state.lock().unwrap() = GoogleStatus {
            configured: false,
            source: "none".into(),
            client_email: None,
            project_id: None,
            endpoint: None,
        };
        *self.key.lock().unwrap() = None;
        *self.token.lock().unwrap() = None;
        Ok(())
    }

    async fn access_token(&self) -> Result<String, String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        {
            let cache = self.token.lock().unwrap();
            if let Some(t) = cache.as_ref() {
                if t.expires_at > now + 60 {
                    return Ok(t.access_token.clone());
                }
            }
        }
        let key = self
            .key
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Google Chat not connected".to_string())?;
        let assertion = sign_jwt(&key, now)?;
        let res = self
            .http
            .post(&self.token_url)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("token exchange {status}: {}", &body[..body.len().min(500)]));
        }
        #[derive(Deserialize)]
        struct TokenRes {
            access_token: String,
            expires_in: Option<u64>,
        }
        let body: TokenRes = res.json().await.map_err(|e| e.to_string())?;
        let expires_at = now + body.expires_in.unwrap_or(3600);
        *self.token.lock().unwrap() = Some(TokenCache {
            access_token: body.access_token.clone(),
            expires_at,
        });
        Ok(body.access_token)
    }

    pub async fn post_message(&self, space: &str, body: &PostMessageBody) -> Result<(), String> {
        if !self.status().configured {
            return Err("Google Chat not connected".into());
        }
        let token = self.access_token().await?;
        let mut url = format!("{}/{space}/messages", self.chat_base);
        if body.thread.is_some() {
            url.push_str("?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
        }
        let post = || {
            self.http
                .post(&url)
                .bearer_auth(&token)
                .json(body)
                .timeout(Duration::from_secs(30))
                .send()
        };
        let mut res = post().await.map_err(|e| e.to_string())?;
        if res.status().as_u16() == 429 || res.status().is_server_error() {
            tokio::time::sleep(Duration::from_secs(1)).await;
            res = post().await.map_err(|e| e.to_string())?;
        }
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Chat API {status}: {}", &text[..text.len().min(500)]));
        }
        Ok(())
    }

    pub async fn download_media(&self, resource_name: &str) -> Result<Vec<u8>, String> {
        if !self.status().configured {
            return Err("Google Chat not connected".into());
        }
        let token = self.access_token().await?;
        let url = format!("{}/media/{resource_name}?alt=media", self.chat_base);
        let res = self
            .http
            .get(&url)
            .bearer_auth(&token)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Chat media {status}: {}", &text[..text.len().min(500)]));
        }
        Ok(res.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }
}

#[async_trait]
impl ChatClient for GoogleConnection {
    async fn post_message(&self, space: &str, body: &PostMessageBody) -> Result<(), String> {
        GoogleConnection::post_message(self, space, body).await
    }

    fn status(&self) -> GoogleStatus {
        GoogleConnection::status(self)
    }

    async fn download_media(&self, resource_name: &str) -> Result<Vec<u8>, String> {
        GoogleConnection::download_media(self, resource_name).await
    }
}

fn status_from(key: &SaKey, source: &str) -> GoogleStatus {
    GoogleStatus {
        configured: true,
        source: source.into(),
        client_email: Some(key.client_email.clone()),
        project_id: key.project_id.clone(),
        endpoint: None,
    }
}

fn parse_sa(raw: &str) -> Option<SaKey> {
    let text = if raw.trim_start().starts_with('{') {
        raw.to_string()
    } else {
        base64_decode(raw)?
    };
    let value: Value = serde_json::from_str(&text).ok()?;
    let client_email = value.get("client_email")?.as_str()?.to_string();
    let private_key = value.get("private_key")?.as_str()?.to_string();
    if value.get("type").and_then(|v| v.as_str()) != Some("service_account") {
        return None;
    }
    Some(SaKey {
        client_email,
        private_key,
        project_id: value.get("project_id").and_then(|v| v.as_str()).map(str::to_string),
        raw: text,
    })
}

#[derive(Serialize)]
struct JwtClaims {
    iss: String,
    scope: String,
    aud: String,
    iat: u64,
    exp: u64,
}

fn sign_jwt(key: &SaKey, now: u64) -> Result<String, String> {
    let claims = JwtClaims {
        iss: key.client_email.clone(),
        scope: CHAT_BOT_SCOPE.into(),
        aud: TOKEN_URL.into(),
        iat: now,
        exp: now + 3600,
    };
    let encoding = EncodingKey::from_rsa_pem(key.private_key.as_bytes()).map_err(|e| e.to_string())?;
    encode(&Header::new(Algorithm::RS256), &claims, &encoding).map_err(|e| e.to_string())
}

fn base64_decode(raw: &str) -> Option<String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_json_key() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sa.json");
        let raw = r#"{"type":"service_account","client_email":"a@b.com","project_id":"p","private_key":"x"}"#;
        let g = GoogleConnection::open(&path, Some(raw));
        let s = g.status();
        assert!(s.configured);
        assert_eq!(s.client_email.as_deref(), Some("a@b.com"));
    }

    #[tokio::test]
    async fn posts_with_fake_token_server() {
        let dir = tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let req = String::from_utf8_lossy(&buf);
                let body = if req.contains("/token") {
                    r#"{"access_token":"tok","expires_in":3600}"#
                } else {
                    r#"{}"#
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        let raw = serde_json::json!({
            "type": "service_account",
            "client_email": "bot@example.com",
            "private_key": TEST_PRIV,
            "project_id": "p"
        })
        .to_string();
        let g = GoogleConnection::with_endpoints(
            dir.path().join("sa.json"),
            &raw,
            &format!("http://{addr}/token"),
            &format!("http://{addr}/chat"),
        );
        g.post_message("spaces/x", &PostMessageBody::text("hi"))
            .await
            .unwrap();
    }

    const TEST_PRIV: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAndFPS8U4n2hdvvmGhw32XiRXtbPs+DkUYKBShXRmi1a6ETpn
mWmG4IvnoJN7uQUZPCTAVmem3gzB7EvUk/RCC3hYNJGW2HFZiglNJhuMfX+26Ga3
zviNkYOeBFn6aGSWxs6PI8q/StdxRd6Ca25hjgWo8WJB8UTVwyxUDX/9n6nSt+K0
Ea45sRxRlpfpxDBeA+mDivYtu5ksGQAf1tTlHVaNRqhvftZrWLCCm/tiZJ6uRHfF
izp2O4RKnoJ3JpNRCJ47/qDjw45Nd3Pzk0kNdQEghhTEZJqNrEZNXgwM2XKEnSfO
uyrBDxzR+zt3BaBTl5ho3E5NpyEh1BpE/Faa2QIDAQABAoIBAEzPZ7GwHpvvNtlR
JvmqgQNW2t2T4bz6QwG4ZhGQEqy0nEDwVSXkp4G4dhbAUVI+ugZ8uKQVNLEUMnoo
eiE8m7xraTrEtU9I89RsLIFknR8jvskj3Ug9zuFI1uq1RFv0wTGnrSE1d58cdoQU
BRP2mEKAXLaHJSMhZozkkVA0wCMpxwuy1V9+SFKjMtBqoV5H8CjoBMRu0312iZPV
cOK01R/SwetTtJu2d7eccVrECPSUH9BfpCH7K74u8sxL+RcJiO8V3zrknZyYBT0X
r9e1V3QRoiN5GZsglmVqB+1heOSLoNcRsSVFeNSOdBGRusQiTjnNp2misiexbqgT
G7375ZUCgYEA2q4F8K3y/HWQ1wpRpZuiX054MJtiD4C5giKkY3StTnY64cwSWivu
Ny5vK+PvpE+fB5gGW1VyL44XKGxOReQPfd8a7+iTKoENWTqh38EC/5O1ufghZhb/
w7DAJGNXF5+p0Zq8nde3VTD0PD2jAaU66lpO5o/Ffulu6FaAw3NRJl8CgYEAuMBC
JywRJjDqGYK8ePHtqtkbqKoHrLXUSG/9XMMwcT01SlVfnMvrgchCLoYdMWJd9aC0
opxTcj0jrFveKRC71FAaRtK1x9MyRzUuPRQ6fNmWyypdPItvId2JP03LjGZxjTnr
zaARrIYQkQ2npAQIxidSR4wrnQB1WIfNZwqNmccCgYAFudDGAIgAPEPSnZ6Nq4mQ
3UkgXLEwnro8whNz1zZCe64HA4Tnf4b5Qun+SDWaI8uSM1TXR2F6BUpt8IgMJHCT
ZygZaAmSb1aeI37hkPg3IPL9L5YQSkHgKdyeF0vMfo2/w0F1EJToUiPS//oorN7i
DANM3i7Zp9sTklBEzdwuGQKBgDa/mpr7HxXfNvBaYrnAj7qqXdzsjhurQn442a8M
lKVqCwm9JPlVILQ0ARDCY5JH4Sox9nWdt8jJv3GLQ9mNgOvY1QCZ3o6Z0nNxmgM1
pGNtI5ePNVQEyekSOmLNDf3MOegs+ujTf4lNrUke78fV/jeiXWqgaig7g4q5q6/W
W8HvAoGAHb2IyhklNX91RLJEqxlhsPAdF08RNfSR3HhfHGF61YyGMeqbrEPA7wwM
GtxxmbVoyizNptHhPrudf0XotySbWPWH6fr9EmYwXfwZL1oe0xe8U1ZAQED1P9Wi
Mm34nQQ5i+3YD/iKmsV0Ll4gnNZ8REM+m40d/naX90of8xYGS8I=
-----END RSA PRIVATE KEY-----";
}
