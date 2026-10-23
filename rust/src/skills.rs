use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::settings::Persona;

static DIRS: RwLock<Option<Vec<PathBuf>>> = RwLock::new(None);

#[derive(rust_embed::Embed)]
#[folder = "../skills"]
struct Bundled;

#[derive(rust_embed::Embed)]
#[folder = "../.agents/skills"]
struct Managed;

pub fn extract_bundled(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_embedded::<Managed>(dir)?;
    write_embedded::<Bundled>(dir)
}

fn write_embedded<E: rust_embed::Embed>(dir: &Path) -> Result<(), String> {
    for rel in E::iter() {
        let Some(file) = E::get(&rel) else { continue };
        let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, file.data.as_ref()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// data/skills = own (writable), .agents/skills = managed by skills.sh, skills = vendored, bundled-skills = shipped.
pub fn dirs_for(data_dir: &Path) -> Vec<PathBuf> {
    vec![
        data_dir.join("skills"),
        PathBuf::from(".agents/skills"),
        PathBuf::from("skills"),
        data_dir.join("bundled-skills"),
    ]
}

pub fn set_dirs(dirs: Vec<PathBuf>) {
    *DIRS.write().unwrap() = Some(dirs);
}

fn dirs() -> Vec<PathBuf> {
    DIRS.read()
        .unwrap()
        .clone()
        .unwrap_or_else(|| vec![PathBuf::from("data/skills"), PathBuf::from("skills")])
}

/// Bundled resource under the skill folder (references/, scripts/, assets/).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SkillFile {
    /// Relative path inside the skill dir, e.g. `references/sla.md`.
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub mcps: Vec<String>,
    pub body: String,
    pub files: Vec<SkillFile>,
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
    Skill {
        name: field("name"),
        description: field("description"),
        mcps,
        body: body.trim().to_string(),
        files: vec![],
    }
}

/// One naming rule for reading an installed skill: non-empty, no path
/// separators, no dot caveat. Keep load(), skill_dir() and the skill_search
/// filter aligned so the catalog never advertises a skill load() rejects.
pub fn loadable_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\', '.'])
}

pub fn load(name: &str) -> Option<Skill> {
    if !loadable_name(name) {
        return None;
    }
    dirs().iter().find_map(|d| load_from(d, name))
}

pub(crate) fn load_from(dir: &Path, name: &str) -> Option<Skill> {
    let folder = dir.join(name);
    let raw = std::fs::read_to_string(folder.join("SKILL.md")).ok()?;
    let mut skill = parse(&raw);
    if skill.name.is_empty() {
        skill.name = name.to_string();
    }
    skill.files = list_files(&folder);
    Some(skill)
}

/// Relative paths allowed as bundled skill resources.
pub fn valid_file_path(path: &str) -> bool {
    let path = path.trim().replace('\\', "/");
    if path.is_empty() || path.len() > 200 || path.contains("..") || path.starts_with('/') {
        return false;
    }
    let Some((top, rest)) = path.split_once('/') else {
        return false;
    };
    if !matches!(top, "references" | "scripts" | "assets") || rest.is_empty() {
        return false;
    }
    rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'))
}

