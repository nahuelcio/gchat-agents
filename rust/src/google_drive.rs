use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::google::{GoogleConnection, DRIVE_FILE_SCOPE};

const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

#[derive(Debug, Clone, Deserialize)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub web_view_link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub file: DriveFile,
    pub created: bool,
    pub rows: usize,
}

pub struct Drive {
    conn: Arc<GoogleConnection>,
    base: String,
    upload: String,
    http: reqwest::Client,
}

pub fn build_xlsx(sheets: &[Sheet]) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("at least one sheet is required".into());
    }
    let mut book = rust_xlsxwriter::Workbook::new();
    for sheet in sheets {
        let ws = book.add_worksheet();
        ws.set_name(sheet.name.chars().take(31).collect::<String>()).map_err(|e| e.to_string())?;
        for (r, row) in sheet.rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let (r, c) = (r as u32, c as u16);
                match cell {
                    Value::Number(n) => ws.write_number(r, c, n.as_f64().unwrap_or_default()).map(|_| ()),
                    Value::Bool(b) => ws.write_boolean(r, c, *b).map(|_| ()),
                    Value::Null => Ok(()),
                    Value::String(s) => ws.write_string(r, c, s).map(|_| ()),
                    other => ws.write_string(r, c, other.to_string()).map(|_| ()),
                }
                .map_err(|e| e.to_string())?;
            }
        }
    }
    book.save_to_buffer().map_err(|e| e.to_string())
}

fn quote(v: &str) -> String {
    v.replace('\\', "\\\\").replace('\'', "\\'")
}

impl Drive {
    pub fn new(conn: Arc<GoogleConnection>) -> Self {
        Self::with_base(conn, "https://www.googleapis.com/drive/v3", "https://www.googleapis.com/upload/drive/v3")
    }

    pub fn with_base(conn: Arc<GoogleConnection>, base: &str, upload: &str) -> Self {
        Self { conn, base: base.trim_end_matches('/').into(), upload: upload.trim_end_matches('/').into(), http: reqwest::Client::new() }
    }

    async fn token(&self) -> Result<String, String> {
        self.conn.token_for(DRIVE_FILE_SCOPE).await
    }

    fn explain(&self, status: reqwest::StatusCode, body: &str, folder: &str) -> String {
        if status == reqwest::StatusCode::NOT_FOUND {
            let who = self.conn.client_email().unwrap_or_else(|| "the service account".into());
            return format!("Drive folder {folder} not found: share it with {who} as Editor");
        }
        format!("Drive {status}: {}", &body[..body.len().min(300)])
    }

    async fn query(&self, folder: &str, q: &str) -> Result<Vec<DriveFile>, String> {
        let token = self.token().await?;
        let res = self
            .http
            .get(format!("{}/files", self.base))
            .bearer_auth(token)
            .query(&[
                ("q", q),
                ("fields", "files(id,name,mimeType,webViewLink)"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ])
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(self.explain(status, &body, folder));
        }
        #[derive(Deserialize)]
        struct Files {
            #[serde(default)]
            files: Vec<DriveFile>,
        }
        Ok(serde_json::from_str::<Files>(&body).map_err(|e| e.to_string())?.files)
    }

    pub async fn list(&self, folder: &str) -> Result<Vec<DriveFile>, String> {
        self.query(folder, &format!("'{}' in parents and mimeType='{XLSX}' and trashed=false", quote(folder))).await
    }

    pub async fn find_task(&self, folder: &str, task_id: &str) -> Result<Option<DriveFile>, String> {
        let q = format!(
            "appProperties has {{ key='switchboardTaskId' and value='{}' }} and '{}' in parents and trashed=false",
            quote(task_id),
            quote(folder)
        );
        Ok(self.query(folder, &q).await?.into_iter().next())
    }

    pub async fn create_xlsx(&self, folder: &str, task_id: &str, title: &str, sheets: &[Sheet]) -> Result<Created, String> {
        let rows = sheets.iter().map(|s| s.rows.len()).sum();
        let bytes = build_xlsx(sheets)?;
        let name = if title.to_lowercase().ends_with(".xlsx") { title.to_string() } else { format!("{title}.xlsx") };
        self.upload_new(folder, task_id, &name, XLSX, &bytes, rows).await
    }

