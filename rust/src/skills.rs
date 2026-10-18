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

pub(crate) fn load_from(dir: &Path, name: &str) -> Option<Skill> {
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

pub fn render(skill: &Skill) -> String {
    let mcps = if skill.mcps.is_empty() { String::new() } else { format!("mcps: [{}]\n", skill.mcps.join(", ")) };
    format!("---\nname: {}\ndescription: {}\n{mcps}---\n\n{}\n", skill.name, skill.description.replace('\n', " "), skill.body.trim())
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn save(dir: &Path, skill: &Skill) -> Result<(), String> {
    if !valid_name(&skill.name) {
        return Err("skill name must be lowercase letters, digits or -".into());
    }
    let folder = dir.join(&skill.name);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    std::fs::write(folder.join("SKILL.md"), render(skill)).map_err(|e| e.to_string())
}

pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("bad skill name".into());
    }
    std::fs::remove_dir_all(dir.join(name)).map_err(|e| e.to_string())
}

pub fn writable_dir() -> PathBuf {
    dirs().into_iter().next().unwrap_or_else(|| PathBuf::from("data/skills"))
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
    fn saved_skills_read_back_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let skill = Skill { name: "ventas".into(), description: "Precios y planes".into(), mcps: vec!["google-drive".into()], body: "Responde con precios.".into() };
        save(dir.path(), &skill).unwrap();
        assert_eq!(load_from(dir.path(), "ventas").unwrap(), skill);
        assert!(save(dir.path(), &Skill { name: "../x".into(), ..skill.clone() }).is_err());
        delete(dir.path(), "ventas").unwrap();
        assert!(load_from(dir.path(), "ventas").is_none());
    }

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
        let p = Persona { name: "fin".into(), prompt: "F".into(), driver: None, model: None, agent: None, listen: None, respond_to: None, skills: vec!["finanzas".into()], mcps: vec![], delegates: vec![] };
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
