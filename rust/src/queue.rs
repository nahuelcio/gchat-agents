use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;

type Tail = Arc<Mutex<()>>;

#[derive(Default)]
pub struct TurnQueue {
    tails: Mutex<HashMap<String, Tail>>,
    pending: Mutex<HashMap<String, Arc<AtomicUsize>>>,
}

impl TurnQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn busy(&self, key: &str) -> bool {
        self.pending
            .lock()
            .await
            .get(key)
            .map(|c| c.load(Ordering::SeqCst) > 0)
            .unwrap_or(false)
    }

    pub async fn run<T, F, Fut>(&self, key: &str, fn_: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let tail = {
            let mut tails = self.tails.lock().await;
            tails
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let counter = {
            let mut pending = self.pending.lock().await;
            pending
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
                .clone()
        };
        counter.fetch_add(1, Ordering::SeqCst);
        let _guard = tail.lock().await;
        let result = fn_().await;
        let left = counter.fetch_sub(1, Ordering::SeqCst);
        if left == 1 {
            self.pending.lock().await.remove(key);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn same_key_ordering() {
        let q = Arc::new(TurnQueue::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = oneshot::channel::<()>();
        let q1 = q.clone();
        let o1 = order.clone();
        let h1 = tokio::spawn(async move {
            q1.run("t", || async {
                o1.lock().await.push(1);
                let _ = rx.await;
                o1.lock().await.push(2);
            })
            .await;
        });
        tokio::task::yield_now().await;
        let q2 = q.clone();
        let o2 = order.clone();
        let h2 = tokio::spawn(async move {
            q2.run("t", || async {
                o2.lock().await.push(3);
            })
            .await;
        });
        tokio::task::yield_now().await;
        assert!(q.busy("t").await);
        tx.send(()).unwrap();
        h1.await.unwrap();
        h2.await.unwrap();
        assert_eq!(*order.lock().await, vec![1, 2, 3]);
    }
}
