use regex::Regex;

pub fn extract_prompt(argument_text: Option<&str>, text: Option<&str>) -> String {
    if let Some(arg) = argument_text.map(str::trim).filter(|s| !s.is_empty()) {
        return arg.to_string();
    }
    let mention = Regex::new(r"<@[^>]*>").unwrap();
    mention.replace_all(text.unwrap_or(""), " ").trim().to_string()
}

pub fn chunk_text(text: &str, limit: usize) -> Vec<String> {
    if text.len() <= limit {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut rest = text;
    while rest.len() > limit {
        let window = &rest[..limit];
        let cut = window.rfind('\n').filter(|&i| i > 0).unwrap_or(limit);
        chunks.push(rest[..cut].to_string());
        rest = &rest[cut..];
    }
    if !rest.is_empty() {
        chunks.push(rest.to_string());
    }
    chunks
}

pub fn thread_slug(thread_key: &str) -> String {
    let digest = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(thread_key.as_bytes());
        hex::encode(h.finalize())
    };
    digest[..12.min(digest.len())].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_argument_text() {
        assert_eq!(extract_prompt(Some(" hi "), Some("<@x> bye")), "hi");
    }

    #[test]
    fn chunks_on_newlines() {
        let chunks = chunk_text("aaaa\nbbbb\ncccc", 6);
        assert!(chunks.iter().all(|c| c.len() <= 6));
        assert_eq!(chunks.concat(), "aaaa\nbbbb\ncccc");
    }
}
