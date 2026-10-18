use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::skills;

pub struct Endpoints {
    pub api: String,
    pub raw: String,
}

impl Endpoints {
    pub fn github() -> Self {
        Self { api: "https://api.github.com".into(), raw: "https://raw.githubusercontent.com".into() }
    }
}

struct Query {
    owner: String,
    repo: String,
    rev: String,
    skill: Option<String>,
    prefix: Option<String>,
    file_url: Option<String>,
}

pub async fn install(source: &str, dir: &Path) -> Result<Vec<String>, String> {
    install_at(source, dir, &Endpoints::github()).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub name: String,
    pub skill_id: String,
    pub source: String,
    pub installs: u64,
}

/// Proxy search against skills.sh (no CORS from the browser).
/// `q` matches name/topic; optional `owner` scopes to a GitHub org/user.
/// skills.sh requires `q` ≥ 2 chars — if only owner is set we reuse the owner as q.
pub async fn search(q: &str, owner: Option<&str>, limit: u32) -> Result<Vec<SearchHit>, String> {
    let q = q.trim();
    let owner = owner.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let query = if q.chars().count() >= 2 {
        q.to_string()
    } else if let Some(ref o) = owner {
        if o.chars().count() >= 2 {
            o.clone()
        } else {
            return Ok(vec![]);
        }
    } else {
        return Ok(vec![]);
    };
    let limit = limit.clamp(1, 20);
    let limit_s = limit.to_string();
    let mut pairs: Vec<(&str, &str)> = vec![("q", query.as_str()), ("limit", limit_s.as_str())];
    if let Some(ref o) = owner {
        pairs.push(("owner", o.as_str()));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get("https://skills.sh/api/search")
        .query(&pairs)
        .header("user-agent", "switchboard")
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("could not reach skills.sh: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("skills.sh returned {status}"));
    }
    let data: Value = serde_json::from_str(&body).map_err(|e| format!("bad skills.sh response: {e}"))?;
    let skills = data.get("skills").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(skills
        .into_iter()
        .filter_map(|s| {
            let source = s.get("source")?.as_str()?.trim().to_string();
            let skill_id = s
                .get("skillId")
                .or_else(|| s.get("skill_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let name = s
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&skill_id)
                .trim()
                .to_string();
            if source.is_empty() || skill_id.is_empty() || source.contains("..") {
                return None;
            }
            let installs = s.get("installs").and_then(|v| v.as_u64()).unwrap_or(0);
            Some(SearchHit {
                name: if name.is_empty() { skill_id.clone() } else { name },
                skill_id,
                source,
                installs,
            })
        })
        .collect())
}

pub async fn install_at(source: &str, dir: &Path, ends: &Endpoints) -> Result<Vec<String>, String> {
    let query = parse_source(source)?;
    let packs = if let Some(url) = &query.file_url {
        vec![SkillPack {
            skill_md_path: "SKILL.md".into(),
            skill_md: get_text(url).await?,
            files: vec![],
        }]
    } else {
        let tree_url = format!("{}/repos/{}/{}/git/trees/{}?recursive=1", ends.api.trim_end_matches('/'), query.owner, query.repo, query.rev);
        let tree = get_text(&tree_url).await?;
        let md_paths = skill_md_paths(&tree, query.skill.as_deref(), query.prefix.as_deref())?;
        let mut packs = Vec::new();
        for md_path in md_paths {
            let root = md_path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            let md_url = format!("{}/{}/{}/{}/{}", ends.raw.trim_end_matches('/'), query.owner, query.repo, query.rev, md_path);
            let skill_md = get_text(&md_url).await?;
            let bundle_paths = bundle_paths(&tree, root);
            let mut files = Vec::new();
            for path in bundle_paths {
                let url = format!("{}/{}/{}/{}/{}", ends.raw.trim_end_matches('/'), query.owner, query.repo, query.rev, path);
                let content = get_text(&url).await?;
                let rel = path.strip_prefix(&format!("{root}/")).unwrap_or(&path).to_string();
                if skills::valid_file_path(&rel) {
                    files.push(skills::SkillFile { path: rel, content });
                }
            }
            packs.push(SkillPack { skill_md_path: md_path, skill_md, files });
        }
        packs
    };
    let mut names = Vec::new();
    for pack in packs {
        let mut skill = skills::parse(&pack.skill_md);
        if skill.name.is_empty() {
            skill.name = pack.skill_md_path.rsplit('/').nth(1).unwrap_or("skill").to_string();
        }
        skill.name = slug(&skill.name);
        if skill.name.is_empty() || !skills::valid_name(&skill.name) {
            return Err(format!("could not use the skill name from {}", pack.skill_md_path));
        }
        skill.files = pack.files;
        let base = skill.name.clone();
        let mut i = 2u32;
        while names.iter().any(|n| n == &skill.name) {
            let suffix = format!("-{i}");
            let keep = 40usize.saturating_sub(suffix.len());
            skill.name = format!("{}{suffix}", base.chars().take(keep).collect::<String>());
            i += 1;
        }
        skills::save(dir, &skill)?;
        names.push(skill.name);
    }
    Ok(names)
}

struct SkillPack {
    skill_md_path: String,
    skill_md: String,
    files: Vec<skills::SkillFile>,
}

fn parse_source(raw: &str) -> Result<Query, String> {
    let mut skill = None;
    let mut tokens = Vec::new();
    let mut args = raw.split_whitespace().peekable();
    while let Some(tok) = args.next() {
        match tok {
            "npx" | "skills" | "add" | "-y" | "--yes" | "--copy" | "-g" | "--global" | "--all" | "-p" => {}
            "-s" | "--skill" => skill = args.next().map(|s| s.trim_matches('"').to_string()),
            "-a" | "--agent" => {
                args.next();
            }
            other if other.starts_with('-') => {}
            other => tokens.push(other.to_string()),
        }
    }
    let source = tokens.first().ok_or("paste owner/repo, owner/repo@skill, or a skills.sh link")?.trim();
    if let Some((repo, name)) = source.split_once('@') {
        if skill.is_none() && !name.is_empty() && !name.contains('/') {
            skill = Some(name.to_string());
        }
        return finish(repo, skill);
    }
    finish(source, skill)
}

fn finish(source: &str, skill: Option<String>) -> Result<Query, String> {
    let source = source.trim().trim_end_matches('/');
    if let Some(rest) = source.strip_prefix("https://raw.githubusercontent.com/").or_else(|| source.strip_prefix("http://raw.githubusercontent.com/")) {
        if !rest.contains("SKILL.md") {
            return Err("that raw link is not a SKILL.md".into());
        }
        return Ok(Query { owner: String::new(), repo: String::new(), rev: String::new(), skill: None, prefix: None, file_url: Some(format!("https://raw.githubusercontent.com/{rest}")) });
    }
    let (owner, repo, rev, prefix, skill) = if let Some(path) = strip_host(source, "skills.sh") {
        let mut parts = path.split('/').filter(|s| !s.is_empty());
        let owner = parts.next().unwrap_or("");
        let repo = parts.next().unwrap_or("");
        let named = parts.next().map(str::to_string).or(skill);
        (owner.to_string(), repo.to_string(), "HEAD".into(), None, named)
    } else if let Some(path) = strip_host(source, "github.com") {
        let mut parts = path.split('/').filter(|s| !s.is_empty());
        let owner = parts.next().unwrap_or("").to_string();
        let repo = parts.next().unwrap_or("").trim_end_matches(".git").to_string();
        let kind = parts.next();
        let (rev, prefix) = if matches!(kind, Some("tree" | "blob")) {
            let rev = parts.next().unwrap_or("HEAD").to_string();
            let rest: Vec<&str> = parts.collect();
            let prefix = if rest.is_empty() { None } else { Some(rest.join("/")) };
            (rev, prefix)
        } else {
            ("HEAD".into(), None)
        };
        (owner, repo, rev, prefix, skill)
    } else if let Some((owner, repo)) = source.split_once('/') {
        if source.starts_with('.') || source.contains(':') || owner.is_empty() || repo.is_empty() || repo.contains('/') {
            return Err("use owner/repo, owner/repo@skill, or a https://skills.sh or GitHub link".into());
        }
        (owner.to_string(), repo.trim_end_matches(".git").to_string(), "HEAD".into(), None, skill)
    } else {
        return Err("use owner/repo, owner/repo@skill, or a https://skills.sh or GitHub link".into());
    };
    if !is_slug_piece(&owner) || !is_slug_piece(&repo) {
        return Err("owner and repo can only contain letters, digits, . _ -".into());
    }
    if rev.contains("..") || prefix.as_deref().is_some_and(|p| p.contains("..")) {
        return Err("that path is not allowed".into());
    }
    Ok(Query { owner, repo, rev, skill, prefix, file_url: None })
}

fn strip_host<'a>(source: &'a str, host: &str) -> Option<&'a str> {
    let rest = source.strip_prefix("https://").or_else(|| source.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    Some(rest.strip_prefix(host)?.trim_start_matches('/'))
}

fn is_slug_piece(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn skill_md_paths(tree_json: &str, skill: Option<&str>, prefix: Option<&str>) -> Result<Vec<String>, String> {
    let value: serde_json::Value = serde_json::from_str(tree_json).map_err(|e| format!("GitHub tree was not JSON ({e})"))?;
    if value.get("truncated").and_then(|v| v.as_bool()) == Some(true) && skill.is_none() && prefix.is_none() {
        return Err("that repo is too big to list; pick one skill with owner/repo@skill".into());
    }
    let mut paths: Vec<String> = value
        .get("tree")
        .and_then(|v| v.as_array())
        .ok_or("GitHub did not list any files")?
        .iter()
        .filter_map(|n| {
            let path = n.get("path")?.as_str()?;
            if n.get("type").and_then(|t| t.as_str()) != Some("blob") || !path.ends_with("SKILL.md") {
                return None;
            }
            if let Some(prefix) = prefix {
                if prefix.ends_with("SKILL.md") {
                    if path != prefix {
                        return None;
                    }
                } else if path != format!("{prefix}/SKILL.md") && !path.starts_with(&format!("{prefix}/")) {
                    return None;
                }
            }
            if let Some(skill) = skill {
                let dir = path.rsplit('/').nth(1).unwrap_or("");
                if !dir.eq_ignore_ascii_case(skill) && slug(dir) != slug(skill) {
                    return None;
                }
            }
            Some(path.to_string())
        })
        .collect();
    paths.sort();
    if paths.is_empty() {
        return Err("no SKILL.md matched. Try owner/repo@skill-name".into());
    }
    if paths.len() > 8 && skill.is_none() && prefix.as_ref().is_none_or(|p| !p.ends_with("SKILL.md")) {
        return Err(format!("that repo has {} skills; install one with owner/repo@skill-name", paths.len()));
    }
    Ok(paths)
}

/// Files under `root/` in references/, scripts/, or assets/.
fn bundle_paths(tree_json: &str, root: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(tree_json) else {
        return vec![];
    };
    let prefix = if root.is_empty() { String::new() } else { format!("{root}/") };
    let mut paths: Vec<String> = value
        .get("tree")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|n| {
            let path = n.get("path")?.as_str()?;
            if n.get("type").and_then(|t| t.as_str()) != Some("blob") {
                return None;
            }
            let rel = path.strip_prefix(&prefix).unwrap_or(path);
            if !skills::valid_file_path(rel) {
                return None;
            }
            Some(path.to_string())
        })
        .collect();
    paths.sort();
    paths.truncate(40);
    paths
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(40).collect();
    out
}

async fn get_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let res = client.get(url).header("user-agent", "switchboard").header("accept", "application/vnd.github+json").send().await.map_err(|e| format!("could not reach GitHub: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GitHub returned {status}"));
    }
    if text.len() > 300_000 {
        return Err("that file is too large".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ways_people_paste_a_skill() {
        let q = parse_source("vercel-labs/agent-skills@frontend-design").unwrap();
        assert_eq!(q.owner, "vercel-labs");
        assert_eq!(q.repo, "agent-skills");
        assert_eq!(q.skill.as_deref(), Some("frontend-design"));
        let web = parse_source("https://skills.sh/vercel-labs/agent-skills/frontend-design").unwrap();
        assert_eq!(web.skill.as_deref(), Some("frontend-design"));
        let gh = parse_source("https://github.com/vercel-labs/agent-skills/tree/main/skills/frontend-design").unwrap();
        assert_eq!(gh.rev, "main");
        assert_eq!(gh.prefix.as_deref(), Some("skills/frontend-design"));
        let cmd = parse_source("npx skills add vercel-labs/agent-skills --skill frontend-design -y").unwrap();
        assert_eq!(cmd.skill.as_deref(), Some("frontend-design"));
        assert!(parse_source("../etc").is_err());
        assert!(parse_source("https://evil.example/x").is_err());
    }

    #[tokio::test]
    async fn installs_one_skill_from_a_listed_tree() {
        let dir = tempfile::tempdir().unwrap();
        let base = mock(&[
            (
                "/repos/acme/pack/git/trees/HEAD",
                r#"{"truncated":false,"tree":[
                  {"path":"skills/quotes/SKILL.md","type":"blob"},
                  {"path":"skills/quotes/references/tone.md","type":"blob"},
                  {"path":"README.md","type":"blob"}
                ]}"#,
            ),
            ("/acme/pack/HEAD/skills/quotes/SKILL.md", "---\nname: Quotes\ndescription: Short lines\n---\n\nBe brief. See references/tone.md.\n"),
            ("/acme/pack/HEAD/skills/quotes/references/tone.md", "Stay short.\n"),
        ])
        .await;
        let names = install_at("acme/pack@quotes", dir.path(), &Endpoints { api: base.clone(), raw: base }).await.unwrap();
        assert_eq!(names, vec!["quotes"]);
        let saved = skills::load_from(dir.path(), "quotes").unwrap();
        assert_eq!(saved.description, "Short lines");
        assert!(saved.body.contains("Be brief."));
        assert_eq!(saved.files.len(), 1);
        assert_eq!(saved.files[0].path, "references/tone.md");
        assert!(saved.files[0].content.contains("Stay short"));
    }

    async fn mock(routes: &[(&str, &str)]) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let routes: Vec<(String, String)> = routes.iter().map(|(p, b)| (p.to_string(), b.to_string())).collect();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 1024];
                    loop {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let req = String::from_utf8_lossy(&buf);
                    let path = req.split_whitespace().nth(1).unwrap_or("/");
                    let path = path.split('?').next().unwrap_or(path);
                    let body = routes.iter().find(|(p, _)| p == path).map(|(_, b)| b.as_str()).unwrap_or("missing");
                    let resp = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }
}
