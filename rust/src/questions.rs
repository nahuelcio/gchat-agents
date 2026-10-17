use regex::Regex;
use serde_json::{json, Value};

use crate::driver::types::{AgentQuestion, QuestionOption};

pub fn normalize_questions(raw: &Value) -> Vec<AgentQuestion> {
    let Some(arr) = raw.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let question = item
            .get("question")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let Some(question) = question else { continue };
        let header = item
            .get("header")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Question")
            .to_string();
        let options: Vec<QuestionOption> = item
            .get("options")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|o| {
                let label = o.get("label")?.as_str()?.trim();
                if label.is_empty() {
                    return None;
                }
                Some(QuestionOption {
                    label: label.to_string(),
                    description: o
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                })
            })
            .collect();
        if options.len() < 2 {
            continue;
        }
        let multiple = item.get("multiple").and_then(|v| v.as_bool()).unwrap_or(false)
            || item.get("multiSelect").and_then(|v| v.as_bool()).unwrap_or(false);
        out.push(AgentQuestion {
            header,
            question,
            options,
            multiple: if multiple { Some(true) } else { None },
        });
    }
    out
}

pub fn format_questions(questions: &[AgentQuestion]) -> String {
    let body = questions
        .iter()
        .map(|q| {
            let mut lines = vec![q.header.clone(), q.question.clone()];
            for (i, o) in q.options.iter().enumerate() {
                let desc = o
                    .description
                    .as_ref()
                    .map(|d| format!(" — {d}"))
                    .unwrap_or_default();
                lines.push(format!("{}. {}{desc}", i + 1, o.label));
            }
            if q.multiple == Some(true) {
                lines.push("You can pick more than one.".into());
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("{body}\n\nReply with the number, the option, or your own answer.")
}

pub fn answers_from_text(questions: &[AgentQuestion], text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = if questions.len() == 1 {
        vec![text.trim()]
    } else {
        text.lines().map(str::trim).filter(|s| !s.is_empty()).collect()
    };
    let strip = Regex::new(r"^\d+\.\s*").unwrap();
    questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let raw = lines
                .get(i)
                .copied()
                .or_else(|| if questions.len() == 1 { lines.first().copied() } else { None })
                .unwrap_or("")
                .trim();
            let raw = strip.replace(raw, "");
            (q.question.clone(), resolve_choice(q, raw.trim()))
        })
        .collect()
}

pub fn answers_map_from_text(questions: &[AgentQuestion], text: &str) -> serde_json::Map<String, Value> {
    answers_from_text(questions, text)
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect()
}

fn resolve_choice(q: &AgentQuestion, raw: &str) -> String {
    let parts: Vec<&str> = raw.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return raw.trim().to_string();
    }
    let labels: Vec<String> = parts
        .into_iter()
        .map(|part| {
            if let Ok(n) = part.parse::<usize>() {
                if n >= 1 && n <= q.options.len() {
                    return q.options[n - 1].label.clone();
                }
            }
            q.options
                .iter()
                .find(|o| o.label.eq_ignore_ascii_case(part))
                .map(|o| o.label.clone())
                .unwrap_or_else(|| part.to_string())
        })
        .collect();
    labels.join(", ")
}

pub fn continuation(questions: &[AgentQuestion], text: &str, sender: Option<&str>) -> String {
    let answers = answers_from_text(questions, text);
    let parts: Vec<String> = answers
        .into_iter()
        .map(|(q, a)| format!("\"{q}\"=\"{a}\""))
        .collect();
    let who = sender
        .map(|s| format!("{s} answered"))
        .unwrap_or_else(|| "The user answered".into());
    format!("{who} your questions: {}. Continue with those answers.", parts.join(", "))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn question_cards(questions: &[AgentQuestion]) -> Value {
    let single = if questions.len() == 1 && questions[0].multiple != Some(true) {
        Some(&questions[0])
    } else {
        None
    };
    let mut widgets: Vec<Value> = questions
        .iter()
        .map(|q| {
            let opts = q
                .options
                .iter()
                .enumerate()
                .map(|(i, o)| {
                    let desc = o
                        .description
                        .as_ref()
                        .map(|d| format!(" — {}", esc(d)))
                        .unwrap_or_default();
                    format!("{}. <b>{}</b>{desc}", i + 1, esc(&o.label))
                })
                .collect::<Vec<_>>()
                .join("<br>");
            json!({
                "textParagraph": {
                    "text": format!("<b>{}</b><br>{opts}", esc(&q.question))
                }
            })
        })
        .collect();
    if let Some(q) = single {
        widgets.push(json!({
            "buttonList": {
                "buttons": q.options.iter().map(|o| json!({
                    "text": o.label.chars().take(50).collect::<String>(),
                    "onClick": {
                        "action": {
                            "function": "answerQuestion",
                            "parameters": [{ "key": "answer", "value": o.label }]
                        }
                    }
                })).collect::<Vec<_>>()
            }
        }));
    }
    json!([{
        "cardId": "agent-question",
        "card": {
            "header": {
                "title": questions.first().map(|q| q.header.as_str()).unwrap_or("Question"),
                "subtitle": "The agent is waiting for an answer"
            },
            "sections": [{ "widgets": widgets }]
        }
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_maps_choice() {
        let qs = normalize_questions(&json!([{
            "header": "H",
            "question": "Pick?",
            "options": [{"label": "A"}, {"label": "B"}]
        }]));
        let text = continuation(&qs, "1", Some("Nahuel"));
        assert!(text.contains("Nahuel answered"));
        assert!(text.contains("\"Pick?\"=\"A\""));
    }
}
