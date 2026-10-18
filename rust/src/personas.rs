use regex::Regex;

use crate::session::{RoomEntry, RoomMember};
use crate::settings::Persona;

pub const BOT_NAME: &str = "Switchi";
pub const PASS: &str = "PASS";
pub const MAX_HOPS: usize = 3;
pub const MAX_DIALOGUE_HOPS: usize = 6;
pub const MAX_INTERJECTIONS: usize = 2;

pub fn room_prompt(text: &str) -> String {
    format!("[Room message, not addressed to you. Reply with exactly {PASS} unless you have something genuinely useful to add.]\n{text}")
}

pub fn is_pass(reply: &str) -> bool {
    let cleaned: String = reply
        .trim()
        .chars()
        .filter(|c| !matches!(c, '.' | '*' | '`'))
        .collect();
    cleaned == PASS || reply.trim().is_empty()
}

static STOPPED: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);

fn stopped() -> std::sync::MutexGuard<'static, Option<std::collections::HashSet<String>>> {
    let mut g = STOPPED.lock().unwrap();
    if g.is_none() {
        *g = Some(std::collections::HashSet::new());
    }
    g
}

pub fn request_stop(thread_key: &str) {
    stopped().as_mut().unwrap().insert(thread_key.to_string());
}

pub fn take_stop(thread_key: &str) -> bool {
    stopped().as_mut().unwrap().remove(thread_key)
}

fn mention_boundary_ok(text: &str, end: usize) -> bool {
    match text[end..].chars().next() {
        None => true,
        Some(c) => !(c.is_alphanumeric() || c == '-' || c == '_'),
    }
}

fn find_at_mention(text: &str, name: &str) -> Option<usize> {
    let lower = text.to_lowercase();
    let needle = format!("@{}", name.to_lowercase());
    let mut start = 0;
    while let Some(rel) = lower[start..].find(&needle) {
        let at = start + rel;
        let before_ok = at == 0
            || !text[..at]
                .chars()
                .next_back()
                .map(|c| c.is_alphanumeric() || c == '_' || c == '@')
                .unwrap_or(false);
        let end = at + needle.len();
        if before_ok && mention_boundary_ok(text, end) {
            return Some(at);
        }
        start = at + 1;
    }
    None
}

fn find_bare_name(text: &str, name: &str) -> Option<usize> {
    let lower = text.to_lowercase();
    let needle = name.to_lowercase();
    let mut start = 0;
    while let Some(rel) = lower[start..].find(&needle) {
        let at = start + rel;
        let before_ok = at == 0
            || !text[..at]
                .chars()
                .next_back()
                .map(|c| c.is_alphanumeric() || c == '_' || c == '@')
                .unwrap_or(false);
        let end = at + needle.len();
        if before_ok && mention_boundary_ok(text, end) {
            return Some(at);
        }
        start = at + 1;
    }
    None
}

pub fn mentioned_personas<'a>(text: &str, personas: &'a [Persona]) -> Vec<&'a Persona> {
    let mut found: Vec<(usize, &Persona)> = Vec::new();
    for p in personas {
        if let Some(at) = find_at_mention(text, &p.name) {
            found.push((at, p));
        }
    }
    found.sort_by_key(|(at, _)| *at);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (_, p) in found {
        let key = p.name.to_lowercase();
        if seen.insert(key) {
            out.push(p);
        }
    }
    out
}

pub fn named_personas<'a>(text: &str, personas: &'a [Persona]) -> Vec<&'a Persona> {
    let mut found: Vec<(usize, &Persona)> = Vec::new();
    for p in personas {
        if let Some(at) = find_bare_name(text, &p.name) {
            found.push((at, p));
        }
    }
    found.sort_by_key(|(at, _)| *at);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (_, p) in found {
        if seen.insert(p.name.to_lowercase()) {
            out.push(p);
        }
    }
    out
}

fn dialogue_hint(text: &str) -> bool {
    Regex::new(r"(?i)\b(habl[aeá]|talk\s+to|talk\s+with|ask|pregunt|discut|debate|llam[ae]|ping|entre\s+ustedes|coordina)\b")
        .unwrap()
        .is_match(text)
}

