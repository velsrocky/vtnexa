use crate::approvals;
use crate::util::{write_atomic, MAX_LIST_ENTRIES, MAX_READ_BYTES, MAX_WRITE_BYTES};
use crate::workspace::{checked_path, is_trusted_path, root_snapshot, AppSettings, WorkspaceRoots};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub(crate) fn fs_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let safe = checked_path(&state, window.label(), path, "fs_list")?;
    let entries = std::fs::read_dir(&safe).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in entries {
        let e = e.map_err(|e| e.to_string())?;
        let p = e.path();
        let ft = e.file_type().map_err(|e| e.to_string())?;
        out.push(FileEntry {
            name: e.file_name().to_string_lossy().to_string(),
            path: p.to_string_lossy().to_string(),
            is_dir: ft.is_dir(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    if out.len() > MAX_LIST_ENTRIES {
        out.truncate(MAX_LIST_ENTRIES);
    }
    Ok(out)
}

#[tauri::command]
pub(crate) fn fs_read(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    path: String,
) -> Result<String, String> {
    let safe = checked_path(&state, window.label(), path, "fs_read")?;
    let meta = std::fs::metadata(&safe).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "refused: file too large ({} bytes, max {})",
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    std::fs::read_to_string(&safe).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn fs_write(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    settings: tauri::State<'_, AppSettings>,
    approvals: tauri::State<'_, approvals::ApprovalStore>,
    path: String,
    content: String,
    approval_token: String,
    approval_detail: String,
) -> Result<(), String> {
    let safe = checked_path(&state, window.label(), path, "fs_write")?;
    let trusted_paths = settings
        .0
        .lock()
        .map(|s| s.trusted_paths.clone())
        .unwrap_or_default();

    // Skip approval for trusted paths (reduces UX verbosity)
    let needs_approval = !is_trusted_path(&safe, &trusted_paths);

    if needs_approval {
        let token: Option<String> = if approval_token.is_empty() {
            None
        } else {
            Some(approval_token)
        };
        let detail: Option<String> = if approval_detail.is_empty() {
            None
        } else {
            Some(approval_detail)
        };
        approvals::approval_consume(&approvals, window.label(), "fs_write", &detail, &token)?;
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "refused: content too large ({} bytes, max {})",
            content.len(),
            MAX_WRITE_BYTES
        ));
    }
    if let Some(parent) = safe.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    write_atomic(&safe, content.as_bytes())
}

// ---- Workspace-wide search (grep + glob) ----
// Gives the agent codebase awareness without a separate index: ripgrep-style
// content search and filename lookup, scoped to the workspace and skipping
// noise dirs/binary files. Read-only, so no approval gate.
pub(crate) const MAX_SEARCH_FILES: usize = 2000;
pub(crate) const MAX_SEARCH_RESULTS: usize = 500;
pub(crate) const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;

pub(crate) const NOISE_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".nexa",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".idea",
    ".vscode",
    "vendor",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "coverage",
    "DerivedData",
    "Pods",
    "vtai-browser-profile",
];

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

pub(crate) fn rel_path(root: &std::path::Path, p: &std::path::Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

/// Walk `dir` recursively, invoking cb(root, file_path) per file. Skips hidden
/// dirs and NOISE_DIRS. cb returning false stops the walk early.
pub(crate) fn walk_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    visited: &mut usize,
    cb: &mut dyn FnMut(&std::path::Path, &std::path::Path) -> bool,
) {
    if *visited >= MAX_SEARCH_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        if *visited >= MAX_SEARCH_FILES {
            return;
        }
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if name.starts_with('.') || NOISE_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_files(root, &path, visited, cb);
        } else if ft.is_file() {
            *visited += 1;
            if !cb(root, &path) {
                return;
            }
        }
    }
}

/// Wildcard match: '*' = any sequence, '?' = one char. Case-insensitive.
pub(crate) fn glob_match(pat: &str, name: &str) -> bool {
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let t: Vec<char> = name.to_lowercase().chars().collect();
    let (m, n) = (p.len(), t.len());
    let mut dp = vec![vec![false; n + 1]; m + 1];
    dp[0][0] = true;
    for i in 1..=m {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        } else {
            break;
        }
    }
    for i in 1..=m {
        for j in 1..=n {
            if p[i - 1] == '*' {
                dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
            } else if p[i - 1] == '?' || p[i - 1] == t[j - 1] {
                dp[i][j] = dp[i - 1][j - 1];
            }
        }
    }
    dp[m][n]
}

/// Accepts comma-separated patterns (e.g. "*.rs,*.toml").
pub(crate) fn glob_matches(pat: &str, name: &str) -> bool {
    pat.split(',').any(|p| glob_match(p.trim(), name))
}