fn list_files(folder: &Path) -> Vec<SkillFile> {
    let mut out = Vec::new();
    for root in ["references", "scripts", "assets"] {
        walk_files(&folder.join(root), root, &mut out);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk_files(dir: &Path, prefix: &str, out: &mut Vec<SkillFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let rel = format!("{prefix}/{name}");
        if e.path().is_dir() {
            walk_files(&e.path(), &rel, out);
            continue;
        }
        if !valid_file_path(&rel) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.len() > 200_000 {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(e.path()) {
            out.push(SkillFile { path: rel, content });
        }
    }
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
    format!(
        "---\nname: {}\ndescription: {}\n{mcps}---\n\n{}\n",
        skill.name,
        skill.description.replace('\n', " "),
        skill.body.trim()
    )
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn save(dir: &Path, skill: &Skill) -> Result<(), String> {
    if !valid_name(&skill.name) {
        return Err("skill name must be lowercase letters, digits or -".into());
    }
    for f in &skill.files {
        if !valid_file_path(&f.path) {
            return Err(format!("bad skill file path: {}", f.path));
        }
        if f.content.len() > 200_000 {
            return Err(format!("{} is too large", f.path));
        }
    }
    let folder = dir.join(&skill.name);
    // Clear old bundles so deleted files disappear.
    for root in ["references", "scripts", "assets"] {
        let p = folder.join(root);
        if p.exists() {
            std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        }
    }
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    std::fs::write(folder.join("SKILL.md"), render(skill)).map_err(|e| e.to_string())?;
    for f in &skill.files {
        let path = folder.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, &f.content).map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Absolute folder for a skill if it exists on disk (for agents to read bundles).
pub fn skill_dir(name: &str) -> Option<PathBuf> {
    if !loadable_name(name) {
        return None;
    }
    dirs().into_iter().map(|d| d.join(name)).find(|p| p.join("SKILL.md").is_file())
}

/// Tests calling set_dirs mutate process-global state; serialize them.
#[cfg(test)]
pub(crate) static TEST_DIRS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Compact catalog for the preamble: name + description per attached and
/// loadable skill. Attached-but-unresolvable names are dropped, matching the
/// old filter_map behavior, so a host persona with no loadable skills keeps
/// rendering nothing. Empty string when nothing resolves.
pub fn instructions(persona: &Persona) -> String {
    let mut out = String::new();
    for s in persona.skills.iter().filter_map(|n| load(n)) {
        if out.is_empty() {
            out.push_str(
                "## Available skills - a task that matches one needs its full instructions: call skill_load before acting; use skill_search when unsure which fits",
            );
        }
        out.push_str(&format!("\n- {}: {}", s.name, s.description.replace('\n', " ")));
    }
    out
}

pub fn mcps(persona: &Persona) -> Vec<String> {
    let mut out = persona.mcps.clone();
    for s in persona.skills.iter().filter_map(|n| load(n)) {
        for m in s.mcps {
            if !out.contains(&m) {
                out.push(m);
            }
        }
        // Scripts need the coding tool pack to run node/python.
        if s.files.iter().any(|f| f.path.starts_with("scripts/")) && !out.iter().any(|m| m == "coding") {
            out.push("coding".into());
        }
    }
    // Skill tools ride along only when the persona already runs under a
    // whitelist (explicit mcps or skill frontmatter). An empty list stays
    // empty: to the drivers, an empty group list means ALL tools, already
    // including the skill pair.
    if !out.is_empty() && !out.iter().any(|m| m == "skills") {
        out.push("skills".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_skills_extract_with_their_files() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("bundled");
        extract_bundled(&out).unwrap();
        let skill = load_from(&out, "artifacts").unwrap();
        assert_eq!(skill.name, "artifacts");
        assert!(skill.files.iter().any(|f| f.path == "references/walkthrough.html"));
        assert!(load_from(&out, "skill-creator").is_some());
        let tdd = load_from(&out, "tdd").unwrap();
        assert!(tdd.description.contains("Test-driven"));
    }

    #[test]
    fn saved_skills_read_back_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let skill = Skill {
            name: "ventas".into(),
            description: "Precios y planes".into(),
            mcps: vec!["google-drive".into()],
            body: "Responde con precios.".into(),
            files: vec![SkillFile {
                path: "references/discounts.md".into(),
                content: "VIP: 10%\n".into(),
            }],
        };
        save(dir.path(), &skill).unwrap();
        assert_eq!(load_from(dir.path(), "ventas").unwrap(), skill);
        assert!(dir.path().join("ventas/references/discounts.md").is_file());
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
        let _dirs = super::TEST_DIRS_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("finanzas/references")).unwrap();
        std::fs::write(dir.path().join("finanzas/SKILL.md"), "---\nname: finanzas\nmcps: [google-drive]\n---\nNo inventar cifras.").unwrap();
        std::fs::write(dir.path().join("finanzas/references/rules.md"), "rule A").unwrap();
        set_dirs(vec![dir.path().to_path_buf()]);
        let p = Persona {
            name: "fin".into(),
            prompt: "F".into(),
            driver: None,
            model: None,
            agent: None,
            listen: None,
            respond_to: None,
            skills: vec!["finanzas".into()],
            mcps: vec![],
            delegates: vec![],
            avatar: None,
        };
        let preamble = crate::personas::persona_preamble(&p, std::slice::from_ref(&p));
        assert!(preamble.contains("## Available skills"));
        assert!(preamble.contains("- finanzas:"));
        assert!(!preamble.contains("No inventar cifras."));
        assert!(!preamble.contains("references/rules.md"));
        let got = mcps(&p);
        assert!(got.contains(&"google-drive".into()));
        assert!(got.contains(&"skills".into()));
    }

    #[test]
    fn unresolved_attached_skill_is_dropped_from_catalog() {
        let p = Persona {
            name: "x".into(),
            prompt: "p".into(),
            driver: None,
            model: None,
            agent: None,
            listen: None,
            respond_to: None,
            skills: vec!["ghost".into()],
            mcps: vec![],
            delegates: vec![],
            avatar: None,
        };
        assert!(instructions(&p).is_empty());
    }

    #[test]
    fn skills_group_only_rides_a_whitelist() {
        // Ghost skill + no groups: empty stays empty (all-tools, skill pair
        // included). Persona mcps: the pair joins the whitelist.
        let ghost = Persona {
            name: "x".into(),
            prompt: "p".into(),
            driver: None,
            model: None,
            agent: None,
            listen: None,
            respond_to: None,
            skills: vec!["ghost".into()],
            mcps: vec![],
            delegates: vec![],
            avatar: None,
        };
        assert!(mcps(&ghost).is_empty());
        let p = Persona {
            mcps: vec!["google-drive".into()],
            skills: vec!["ghost".into()],
            ..ghost.clone()
        };
        assert_eq!(mcps(&p), vec!["google-drive".to_string(), "skills".to_string()]);
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

    #[test]
    fn rejects_bad_bundle_paths() {
        assert!(!valid_file_path("../x"));
        assert!(!valid_file_path("SKILL.md"));
        assert!(valid_file_path("references/a.md"));
        assert!(valid_file_path("scripts/make.py"));
        assert!(valid_file_path("assets/logo.svg"));
    }

    #[test]
    fn scripts_pull_in_coding_and_show_run_hints() {
        let _dirs = super::TEST_DIRS_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let skill = Skill {
            name: "pdf".into(),
            description: "Format PDFs".into(),
            mcps: vec![],
            body: "Use the script.".into(),
            files: vec![SkillFile {
                path: "scripts/format-pdf.js".into(),
                content: "console.log('ok')\n".into(),
            }],
        };
        save(dir.path(), &skill).unwrap();
        set_dirs(vec![dir.path().to_path_buf()]);
        let p = Persona {
            name: "x".into(),
            prompt: "p".into(),
            driver: None,
            model: None,
            agent: None,
            listen: None,
            respond_to: None,
            skills: vec!["pdf".into()],
            mcps: vec![],
            delegates: vec![],
            avatar: None,
        };
        assert!(mcps(&p).contains(&"coding".into()));
        assert!(mcps(&p).contains(&"skills".into()));
        let text = instructions(&p);
        assert!(text.contains("- pdf: Format PDFs"));
        assert!(!text.contains("Use the script."));
        assert!(!text.contains("format-pdf.js"));
    }
}