fn consult_hint(text: &str) -> bool {
    Regex::new(r"(?i)\b(opin|qué\s+opinas|what\s+do\s+you\s+think|think\s+about|think\s+of|pens[aáe]|parecer)\b")
        .unwrap()
        .is_match(text)
}

pub fn addressed_personas<'a>(text: &str, personas: &'a [Persona]) -> Vec<&'a Persona> {
    let at = mentioned_personas(text, personas);
    let named = named_personas(text, personas);
    if !at.is_empty() {
        let seen: std::collections::HashSet<_> = at.iter().map(|p| p.name.to_lowercase()).collect();
        let mut out = at;
        for p in named {
            if !seen.contains(&p.name.to_lowercase()) {
                out.push(p);
            }
        }
        return out;
    }
    if named.is_empty() {
        return vec![];
    }
    if dialogue_hint(text) {
        named
    } else {
        vec![]
    }
}

pub fn dialogue_open(said: &str, peers: &[&Persona]) -> String {
    let names = peers.iter().map(|p| format!("@{}", p.name)).collect::<Vec<_>>().join(", ");
    format!(
        "[Discussion with {names}] You are talking with the other agents, not only answering the human. \
Give your take, then write @name when you want one of them to respond. \
Write @{BOT_NAME} to bring the main agent back in. \
If you have nothing to add after someone speaks, reply exactly {PASS}.\n\n{said}"
    )
}

pub fn dialogue_pass(from: &str, reply: &str) -> String {
    format!(
        "[Discussion] @{from} just said:\n{reply}\n\n\
Respond to them. Write @{from} if you want them to continue. \
Write @{BOT_NAME} to bring the main agent back in. \
Reply exactly {PASS} if you agree and have nothing useful to add."
    )
}

pub fn consult_open(said: &str, host_reply: &str) -> String {
    format!(
        "[Consultation] {BOT_NAME} said:\n{host_reply}\n\n\
Human: {said}\n\n\
Give your take. Write @{BOT_NAME} when you want the main agent to continue. \
Reply exactly {PASS} if you have nothing useful to add."
    )
}

pub fn mentions_bot(text: &str) -> bool {
    find_at_mention(text, BOT_NAME).is_some()
        || find_bare_name(text, BOT_NAME).is_some()
        || find_at_mention(text, "switchboard").is_some()
        || find_bare_name(text, "switchboard").is_some()
}

pub fn consult_topics<'a>(text: &str, personas: &'a [Persona]) -> Vec<&'a Persona> {
    if !consult_hint(text) {
        return vec![];
    }
    named_personas(text, personas)
}

pub fn strip_self_prefix(reply: &str, p: &Persona) -> String {
    let trimmed = reply.trim_start();
    let prefix = format!("@{}", p.name);
    let lower = trimmed.to_lowercase();
    if !lower.starts_with(&prefix.to_lowercase())
        && !lower.trim_start_matches('*').starts_with(&prefix.to_lowercase())
    {
        return reply.to_string();
    }
    let mut s = trimmed.trim_start_matches(['*', '_']);
    if let Some(rest) = s.get(prefix.len()..) {
        s = rest.trim_start_matches(['*', '_', ' ', '\t', ':']);
        if let Some(r) = s.strip_prefix('→').or_else(|| s.strip_prefix("->")) {
            s = r.trim_start();
            if s.starts_with('@') {
                if let Some(space) = s.find(|c: char| c.is_whitespace() || c == ':') {
                    s = s[space..].trim_start_matches([':', ' ', '\t']);
                }
            }
        }
        s.to_string()
    } else {
        reply.to_string()
    }
}

const ROOM_KEEP: usize = 30;
const ROOM_CHARS: usize = 1500;

pub fn room_append(log: Option<&[RoomEntry]>, author: &str, text: &str) -> Vec<RoomEntry> {
    let list = log.unwrap_or(&[]);
    let n = list.last().map(|e| e.n).unwrap_or(0) + 1;
    let t = if text.len() > ROOM_CHARS {
        format!("{}…", &text[..ROOM_CHARS])
    } else {
        text.to_string()
    };
    let mut next: Vec<_> = list.to_vec();
    next.push(RoomEntry {
        n,
        author: author.to_string(),
        text: t,
    });
    if next.len() > ROOM_KEEP {
        next = next[next.len() - ROOM_KEEP..].to_vec();
    }
    next
}