#[tauri::command]
pub(crate) fn fs_search(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    query: String,
    path: Option<String>,
    glob: Option<String>,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
) -> Result<Vec<SearchMatch>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("fs_search: query required".to_string());
    }
    if query.len() > 512 {
        return Err("fs_search: query too long (512 max)".to_string());
    }
    let root = root_snapshot(&state, window.label());
    let start = match path {
        Some(p) if !p.trim().is_empty() => {
            checked_path(&state, window.label(), p, "fs_search.path")?
        }
        _ => root.clone(),
    };
    if !start.is_dir() {
        return Err("fs_search.path: not a directory".to_string());
    }

    let case_sensitive = case_sensitive.unwrap_or(false);
    let regex = regex.unwrap_or(false);

    let compiled: Option<regex::Regex> = if regex {
        Some(
            RegexBuilder::new(&query)
                .case_insensitive(!case_sensitive)
                .size_limit(10 * 1024 * 1024)
                .build()
                .map_err(|e| format!("fs_search: bad regex: {}", e))?,
        )
    } else {
        None
    };
    let needle = if case_sensitive {
        query.clone()
    } else {
        query.to_lowercase()
    };

    let mut results: Vec<SearchMatch> = Vec::new();
    let mut remaining = MAX_SEARCH_RESULTS;
    let mut visited = 0usize;

    walk_files(&root, &start, &mut visited, &mut |root, file| {
        if remaining == 0 {
            return false;
        }
        if let Some(g) = &glob {
            if let Some(name) = file.file_name() {
                if !glob_matches(g, &name.to_string_lossy()) {
                    return true;
                }
            }
        }
        let Ok(meta) = std::fs::metadata(file) else {
            return true;
        };
        if meta.len() > MAX_SEARCH_FILE_BYTES {
            return true;
        }
        let Ok(bytes) = std::fs::read(file) else {
            return true;
        };
        if bytes.contains(&0) {
            return true; // binary
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if remaining == 0 {
                break;
            }
            let hit = match &compiled {
                Some(re) => re.is_match(line),
                None => {
                    if case_sensitive {
                        line.contains(needle.as_str())
                    } else {
                        line.to_lowercase().contains(needle.as_str())
                    }
                }
            };
            if hit {
                let mut line_text = line.trim_end().to_string();
                if line_text.chars().count() > 400 {
                    line_text = line_text.chars().take(400).collect::<String>() + "…";
                }
                results.push(SearchMatch {
                    path: rel_path(root, file),
                    line: (i + 1) as u32,
                    text: line_text,
                });
                remaining -= 1;
            }
        }
        true
    });

    Ok(results)
}

#[tauri::command]
pub(crate) fn fs_glob(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    pattern: String,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("fs_glob: pattern required".to_string());
    }
    if pattern.len() > 512 {
        return Err("fs_glob: pattern too long".to_string());
    }
    let root = root_snapshot(&state, window.label());
    let start = match path {
        Some(p) if !p.trim().is_empty() => checked_path(&state, window.label(), p, "fs_glob.path")?,
        _ => root.clone(),
    };
    if !start.is_dir() {
        return Err("fs_glob.path: not a directory".to_string());
    }

    let mut out: Vec<String> = Vec::new();
    let mut visited = 0usize;
    walk_files(&root, &start, &mut visited, &mut |root, file| {
        if out.len() >= MAX_SEARCH_RESULTS {
            return false;
        }
        if let Some(name) = file.file_name() {
            if glob_matches(&pattern, &name.to_string_lossy()) {
                out.push(rel_path(root, file));
            }
        }
        true
    });
    Ok(out)
}

// ---- File create / rename / delete ----
// All confined to the workspace via checked_path. Create makes empty files
// (parents included) or dirs and refuses to overwrite; rename refuses to
// overwrite; delete refuses the workspace root itself.
#[tauri::command]
pub(crate) fn fs_create(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    path: String,
    is_dir: Option<bool>,
) -> Result<String, String> {
    let safe = checked_path(&state, window.label(), path, "fs_create")?;
    if safe.exists() {
        return Err("fs_create: already exists".to_string());
    }
    if is_dir.unwrap_or(false) {
        std::fs::create_dir_all(&safe).map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = safe.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        std::fs::write(&safe, "").map_err(|e| e.to_string())?;
    }
    Ok(safe.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn fs_rename(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    approvals: tauri::State<'_, approvals::ApprovalStore>,
    old_path: String,
    new_path: String,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<String, String> {
    approvals::approval_consume(
        &approvals,
        window.label(),
        "fs_rename",
        &approval_detail,
        &approval_token,
    )?;
    let from = checked_path(&state, window.label(), old_path, "fs_rename.from")?;
    let to = checked_path(&state, window.label(), new_path, "fs_rename.to")?;
    if !from.exists() {
        return Err("fs_rename: source does not exist".to_string());
    }
    if to.exists() {
        return Err("fs_rename: target already exists".to_string());
    }
    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(to.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn fs_delete(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    approvals: tauri::State<'_, approvals::ApprovalStore>,
    path: String,
    recursive: Option<bool>,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<(), String> {
    approvals::approval_consume(
        &approvals,
        window.label(),
        "fs_delete",
        &approval_detail,
        &approval_token,
    )?;
    let safe = checked_path(&state, window.label(), path, "fs_delete")?;
    let root = root_snapshot(&state, window.label());
    if safe == root {
        return Err("fs_delete: refusing to delete the workspace root".to_string());
    }
    if !safe.exists() {
        return Err("fs_delete: does not exist".to_string());
    }
    if safe.is_dir() {
        if recursive.unwrap_or(false) {
            std::fs::remove_dir_all(&safe).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_dir(&safe).map_err(|e| e.to_string())?;
        }
    } else {
        std::fs::remove_file(&safe).map_err(|e| e.to_string())?;
    }
    Ok(())
}
