use std::path::Path;
use tokio::fs;

pub async fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    match fs::write(&tmp, contents).await {
        Ok(()) => {}
        Err(err) => {
            let _ = fs::remove_file(&tmp).await;
            return Err(err);
        }
    }
    match fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp).await;
            Err(err)
        }
    }
}

pub fn write_atomic_sync(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::write(&tmp, contents) {
        Ok(()) => {}
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(err);
        }
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn writes_and_reads_back() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("x.json");
        write_atomic(&path, "{\"a\":1}\n").await.unwrap();
        let got = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(got, "{\"a\":1}\n");
    }
}
