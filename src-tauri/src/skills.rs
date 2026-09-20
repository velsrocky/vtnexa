use crate::util::truncate_chars;
use crate::workspace::{root_snapshot, WorkspaceRoots};
use serde::Serialize;
use tauri::Manager;

// ---- Project skills (.vtnexa/skills/*.md) ----
// Identity is the filename stem (no frontmatter parsing, no collisions).
// Description is the first non-heading, non-empty line. Paths are built from
// a validated stem, so there is no traversal vector by construction. Bundled
// ready-made skills ship as Tauri resources at <res>/.vtnexa/skills and are
// merged with the workspace's own skills (project wins on name collision).
#[derive(Debug, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

pub(crate) fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn skill_entries(
    dir: &std::path::Path,
    out: &mut std::collections::HashMap<String, SkillInfo>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten().take(100) {
        let path = e.path();
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_skill_name(stem) {
            continue;
        }
        if out.contains_key(stem) {
            continue;
        }
        let desc = std::fs::read_to_string(&path)
            .map(|text| {
                text.lines()
                    .map(|l| l.trim())
                    .find(|l| !l.is_empty() && !l.starts_with('#'))
                    .unwrap_or("")
                    .chars()
                    .take(160)
                    .collect::<String>()
            })
            .unwrap_or_default();
        out.insert(
            stem.to_string(),
            SkillInfo {
                name: stem.to_string(),
                description: desc,
            },
        );
    }
}

pub(crate) fn bundled_skills_dir() -> Option<std::path::PathBuf> {
    // In dev, not bundled - so also check relative to cwd. In release, Tauri
    // puts resources beside the binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for c in [
                dir.join("../.vtnexa/skills"),
                dir.join("../../.vtnexa/skills"),
            ] {
                if c.is_dir() {
                    return Some(c);
                }
            }
        }
    }
    if let Some(c) = [
        std::path::PathBuf::from("../.vtnexa/skills"),
        std::path::PathBuf::from(".vtnexa/skills"),
    ]
    .into_iter()
    .find(|c| c.is_dir())
    {
        return Some(c);
    }
    // Bundled resource dir (release). `resource_dir()` needs AppHandle, so
    // skill_list handles this fallback separately via `tauri::Manager`.
    None
}

#[tauri::command]
pub(crate) fn skill_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    app: tauri::AppHandle,
) -> Result<Vec<SkillInfo>, String> {
    let root = root_snapshot(&state, window.label());
    let mut map = std::collections::HashMap::new();
    // Project skills first (win on collision).
    skill_entries(&root.join(".vtnexa").join("skills"), &mut map);
    // Bundled ready-made skills (taught-in defaults).
    for dir in [
        app.path()
            .resource_dir()
            .ok()
            .map(|r| r.join(".vtnexa").join("skills")),
        bundled_skills_dir(),
    ]
    .into_iter()
    .flatten()
    {
        skill_entries(&dir, &mut map);
    }
    let mut out: Vec<SkillInfo> = map.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub(crate) fn skill_read(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    app: tauri::AppHandle,
    name: String,
) -> Result<String, String> {
    if !valid_skill_name(&name) {
        return Err("skill_read: invalid skill name".to_string());
    }
    let root = root_snapshot(&state, window.label());
    let candidates = [
        root.join(".vtnexa")
            .join("skills")
            .join(format!("{}.md", name)),
        app.path()
            .resource_dir()
            .ok()
            .map(|r| {
                r.join(".vtnexa")
                    .join("skills")
                    .join(format!("{}.md", name))
            })
            .unwrap_or_default(),
        bundled_skills_dir()
            .map(|d| d.join(format!("{}.md", name)))
            .unwrap_or_default(),
    ];
    for path in candidates {
        if path.as_os_str().is_empty() {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(s) => return Ok(truncate_chars(s, 16 * 1024)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!("skill_read: no skill named {:?}", name))
}