pub fn room_catch_up(log: Option<&[RoomEntry]>, who: &str, seen: Option<u64>, before: u64) -> String {
    let missed: Vec<_> = log
        .unwrap_or(&[])
        .iter()
        .filter(|e| e.n > seen.unwrap_or(0) && e.n < before && e.author != who)
        .collect();
    if missed.is_empty() {
        return String::new();
    }
    let lines = missed
        .iter()
        .map(|e| format!("{}: {}", e.author, e.text))
        .collect::<Vec<_>>()
        .join("\n");
    format!("Messages in this chat since your last turn (for context):\n{lines}\n\n---\n\n")
}

fn roster_preamble(p: &Persona, all: &[Persona]) -> String {
    let others: Vec<_> = all
        .iter()
        .filter(|o| o.name != p.name)
        .map(|o| format!("@{}", o.name))
        .collect();
    let mut parts = vec![
        format!("You are @{}, one of several agents in a shared team chat.", p.name),
        p.prompt.trim().to_string(),
    ];
    if !others.is_empty() {
        parts.push(format!(
            "Other agents here: {}. Writing @name in your reply makes that agent answer right away, so only write @name when you are asking them something now; to just refer to them, write their name without the @.",
            others.join(", ")
        ));
    }
    parts.push(format!(
        "People address you with @{}. Messages from other agents start with their @name.",
        p.name
    ));
    parts.push(format!(
        "You see every message in the chat. When one is not for you and you have nothing useful to add, reply exactly {PASS}."
    ));
    parts.join("\n\n")
}

pub fn persona_preamble(p: &Persona, all: &[Persona]) -> String {
    let skills = crate::skills::instructions(p);
    let base = roster_preamble(p, all);
    if skills.is_empty() {
        base
    } else {
        format!("{base}\n\n{skills}")
    }
}

pub fn asked_personas<'a>(reply: &str, personas: &'a [Persona]) -> Vec<&'a Persona> {
    let mut sentences = Vec::new();
    let mut start = 0;
    for (i, c) in reply.char_indices() {
        if matches!(c, '.' | '!' | '?' | '\n') {
            let end = i + c.len_utf8();
            let s = reply[start..end].trim();
            if !s.is_empty() {
                sentences.push(s);
            }
            start = end;
        }
    }
    let tail = reply[start..].trim();
    if !tail.is_empty() {
        sentences.push(tail);
    }
    mentioned_personas(reply, personas)
        .into_iter()
        .filter(|p| {
            sentences.iter().any(|s| {
                if mentioned_personas(s, std::slice::from_ref(*p)).is_empty() {
                    return false;
                }
                let cleaned = s.trim_start_matches(['*', '_']);
                let starts = cleaned
                    .to_lowercase()
                    .starts_with(&format!("@{}", p.name.to_lowercase()));
                let ends_q = s.trim_end_matches(['*', '_', ')', ' ', '\t']).ends_with('?');
                (cleaned.starts_with('@') && starts) || ends_q
            })
        })
        .collect()
}

pub fn active_personas(all: &[Persona], members: Option<&[RoomMember]>) -> Vec<Persona> {
    let Some(members) = members else {
        return all.to_vec();
    };
    let in_room: std::collections::HashSet<_> = members
        .iter()
        .filter_map(|m| match m {
            RoomMember::Agent { persona, .. } => Some(persona.to_lowercase()),
            _ => None,
        })
        .collect();
    all.iter()
        .filter(|p| in_room.contains(&p.name.to_lowercase()))
        .cloned()
        .collect()
}

pub fn with_human(members: &[RoomMember], name: &str) -> Vec<RoomMember> {
    let id = format!("human:{}", name.trim().to_lowercase());
    if members.iter().any(|m| match m {
        RoomMember::Human { id: mid, .. } => mid == &id,
        _ => false,
    }) {
        return members.to_vec();
    }
    let mut next = members.to_vec();
    next.push(RoomMember::Human {
        id,
        name: name.trim().to_string(),
        joined_at: chrono::Utc::now().to_rfc3339(),
    });
    next
}

