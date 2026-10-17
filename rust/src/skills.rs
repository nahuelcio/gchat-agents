use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::settings::Persona;

static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();

pub fn set_dirs(dirs: Vec<PathBuf>) {
    let _ = DIRS.set(dirs);
}

fn dirs() -> Vec<PathBuf> {
    DIRS.get().cloned().unwrap_or_else(|| vec![PathBuf::from("data/skills"), PathBuf::from("skills")])
}

#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub mcps: Vec<String>,
    pub body: String,
}

pub fn parse(raw: &str) -> Skill {
    let raw = raw.trim_start_matches('\u{feff}');
    let (front, body) = match raw.strip_prefix("---") {
        Some(rest) => match rest.split_once("\n---") {
            Some((front, body)) => (front, body.trim_start_matches(['\r', '\n'])),
            None => ("", raw),
        },
        None => ("", raw),
    };
    let field = |key: &str| {
        front
            .lines()
            .find_map(|l| l.trim().strip_prefix(&format!("{key}:")).map(|v| v.trim().to_string()))
            .unwrap_or_default()
    };
    let mcps = field("mcps")
        .trim_matches(['[', ']'])
        .split(',')
        .map(|m| m.trim().trim_matches(['"', '\'']).to_string())
        .filter(|m| !m.is_empty())
        .collect();
    Skill { name: field("name"), description: field("description"), mcps, body: body.trim().to_string() }
}

pub fn load(name: &str) -> Option<Skill> {
    if name.is_empty() || name.contains(['/', '\\', '.']) {
        return None;
    }
    dirs().iter().find_map(|d| load_from(d, name))
}

fn load_from(dir: &Path, name: &str) -> Option<Skill> {
    let raw = std::fs::read_to_string(dir.join(name).join("SKILL.md")).ok()?;
    let mut skill = parse(&raw);
    if skill.name.is_empty() {
        skill.name = name.to_string();
    }
    Some(skill)
}

pub fn available() -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    for dir in dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if out.iter().all(|s| s.name != name) {
                if let Some(s) = load_from(&dir, &name) {
                    out.push(s);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn instructions(persona: &Persona) -> String {
    persona
        .skills
        .iter()
        .filter_map(|n| load(n))
        .map(|s| format!("## Skill: {}\n{}", s.name, s.body))
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn mcps(persona: &Persona) -> Vec<String> {
    let mut out = persona.mcps.clone();
    for s in persona.skills.iter().filter_map(|n| load(n)) {
        for m in s.mcps {
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_frontmatter_and_body() {
        let s = parse("---\nname: finanzas\ndescription: cierres\nmcps: [google-drive]\n---\n\nNo inventar cifras.\n");
        assert_eq!(s.name, "finanzas");
        assert_eq!(s.mcps, vec!["google-drive"]);
        assert_eq!(s.body, "No inventar cifras.");
        assert_eq!(parse("solo texto").body, "solo texto");
    }

    #[test]
    fn persona_preamble_carries_the_skill_and_its_mcps() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("finanzas")).unwrap();
        std::fs::write(dir.path().join("finanzas/SKILL.md"), "---\nname: finanzas\nmcps: [google-drive]\n---\nNo inventar cifras.").unwrap();
        set_dirs(vec![dir.path().to_path_buf()]);
        let p = Persona { name: "fin".into(), prompt: "F".into(), driver: None, model: None, agent: None, listen: None, respond_to: None, skills: vec!["finanzas".into()], mcps: vec![] };
        assert!(crate::personas::persona_preamble(&p, std::slice::from_ref(&p)).contains("## Skill: finanzas\nNo inventar cifras."));
        assert_eq!(mcps(&p), vec!["google-drive"]);
    }

    #[test]
    fn persona_gets_skill_text_and_its_mcps() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("finanzas")).unwrap();
        std::fs::write(dir.path().join("finanzas/SKILL.md"), "---\nname: finanzas\nmcps: google-drive\n---\nMontos como numeros.").unwrap();
        let found = load_from(dir.path(), "finanzas").unwrap();
        assert_eq!(found.mcps, vec!["google-drive"]);
        assert!(load("../etc").is_none());
    }
}
