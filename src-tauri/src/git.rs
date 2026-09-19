use crate::approvals;
use crate::util::truncate_chars;
use crate::workspace::{checked_path, root_snapshot, WorkspaceRoots};
use serde::Serialize;
use std::process::Command;

// ---- Git integration ----
// Shells out to the system `git` (no shell, args passed directly - no
// injection surface). All commands are confined to the workspace sandbox via
// git_cwd. Non-interactive env so git can never hang on a prompt.
pub(crate) fn git_cmd(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| {
            format!(
                "git not available ({}). Install git to use version control.",
                e
            )
        })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            format!("git {}: {}", args.join(" "), err)
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub(crate) fn git_cwd(
    state: &tauri::State<'_, WorkspaceRoots>,
    label: &str,
    cwd: String,
) -> Result<std::path::PathBuf, String> {
    let dir = if cwd.is_empty() || cwd == "." {
        root_snapshot(state, label)
    } else {
        checked_path(state, label, cwd, "git.cwd")?
    };
    if !dir.is_dir() {
        return Err("git.cwd: not a directory".to_string());
    }
    Ok(dir)
}

#[derive(Debug, Serialize)]
pub struct GitFile {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub root: String,
    pub files: Vec<GitFile>,
}

#[tauri::command]
pub(crate) fn git_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
) -> Result<GitStatus, String> {
    let dir = git_cwd(&state, window.label(), cwd)?;
    let root = git_cmd(&dir, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| dir.to_string_lossy().to_string());
    let branch = git_cmd(&dir, &["branch", "--show-current"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let branch = if branch.is_empty() {
        git_cmd(&dir, &["rev-parse", "--short", "HEAD"])
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "(no commits)".to_string())
    } else {
        branch
    };
    let out = git_cmd(&dir, &["status", "--porcelain=v1", "-uall"])?;
    let mut files = Vec::new();
    for line in out.lines().take(500) {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].trim().to_string();
        let mut path = line[3..].to_string();
        // Renames print as "orig -> new" - show the new path.
        if let Some(idx) = path.find(" -> ") {
            path = path[idx + 4..].to_string();
        }
        path = path.trim_matches('"').to_string();
        files.push(GitFile {
            path,
            status: if status.is_empty() {
                "?".to_string()
            } else {
                status
            },
        });
    }
    Ok(GitStatus {
        branch,
        root,
        files,
    })
}

#[tauri::command]
pub(crate) fn git_diff(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    let dir = git_cwd(&state, window.label(), cwd)?;
    let mut argv: Vec<String> = vec!["diff".into(), "--no-color".into(), "--no-ext-diff".into()];
    if staged.unwrap_or(false) {
        argv.push("--cached".into());
    }
    if let Some(p) = path {
        if !p.trim().is_empty() {
            let safe = checked_path(&state, window.label(), p, "git_diff.path")?;
            argv.push("--".into());
            argv.push(safe.to_string_lossy().to_string());
        }
    }
    let argrefs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let out = git_cmd(&dir, &argrefs)?;
    Ok(truncate_chars(out, 60_000))
}

#[derive(Debug, Serialize)]
pub struct GitCommitOut {
    pub hash: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn git_commit(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    approvals: tauri::State<'_, approvals::ApprovalStore>,
    cwd: String,
    message: String,
    files: Option<Vec<String>>,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<GitCommitOut, String> {
    approvals::approval_consume(
        &approvals,
        window.label(),
        "git_commit",
        &approval_detail,
        &approval_token,
    )?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("git_commit: message required".to_string());
    }
    if message.len() > 500 {
        return Err("git_commit: message too long (500 max)".to_string());
    }
    if message.contains('\0') {
        return Err("git_commit: invalid message".to_string());
    }
    let dir = git_cwd(&state, window.label(), cwd)?;
    let list = files.unwrap_or_default();
    if list.len() > 100 {
        return Err("git_commit: too many files (100 max)".to_string());
    }
    // Stage ONLY the listed files - never sweep unrelated changes.
    if !list.is_empty() {
        let mut add_argv: Vec<String> = vec!["add".into(), "--".into()];
        for f in &list {
            let safe = checked_path(&state, window.label(), f.clone(), "git_commit.files")?;
            add_argv.push(safe.to_string_lossy().to_string());
        }
        let addrefs: Vec<&str> = add_argv.iter().map(|s| s.as_str()).collect();
        git_cmd(&dir, &addrefs)?;
    }
    git_cmd(&dir, &["commit", "-m", &message])?;
    let hash = git_cmd(&dir, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(GitCommitOut { hash })
}

#[derive(Debug, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

#[tauri::command]
pub(crate) fn git_log(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
    limit: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let dir = git_cwd(&state, window.label(), cwd)?;
    let n = limit.unwrap_or(20).clamp(1, 50);
    let out = git_cmd(
        &dir,
        &[
            "log",
            &format!("-n{}", n),
            "--format=%H%x1f%an%x1f%ad%x1f%s",
            "--date=short",
        ],
    )?;
    let mut entries = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() != 4 {
            continue;
        }
        entries.push(GitLogEntry {
            hash: parts[0].to_string(),
            author: parts[1].to_string(),
            date: parts[2].to_string(),
            message: parts[3].to_string(),
        });
    }
    Ok(entries)
}

#[tauri::command]
pub(crate) fn git_init(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
) -> Result<String, String> {
    let dir = git_cwd(&state, window.label(), cwd)?;
    git_cmd(&dir, &["init"])?;
    Ok(dir.to_string_lossy().to_string())
}
