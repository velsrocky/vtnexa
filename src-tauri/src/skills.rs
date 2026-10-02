use crate::util::truncate_chars;
use crate::workspace::{checked_internal_path, root_snapshot, WorkspaceRoots};
use serde::Serialize;
use std::io::Read;
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

const SKILL_MAX_BYTES: usize = 16 * 1024;

pub(crate) fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn read_bounded_skill(path: &std::path::Path) -> Result<String, (std::io::ErrorKind, String)> {
    let file = std::fs::File::open(path).map_err(|error| (error.kind(), error.to_string()))?;
    let metadata = file
        .metadata()
        .map_err(|error| (error.kind(), error.to_string()))?;
    if !metadata.is_file() {
        return Err((
            std::io::ErrorKind::InvalidData,
            "skill: not a regular file".to_string(),
        ));
    }
    if metadata.len() > SKILL_MAX_BYTES as u64 {
        return Err((
            std::io::ErrorKind::InvalidData,
            format!(
                "skill: file too large ({} bytes, max {})",
                metadata.len(),
                SKILL_MAX_BYTES
            ),
        ));
    }
    let capacity = usize::try_from(metadata.len())
        .unwrap_or(0)
        .min(SKILL_MAX_BYTES);
    let mut bytes = Vec::with_capacity(capacity);
    let limit = SKILL_MAX_BYTES as u64 + 1;
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| (error.kind(), error.to_string()))?;
    if bytes.len() > SKILL_MAX_BYTES {
        return Err((
            std::io::ErrorKind::InvalidData,
            format!(
                "skill: file too large (more than {} bytes)",
                SKILL_MAX_BYTES
            ),
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        (
            std::io::ErrorKind::InvalidData,
            "skill: file is not valid UTF-8".to_string(),
        )
    })
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
        let Ok(text) = read_bounded_skill(&path) else {
            continue;
        };
        let desc = text
            .lines()
            .map(|line| line.trim())
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .unwrap_or("")
            .chars()
            .take(160)
            .collect::<String>();
        out.insert(
            stem.to_string(),
            SkillInfo {
                name: stem.to_string(),
                description: desc,
            },
        );
    }
}

fn workspace_skill_entries(
    root: &std::path::Path,
    out: &mut std::collections::HashMap<String, SkillInfo>,
) -> Result<(), String> {
    let relative_dir = std::path::Path::new(".vtnexa/skills");
    let dir = checked_internal_path(root, relative_dir, "skill_list")?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries.flatten().take(100) {
        let file_name = entry.file_name();
        let relative = relative_dir.join(&file_name);
        let path = checked_internal_path(root, &relative, "skill_list")?;
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !valid_skill_name(stem) || out.contains_key(stem) {
            continue;
        }
        let path = checked_internal_path(root, &relative, "skill_list")?;
        let Ok(text) = read_bounded_skill(&path) else {
            continue;
        };
        let desc = text
            .lines()
            .map(|line| line.trim())
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .unwrap_or("")
            .chars()
            .take(160)
            .collect::<String>();
        out.insert(
            stem.to_string(),
            SkillInfo {
                name: stem.to_string(),
                description: desc,
            },
        );
    }
    Ok(())
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
    workspace_skill_entries(&root, &mut map)?;
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
    let project_relative = std::path::Path::new(".vtnexa/skills").join(format!("{}.md", name));
    let project_path = checked_internal_path(&root, &project_relative, "skill_read")?;
    let candidates = [
        Some(project_path.clone()),
        app.path().resource_dir().ok().map(|r| {
            r.join(".vtnexa")
                .join("skills")
                .join(format!("{}.md", name))
        }),
        bundled_skills_dir().map(|d| d.join(format!("{}.md", name))),
    ];
    for path in candidates.into_iter().flatten() {
        let path = if path == project_path {
            checked_internal_path(&root, &project_relative, "skill_read")?
        } else {
            path
        };
        match read_bounded_skill(&path) {
            Ok(skill) => return Ok(truncate_chars(skill, SKILL_MAX_BYTES)),
            Err((std::io::ErrorKind::NotFound, _)) => continue,
            Err((_, error)) => return Err(error),
        }
    }
    Err(format!("skill_read: no skill named {:?}", name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root(label: &str) -> std::path::PathBuf {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("vtnexa-skills-{label}-{id}"));
        std::fs::create_dir_all(root.join(".vtnexa/skills")).unwrap();
        root
    }

    #[test]
    fn oversized_workspace_skill_is_skipped_without_partial_description() {
        let root = fixture_root("oversized-list");
        let path = root.join(".vtnexa/skills/large.md");
        std::fs::write(&path, b"# heading\nvisible description\n").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len((SKILL_MAX_BYTES + 1) as u64)
            .unwrap();
        let mut entries = std::collections::HashMap::new();
        workspace_skill_entries(&root, &mut entries).unwrap();
        assert!(!entries.contains_key("large"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_workspace_skill_read_is_rejected() {
        let root = fixture_root("oversized-read");
        let relative = std::path::Path::new(".vtnexa/skills/large.md");
        let path = root.join(relative);
        std::fs::write(&path, b"visible content").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len((SKILL_MAX_BYTES + 1) as u64)
            .unwrap();
        let checked = checked_internal_path(&root, relative, "skill_read").unwrap();
        let error = read_bounded_skill(&checked).unwrap_err().1;
        assert!(error.contains("file too large"), "got: {}", error);
        let _ = std::fs::remove_dir_all(root);
    }
}
