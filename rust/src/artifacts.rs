//! HTML artifacts — Switchboard-skinned explainers for team chat.
//! Agents fill a named template; they do not invent CSS.

use regex::Regex;
use serde_json::{Map, Value};

const MAX_BYTES: usize = 400_000;

const TPL_WALKTHROUGH: &str = include_str!("../../skills/artifacts/references/walkthrough.html");
const TPL_COMPARE: &str = include_str!("../../skills/artifacts/references/compare.html");
const TPL_QUIZ: &str = include_str!("../../skills/artifacts/references/quiz.html");
const TPL_CARDS: &str = include_str!("../../skills/artifacts/references/cards.html");

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn field_str(fields: &Map<String, Value>, key: &str) -> String {
    match fields.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string().trim_matches('"').to_string(),
        None => String::new(),
    }
}

/// Replace `{{KEY}}` placeholders. Leftover keys become empty.
pub fn fill_template(tpl: &str, fields: &Map<String, Value>) -> String {
    let mut out = tpl.to_string();
    let re = Regex::new(r"\{\{([A-Z0-9_]+)\}\}").unwrap();
    out = re
        .replace_all(&out, |caps: &regex::Captures| {
            let key = &caps[1];
            escape_html(&field_str(fields, key))
        })
        .into_owned();
    out
}

pub fn template_source(name: &str) -> Result<&'static str, String> {
    match name.trim().to_ascii_lowercase().as_str() {
        "walkthrough" => Ok(TPL_WALKTHROUGH),
        "compare" => Ok(TPL_COMPARE),
        "quiz" => Ok(TPL_QUIZ),
        "cards" => Ok(TPL_CARDS),
        other => Err(format!(
            "unknown template \"{other}\" — use walkthrough, compare, quiz, or cards"
        )),
    }
}

/// Build Switchboard-styled HTML from a named template + field map.
pub fn build_from_template(title: &str, template: &str, fields: &Map<String, Value>) -> Result<String, String> {
    let tpl = template_source(template)?;
    let mut map = fields.clone();
    if !map.contains_key("TITLE") && !title.trim().is_empty() {
        map.insert("TITLE".into(), Value::String(title.trim().to_string()));
    }
    let filled = fill_template(tpl, &map);
    validate_artifact(title, &filled)
}

/// Wrap a fragment in a Switchboard shell document.
pub fn wrap_html(title: &str, html: &str) -> String {
    let trimmed = html.trim();
    // Templates already ship <style>; never nest a second full document.
    let body_inner = if let Some(start) = trimmed.to_ascii_lowercase().find("<body") {
        let after = &trimmed[start..];
        if let Some(gt) = after.find('>') {
            let inner = &after[gt + 1..];
            if let Some(end) = inner.to_ascii_lowercase().rfind("</body>") {
                inner[..end].trim()
            } else {
                inner.trim()
            }
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    // Keep <style>/<link> from a full document's <head>; only <title>/<meta> are ours.
    let lower = trimmed.to_ascii_lowercase();
    let head_inner = match (lower.find("<head>"), lower.find("</head>")) {
        (Some(a), Some(b)) if a < b => trimmed[a + 6..b]
            .lines()
            .filter(|l| {
                let l = l.trim_start().to_ascii_lowercase();
                !l.starts_with("<title") && !l.starts_with("<meta")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let safe_title = title
        .chars()
        .map(|c| if c == '<' || c == '>' || c == '&' { ' ' } else { c })
        .take(80)
        .collect::<String>();
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{safe_title}</title>
{head_inner}
</head>
<body>
{body_inner}
</body>
</html>"#
    )
}

pub fn validate_artifact(title: &str, html: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("title is required".into());
    }
    if title.chars().count() > 80 {
        return Err("title must be at most 80 characters".into());
    }
    let html = html.trim();
    if html.is_empty() {
        return Err("html is required".into());
    }
    let wrapped = wrap_html(title, html);
    if wrapped.len() > MAX_BYTES {
        return Err(format!("html is too large (max {MAX_BYTES} bytes)"));
    }
    Ok(wrapped)
}

pub fn marker(id: &str, title: &str) -> String {
    let safe = title.replace(['[', ']', '|', '\n', '\r'], " ").trim().to_string();
    format!("[[artifact:{id}|{safe}]]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_head_styles() {
        let out = wrap_html("T", "<html><head><title>x</title>\n<style>.a{color:red}</style>\n</head><body><p class=a>hi</p></body></html>");
        assert!(out.contains("<style>.a{color:red}</style>"));
        assert!(out.contains("<p class=a>hi</p>"));
        assert_eq!(out.matches("<title>").count(), 1);
    }

    #[test]
    fn fills_placeholders() {
        let mut fields = Map::new();
        fields.insert("TITLE".into(), json!("Hola"));
        fields.insert("LEAD".into(), json!("<b>x</b>"));
        let out = fill_template("<h1>{{TITLE}}</h1><p>{{LEAD}}</p>{{MISSING}}", &fields);
        assert!(out.contains("Hola"));
        assert!(out.contains("&lt;b&gt;x&lt;/b&gt;"));
        assert!(!out.contains("{{"));
    }

    #[test]
    fn quiz_template_is_light() {
        let mut fields = Map::new();
        fields.insert("TITLE".into(), json!("Sistema solar"));
        fields.insert("LEAD".into(), json!("Tres preguntas"));
        fields.insert("Q1".into(), json!("Mas grande?"));
        fields.insert("Q1_A".into(), json!("Jupiter"));
        fields.insert("Q1_B".into(), json!("Marte"));
        fields.insert("Q1_C".into(), json!("Tierra"));
        fields.insert("Q1_ANSWER".into(), json!("0"));
        fields.insert("Q2".into(), json!("Anillos?"));
        fields.insert("Q2_A".into(), json!("Saturno"));
        fields.insert("Q2_B".into(), json!("Venus"));
        fields.insert("Q2_C".into(), json!("Mercurio"));
        fields.insert("Q2_ANSWER".into(), json!("0"));
        fields.insert("Q3".into(), json!("Rojo?"));
        fields.insert("Q3_A".into(), json!("Marte"));
        fields.insert("Q3_B".into(), json!("Neptuno"));
        fields.insert("Q3_C".into(), json!("Urano"));
        fields.insert("Q3_ANSWER".into(), json!("0"));
        let html = build_from_template("Quiz", "quiz", &fields).unwrap();
        assert!(html.contains("Bangers"));
        assert!(html.contains("#f6f7f9"));
        assert!(html.contains("Jupiter"));
        assert!(!html.to_ascii_lowercase().contains("#0b0e14"));
    }

    #[test]
    fn marker_format() {
        assert_eq!(
            marker("aabbccddeeff001122334455", "OAuth"),
            "[[artifact:aabbccddeeff001122334455|OAuth]]"
        );
    }
}
