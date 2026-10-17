use std::collections::HashMap;
use std::sync::Mutex;

use crate::driver::types::PendingAgent;

static PARKED: Mutex<Option<HashMap<String, PendingAgent>>> = Mutex::new(None);

fn map() -> std::sync::MutexGuard<'static, Option<HashMap<String, PendingAgent>>> {
    let mut guard = PARKED.lock().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
}

pub fn hold_question(thread_key: &str, pending: PendingAgent) {
    let mut guard = map();
    let m = guard.as_mut().unwrap();
    if let Some(old) = m.remove(thread_key) {
        old.cancel();
    }
    m.insert(thread_key.to_string(), pending);
}

pub fn take_question(thread_key: &str) -> Option<PendingAgent> {
    map().as_mut().unwrap().remove(thread_key)
}

pub fn has_question(thread_key: &str) -> bool {
    map().as_ref().unwrap().contains_key(thread_key)
}

pub fn cancel_question(thread_key: &str) {
    if let Some(p) = map().as_mut().unwrap().remove(thread_key) {
        p.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::types::AgentTurnResult;
    use futures::FutureExt;

    #[tokio::test]
    async fn hold_and_take() {
        cancel_question("t1");
        hold_question(
            "t1",
            PendingAgent::new(
                vec![],
                |_| {
                    async {
                        Ok(AgentTurnResult {
                            reply: "ok".into(),
                            session_ref: None,
                            usage: None,
                            pending: None,
                        })
                    }
                    .boxed()
                },
                || {},
            ),
        );
        assert!(has_question("t1"));
        let p = take_question("t1").unwrap();
        assert!(!has_question("t1"));
        let out = p.resume("a".into()).await.unwrap();
        assert_eq!(out.reply, "ok");
        cancel_question("t1");
    }
}