    async fn upload_new(&self, folder: &str, task_id: &str, name: &str, mime: &str, bytes: &[u8], count: usize) -> Result<Created, String> {
        if let Some(file) = self.find_task(folder, task_id).await? {
            return Ok(Created { file, created: false, rows: count });
        }
        let meta = serde_json::json!({
            "name": name,
            "parents": [folder],
            "mimeType": mime,
            "appProperties": { "switchboardTaskId": task_id },
        });
        let boundary = format!("switchboard{}", uuid::Uuid::new_v4().simple());
        let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let token = self.token().await?;
        let res = self
            .http
            .post(format!("{}/files", self.upload))
            .bearer_auth(token)
            .query(&[("uploadType", "multipart"), ("fields", "id,name,mimeType,webViewLink"), ("supportsAllDrives", "true")])
            .header("content-type", format!("multipart/related; boundary={boundary}"))
            .body(body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(self.explain(status, &text, folder));
        }
        let file: DriveFile = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(Created { file, created: true, rows: count })
    }
}

pub fn persona_of<'a>(thread_key: &str, personas: &'a [crate::settings::Persona]) -> Option<&'a crate::settings::Persona> {
    let name = thread_key.rsplit_once('#')?.1;
    personas.iter().find(|p| p.name.eq_ignore_ascii_case(name))
}

pub fn allowed(thread_key: &str, settings: &crate::settings::Settings) -> Result<String, String> {
    let persona = persona_of(thread_key, &settings.personas).ok_or("Drive tools are only for agents that list the google-drive MCP")?;
    if !crate::skills::mcps(persona).iter().any(|m| m == "google-drive") {
        return Err(format!("@{} does not have the google-drive MCP", persona.name));
    }
    settings.google_drive_folder_id.clone().ok_or_else(|| "Set the Google Drive folder id in Settings first".into())
}

pub fn task_id(thread_key: &str, ledger: Option<&crate::turn_ledger::TurnLedger>, title: &str) -> String {
    let base = thread_key.split('#').next().unwrap_or(thread_key);
    let turn = ledger.and_then(|l| l.running_for(base)).unwrap_or_else(|| base.to_string());
    format!("{turn}|{thread_key}|{}", title.trim().to_lowercase())
}

