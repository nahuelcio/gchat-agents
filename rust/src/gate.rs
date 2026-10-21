use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::google::PostThread;
use crate::settings::ApprovalMode;

pub const WAIT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateInfo {
    pub id: String,
    pub thread_key: String,
    pub tool: String,
    pub detail: String,
    pub kind: String,
    pub at: String,
}

struct Open {
    info: GateInfo,
    tx: oneshot::Sender<bool>,
}

static GATES: Mutex<Option<HashMap<String, Open>>> = Mutex::new(None);
static ROUTES: Mutex<Option<HashMap<String, (String, Option<PostThread>)>>> = Mutex::new(None);

pub fn needs_gate(mode: ApprovalMode, kind: &str) -> bool {
    match mode {
        ApprovalMode::Off => false,
        ApprovalMode::Risky => kind == "risky" || kind == "outside",
        ApprovalMode::Writes => kind == "risky" || kind == "outside" || kind == "write",
    }
}

pub fn remember_route(thread_key: &str, space: &str, thread: Option<PostThread>) {
    ROUTES.lock().unwrap().get_or_insert_with(HashMap::new).insert(thread_key.to_string(), (space.to_string(), thread));
}

pub fn route(thread_key: &str) -> Option<(String, Option<PostThread>)> {
    ROUTES.lock().unwrap().as_ref()?.get(thread_key).cloned()
}

pub fn open(thread_key: &str, tool: &str, detail: &str, kind: &str) -> (GateInfo, oneshot::Receiver<bool>) {
    let mut bytes = [0u8; 3];
    rand::thread_rng().fill_bytes(&mut bytes);
    let info = GateInfo {
        id: format!("g{}", hex::encode(bytes)),
        thread_key: thread_key.to_string(),
        tool: tool.to_string(),
        detail: detail.chars().take(1500).collect(),
        kind: kind.to_string(),
        at: chrono::Local::now().to_rfc3339(),
    };
    let (tx, rx) = oneshot::channel();
    GATES.lock().unwrap().get_or_insert_with(HashMap::new).insert(info.id.clone(), Open { info: info.clone(), tx });
    (info, rx)
}

pub fn decide(id: &str, approve: bool) -> Option<GateInfo> {
    let open = GATES.lock().unwrap().as_mut()?.remove(id)?;
    let _ = open.tx.send(approve);
    Some(open.info)
}

pub fn forget(id: &str) {
    if let Some(m) = GATES.lock().unwrap().as_mut() {
        m.remove(id);
    }
}

pub fn pending() -> Vec<GateInfo> {
    let mut list: Vec<GateInfo> = GATES.lock().unwrap().as_ref().map(|m| m.values().map(|o| o.info.clone()).collect()).unwrap_or_default();
    list.sort_by(|a, b| a.at.cmp(&b.at));
    list
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn summary(info: &GateInfo) -> String {
    let id = &info.id;
    format!("The agent wants to run {}:\n{}\nReply /approve {id} or /deny {id}", info.tool, info.detail)
}

pub fn card(info: &GateInfo) -> Value {
    let button = |label: &str, approve: bool| {
        json!({
            "text": label,
            "onClick": { "action": {
                "function": "decideGate",
                "parameters": [{ "key": "gate", "value": info.id }, { "key": "approve", "value": if approve { "yes" } else { "no" } }]
            }}
        })
    };
    json!([{
        "cardId": format!("gate-{}", info.id),
        "card": {
            "header": { "title": "Approval needed", "subtitle": format!("{} · {}", info.tool, info.id) },
            "sections": [{ "widgets": [
                { "textParagraph": { "text": format!("<font face=\"monospace\">{}</font>", esc(&info.detail).replace('\n', "<br>")) } },
                { "buttonList": { "buttons": [button("Approve", true), button("Deny", false)] } }
            ]}]
        }
    }])
}

pub fn decided_text(info: &GateInfo, approve: bool, who: Option<&str>) -> String {
    let by = who.map(|w| format!(" by {w}")).unwrap_or_default();
    format!("{} {}{by}: {}", if approve { "✅ Approved" } else { "⛔ Denied" }, info.tool, info.detail.lines().next().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_gate_the_right_kinds() {
        assert!(!needs_gate(ApprovalMode::Off, "risky"));
        assert!(needs_gate(ApprovalMode::Risky, "risky"));
        assert!(!needs_gate(ApprovalMode::Risky, "write"));
        assert!(needs_gate(ApprovalMode::Risky, "outside"));
        assert!(needs_gate(ApprovalMode::Writes, "write"));
    }

    #[tokio::test]
    async fn decide_releases_the_waiter() {
        let (info, rx) = open("t/gate", "bash", "git push", "risky");
        assert!(pending().iter().any(|g| g.id == info.id));
        assert!(summary(&info).contains(&format!("/approve {}", info.id)));
        assert_eq!(decide(&info.id, true).unwrap().tool, "bash");
        assert!(rx.await.unwrap());
        assert!(decide(&info.id, false).is_none());
    }
}