pub fn with_agent(members: &[RoomMember], persona: &str) -> Vec<RoomMember> {
    let id = format!("agent:{}", persona.to_lowercase());
    if members.iter().any(|m| match m {
        RoomMember::Agent { id: mid, .. } => mid == &id,
        _ => false,
    }) {
        return members.to_vec();
    }
    let mut next = members.to_vec();
    next.push(RoomMember::Agent {
        id,
        persona: persona.to_string(),
        joined_at: chrono::Utc::now().to_rfc3339(),
    });
    next
}

pub fn add_hint(text: &str) -> bool {
    Regex::new(r"(?i)\b(agreg|añad|sum[aá]|invit|tra[eé]|met[eé]|volv[eé]|add|invite|bring)\w*")
        .unwrap()
        .is_match(text)
}

pub fn host_preamble(personas: &[Persona], host_prompt: Option<&str>) -> String {
    let roster = personas
        .iter()
        .map(|p| {
            let tip = p.prompt.trim();
            if tip.is_empty() {
                format!("@{}", p.name)
            } else {
                let short: String = tip.chars().take(120).collect();
                format!("@{} ({short})", p.name)
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    let agents = if roster.is_empty() {
        "No other agents are in this room yet.".to_string()
    } else {
        format!("Agents in this room: {roster}.")
    };
    let base = format!(
        "You are {BOT_NAME}, the host of this shared chat. People talk to you; other agents are members of the room too.\n\
{agents}\n\
When a message is about one of them (even named without @), or their opinion would help, ask them: start a sentence with @name or end it with a question mark. Otherwise just answer yourself.\n\
Every agent here reads every message and answers on its own when it fits. If the message clearly belongs to them and you have nothing to add, reply exactly {PASS}. If it fits none of them, say so and suggest who should take it.\n\
If a person asks to add an agent back to the room, use the invite_agent tool. Removed agents cannot be called until someone adds them again."
    );
    match host_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        Some(extra) => format!("{base}\n\n{extra}"),
        None => base,
    }
}

pub fn roster_update(before: Option<&[String]>, now: &[String]) -> String {
    let Some(before) = before else {
        return String::new();
    };
    let was: std::collections::HashSet<_> = before.iter().map(|n| n.to_lowercase()).collect();
    let is: std::collections::HashSet<_> = now.iter().map(|n| n.to_lowercase()).collect();
    let mut changes = Vec::new();
    for n in now {
        if !was.contains(&n.to_lowercase()) {
            changes.push(format!("@{n} joined"));
        }
    }
    for n in before {
        if !is.contains(&n.to_lowercase()) {
            changes.push(format!("@{n} left (do not call them)"));
        }
    }
    if changes.is_empty() {
        String::new()
    } else {
        format!("\n\n[Room update: {}]", changes.join(", "))
    }
}

pub fn human_asked_for(room: Option<&[RoomEntry]>, name: &str) -> bool {
    let last = room
        .unwrap_or(&[])
        .iter()
        .rev()
        .find(|e| !e.author.starts_with('@') && e.author != BOT_NAME);
    let Some(last) = last else {
        return false;
    };
    find_at_mention(&last.text, name).is_some() || find_bare_name(&last.text, name).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str) -> Persona {
        Persona {
            name: name.into(),
            prompt: "x".into(),
            driver: None,
            model: None,
            agent: None,
            listen: None,
            respond_to: None,
            skills: vec![],
            mcps: vec![],
            delegates: vec![],
        }
    }

    #[test]
    fn addresses_mentions() {
        let all = vec![p("qa"), p("dev")];
        let got = addressed_personas("hey @qa look", &all);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "qa");
    }

    #[test]
    fn hop_asked() {
        let all = vec![p("qa"), p("dev")];
        let asked = asked_personas("@qa can you check this?", &all);
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].name, "qa");
    }

    #[test]
    fn pass_detection() {
        assert!(is_pass("PASS"));
        assert!(is_pass("**PASS**"));
        assert!(is_pass(""));
        assert!(!is_pass("PASS and more"));
    }
}