pub fn drive_task(explicit: Option<&str>, kind: &str, title: &str, thread_key: &str, ledger: Option<&crate::turn_ledger::TurnLedger>) -> String {
    let title = title.trim().to_lowercase();
    if let Some(id) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return format!("{id}|{kind}|{title}");
    }
    if kind == "xlsx" {
        return task_id(thread_key, ledger, &title);
    }
    format!("{}|{kind}", task_id(thread_key, ledger, &title))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::extract::{Query, State};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct FakeDrive {
        pub files: Mutex<Vec<(DriveFile, String, String)>>,
        pub uploads: Mutex<usize>,
    }

    async fn token() -> Json<Value> {
        Json(serde_json::json!({ "access_token": "tok", "expires_in": 3600 }))
    }

    async fn list(State(fake): State<Arc<FakeDrive>>, Query(q): Query<HashMap<String, String>>) -> axum::response::Response {
        use axum::response::IntoResponse;
        let query = q.get("q").cloned().unwrap_or_default();
        if query.contains("'missing'") {
            return (axum::http::StatusCode::NOT_FOUND, "File not found").into_response();
        }
        let only_xlsx = query.contains("spreadsheetml.sheet");
        let files: Vec<DriveFile> = fake
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(file, folder, task)| {
                let in_folder = query.contains(&format!("'{folder}' in parents"));
                let task_ok = !query.contains("switchboardTaskId") || query.contains(&format!("value='{task}'"));
                let mime_ok = !only_xlsx || file.mime_type.as_deref() == Some(super::XLSX);
                in_folder && task_ok && mime_ok
            })
            .map(|(f, _, _)| f.clone())
            .collect();
        Json(serde_json::json!({ "files": files })).into_response()
    }

    async fn upload(State(fake): State<Arc<FakeDrive>>, body: axum::body::Bytes) -> Json<Value> {
        let text = String::from_utf8_lossy(&body);
        let start = text.find('{').unwrap();
        let end = text[start..].find("\r\n--").unwrap() + start;
        let meta: Value = serde_json::from_str(&text[start..end]).unwrap();
        *fake.uploads.lock().unwrap() += 1;
        let id = format!("file{}", *fake.uploads.lock().unwrap());
        let file = DriveFile {
            id: id.clone(),
            name: meta["name"].as_str().unwrap().into(),
            web_view_link: Some(format!("https://drive.example/{id}")),
            mime_type: meta["mimeType"].as_str().map(str::to_string),
        };
        fake.files.lock().unwrap().push((
            file.clone(),
            meta["parents"][0].as_str().unwrap().into(),
            meta["appProperties"]["switchboardTaskId"].as_str().unwrap().into(),
        ));
        Json(serde_json::to_value(file).unwrap())
    }

    pub(crate) async fn fake_drive(dir: &std::path::Path) -> (Drive, Arc<FakeDrive>, Arc<GoogleConnection>) {
        let fake = Arc::new(FakeDrive::default());
        let app = Router::new()
            .route("/token", post(token))
            .route("/drive/files", get(list))
            .route("/upload/files", post(upload))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.ok() });
        let raw = serde_json::json!({ "type": "service_account", "client_email": "bot@example.iam.gserviceaccount.com", "private_key": crate::google::tests::TEST_PRIV }).to_string();
        let conn = Arc::new(GoogleConnection::with_endpoints(dir.join("sa.json"), &raw, &format!("http://{addr}/token"), &format!("http://{addr}/chat")));
        (Drive::with_base(conn.clone(), &format!("http://{addr}/drive"), &format!("http://{addr}/upload")), fake, conn)
    }

    #[test]
    fn only_personas_with_the_drive_mcp_may_use_it() {
        let finanzas = crate::settings::Persona { name: "finanzas".into(), prompt: String::new(), driver: None, model: None, agent: None, listen: None, respond_to: None, skills: vec![], mcps: vec!["google-drive".into()], delegates: vec![] };
        let dev = crate::settings::Persona { name: "dev".into(), mcps: vec![], ..finanzas.clone() };
        let mut settings: crate::settings::Settings = serde_json::from_value(serde_json::json!({
            "agentDriver": "opencode", "models": {}, "agents": {}, "repos": {}, "allowedSpaces": [], "contextFooter": "never", "autoCompactAt": 0, "personas": []
        }))
        .unwrap();
        settings.personas = vec![finanzas, dev];
        assert!(allowed("share/x#finanzas", &settings).unwrap_err().contains("folder id"));
        settings.google_drive_folder_id = Some("F1".into());
        assert_eq!(allowed("share/x#finanzas", &settings).unwrap(), "F1");
        assert!(allowed("share/x#dev", &settings).unwrap_err().contains("does not have"));
        assert!(allowed("share/x", &settings).is_err());
        assert_eq!(task_id("share/x#finanzas", None, " Cierre "), "share/x|share/x#finanzas|cierre");
        assert_eq!(drive_task(None, "xlsx", " Cierre ", "share/x#finanzas", None), "share/x|share/x#finanzas|cierre");
        assert_eq!(drive_task(Some("pi:9"), "docx", "Informe", "share/x#finanzas", None), "pi:9|docx|informe");
        assert_ne!(drive_task(Some("pi:9"), "xlsx", "Informe", "share/x#finanzas", None), drive_task(Some("pi:9"), "pptx", "Informe", "share/x#finanzas", None));
    }

    #[test]
    fn builds_a_workbook_with_numbers_and_text() {
        let sheets = vec![Sheet { name: "Marzo".into(), rows: vec![vec!["Concepto".into(), "Monto".into()], vec!["Ventas".into(), serde_json::json!(1500.5)]] }];
        let bytes = build_xlsx(&sheets).unwrap();
        assert!(bytes.starts_with(b"PK"));
        assert!(build_xlsx(&[]).is_err());
    }

    #[tokio::test]
    async fn the_same_task_never_uploads_twice() {
        let dir = tempfile::tempdir().unwrap();
        let (drive, fake, _) = fake_drive(dir.path()).await;
        let sheets = vec![Sheet { name: "Marzo".into(), rows: vec![vec!["a".into()], vec![serde_json::json!(1)]] }];
        let first = drive.create_xlsx("folder1", "req-1", "Cierre marzo", &sheets).await.unwrap();
        let again = drive.create_xlsx("folder1", "req-1", "Cierre marzo", &sheets).await.unwrap();
        let other = drive.create_xlsx("folder1", "req-2", "Cierre abril", &sheets).await.unwrap();
        assert!(first.created && !again.created && other.created);
        assert_eq!(first.file.id, again.file.id);
        assert_eq!(first.file.name, "Cierre marzo.xlsx");
        assert_eq!(first.rows, 2);
        assert_eq!(*fake.uploads.lock().unwrap(), 2);
        assert_eq!(drive.list("folder1").await.unwrap().len(), 2);
        let err = drive.create_xlsx("missing", "req-3", "x", &sheets).await.unwrap_err();
        assert!(err.contains("share it with bot@example.iam.gserviceaccount.com"), "{err}");
    }
}
