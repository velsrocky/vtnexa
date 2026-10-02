use crate::approvals;
use crate::process::{self, ProcessError, ProcessLimits, ProcessOptions};
use crate::util::truncate_chars;
use crate::workspace::{
    canonical_workspace_root, checked_path, ensure_within_root, is_internal_path,
    reject_generic_private_path, root_snapshot, WorkspaceRoots,
};
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_STDOUT_BYTES: usize = 8 * 1024 * 1024;
const GIT_STDERR_BYTES: usize = 1024 * 1024;
const GIT_COMBINED_BYTES: usize = 9 * 1024 * 1024;

// ---- Git integration ----
// Shells out to the system `git` (no shell, args passed directly - no
// injection surface). All commands are confined to the workspace sandbox via
// git_cwd. Non-interactive env so git can never hang on a prompt.
fn git_cmd_bytes(cwd: &Path, args: &[OsString]) -> Result<Vec<u8>, String> {
    let rendered = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    let limits = ProcessLimits::new(GIT_STDOUT_BYTES, GIT_STDERR_BYTES, GIT_COMBINED_BYTES);
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_OPTIONAL_LOCKS", "0");
    let out = process::run_bounded(command, ProcessOptions::new(GIT_TIMEOUT, limits)).map_err(
        |error| match error {
            ProcessError::Spawn(error) => format!(
                "git not available ({}). Install git to use version control.",
                error
            ),
            ProcessError::Timeout(_) => format!("git {} timed out after 30s", rendered),
            other => format!("git {} failed: {}", rendered, other),
        },
    )?;
    if out.code() != 0 {
        let err = out.stderr().trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", rendered)
        } else {
            format!("git {}: {}", rendered, err)
        });
    }
    if out.stdout_truncated() {
        return Err(format!(
            "git {} stdout exceeded {} bytes (received at least {})",
            rendered,
            GIT_STDOUT_BYTES,
            out.stdout_bytes_seen()
        ));
    }
    Ok(out.stdout_bytes())
}

pub(crate) fn git_cmd(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let owned = args.iter().map(OsString::from).collect::<Vec<_>>();
    Ok(String::from_utf8_lossy(&git_cmd_bytes(cwd, &owned)?).into_owned())
}

pub(crate) fn git_cwd(
    state: &tauri::State<'_, WorkspaceRoots>,
    label: &str,
    cwd: String,
) -> Result<PathBuf, String> {
    let workspace = canonical_workspace_root(&root_snapshot(state, label))?;
    let requested = if cwd.is_empty() || cwd == "." {
        workspace.clone()
    } else {
        checked_path(state, label, cwd, "git.cwd")?
    };
    let dir = requested.canonicalize().map_err(|error| {
        format!(
            "git.cwd: cannot canonicalize {}: {}",
            requested.display(),
            error
        )
    })?;
    if is_internal_path(&workspace, &dir) {
        return Err("git.cwd: app-private paths are not valid repositories".to_string());
    }
    ensure_within_root(&dir, &workspace, "git.cwd")?;
    if !dir.is_dir() {
        return Err("git.cwd: not a directory".to_string());
    }
    Ok(dir)
}

fn git_repo_root(dir: &Path) -> Result<PathBuf, String> {
    let raw = git_cmd_bytes(
        dir,
        &[
            OsString::from("rev-parse"),
            OsString::from("--show-toplevel"),
        ],
    )?;
    let value = String::from_utf8(raw)
        .map_err(|_| "git: repository root is not valid UTF-8".to_string())?;
    let value = value
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string();
    if value.is_empty() {
        return Err("git: repository has no top-level".to_string());
    }
    let value = PathBuf::from(value);
    let value = if value.is_absolute() {
        value
    } else {
        dir.join(value)
    };
    value
        .canonicalize()
        .map_err(|error| format!("git: cannot canonicalize repository top-level: {}", error))
}

fn git_repo_context(
    dir: &Path,
    workspace: &Path,
    what: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let repo_root = git_repo_root(dir)?;
    ensure_within_root(&repo_root, workspace, what)?;
    Ok((dir.to_path_buf(), repo_root))
}

const PRIVATE_GIT_COMPONENTS: &[&str] = &[".nexa", ".vtnexa", ".git", ".hg", ".svn"];

fn is_private_git_component(component: &str) -> bool {
    let normalized = component.trim_end_matches(['.', ' ']);
    let lower = normalized.to_ascii_lowercase();
    PRIVATE_GIT_COMPONENTS
        .iter()
        .any(|name| lower == *name || lower.starts_with(&format!("{name}:")))
}

fn is_private_git_path(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .any(is_private_git_component)
}

fn relative_repo_path(path: &Path, repo_root: &Path) -> Option<PathBuf> {
    let path_components: Vec<_> = path.components().collect();
    let root_components: Vec<_> = repo_root.components().collect();
    if path_components.len() < root_components.len() {
        return None;
    }
    let matches = path_components
        .iter()
        .zip(&root_components)
        .all(|(left, right)| {
            let left = left.as_os_str().to_string_lossy();
            let right = right.as_os_str().to_string_lossy();
            #[cfg(windows)]
            {
                left.eq_ignore_ascii_case(&right)
            }
            #[cfg(not(windows))]
            {
                left == right
            }
        });
    if !matches {
        return None;
    }
    let mut relative = PathBuf::new();
    for component in &path_components[root_components.len()..] {
        relative.push(component.as_os_str());
    }
    Some(relative)
}

fn repo_relative_path(path: &Path, repo_root: &Path) -> Result<PathBuf, String> {
    if let Some(relative) = relative_repo_path(path, repo_root) {
        return Ok(relative);
    }
    if let Ok(canonical) = path.canonicalize() {
        if let Some(relative) = relative_repo_path(&canonical, repo_root) {
            return Ok(relative);
        }
    }
    Err("git: path is outside the repository top-level".to_string())
}

fn normalize_user_path(raw: &str, what: &str) -> Result<String, String> {
    let mut value = raw.trim();
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            value = value[1..value.len() - 1].trim();
        }
    }
    if value.is_empty() || value.contains('\0') {
        return Err(format!("{}: path is empty or invalid", what));
    }
    if value.starts_with('"')
        || value.ends_with('"')
        || value.starts_with('\'')
        || value.ends_with('\'')
        || value.contains('"')
        || value.contains('\'')
    {
        return Err(format!("{}: path has invalid quoting", what));
    }
    Ok(value.to_string())
}

fn has_git_pathspec_syntax(value: &str) -> bool {
    if value.starts_with(':')
        || value
            .chars()
            .any(|character| matches!(character, '*' | '?' | '[' | ']' | '{' | '}'))
    {
        return true;
    }
    let remainder = if value.len() >= 3
        && value.as_bytes()[1] == b':'
        && matches!(value.as_bytes()[2], b'/' | b'\\')
    {
        &value[2..]
    } else {
        value
    };
    remainder.contains(':')
}

fn normalize_concrete_user_path(raw: &str, what: &str) -> Result<String, String> {
    let value = normalize_user_path(raw, what)?;
    if has_git_pathspec_syntax(&value) {
        return Err(format!(
            "{}: wildcard and Git pathspec magic are not allowed",
            what
        ));
    }
    Ok(value)
}

fn validate_repo_file(path: &Path, repo_root: &Path, what: &str) -> Result<PathBuf, String> {
    ensure_within_root(path, repo_root, what)?;
    let relative = repo_relative_path(path, repo_root)?;
    reject_generic_private_path(repo_root, path, what)?;
    if has_git_pathspec_syntax(&relative.to_string_lossy()) {
        return Err(format!(
            "{}: wildcard and Git pathspec magic are not allowed",
            what
        ));
    }
    if is_private_git_path(&relative.to_string_lossy()) {
        return Err(format!("{}: app-private paths cannot be committed", what));
    }
    if path.is_dir() {
        return Err(format!("{}: directories are not valid commit paths", what));
    }
    Ok(path.to_path_buf())
}

fn parse_status_z(raw: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut records = raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err("git: malformed NUL-delimited status".to_string());
        }
        let status = String::from_utf8_lossy(&record[..2]).trim().to_string();
        let path = String::from_utf8(record[3..].to_vec())
            .map_err(|_| "git: status path is not valid UTF-8".to_string())?;
        let old_path = if status
            .chars()
            .next()
            .map(|value| value == 'R' || value == 'C')
            .unwrap_or(false)
        {
            let old = records
                .next()
                .ok_or_else(|| "git: rename status has no source path".to_string())?;
            Some(
                String::from_utf8(old.to_vec())
                    .map_err(|_| "git: status path is not valid UTF-8".to_string())?,
            )
        } else {
            None
        };
        if is_private_git_path(&path)
            || old_path
                .as_deref()
                .map(is_private_git_path)
                .unwrap_or(false)
        {
            continue;
        }
        files.push((
            path,
            if status.is_empty() {
                "?".to_string()
            } else {
                status
            },
        ));
    }
    Ok(files)
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
pub(crate) async fn git_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
) -> Result<GitStatus, String> {
    let workspace = canonical_workspace_root(&root_snapshot(&state, window.label()))?;
    let requested = git_cwd(&state, window.label(), cwd)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (dir, repo_root) = git_repo_context(&requested, &workspace, "git_status")?;
        let branch = git_cmd(&dir, &["branch", "--show-current"])
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let branch = if branch.is_empty() {
            git_cmd(&dir, &["rev-parse", "--short", "HEAD"])
                .map(|value| value.trim().to_string())
                .unwrap_or_else(|_| "(no commits)".to_string())
        } else {
            branch
        };
        let raw = git_cmd_bytes(
            &dir,
            &[
                OsString::from("status"),
                OsString::from("--porcelain=v1"),
                OsString::from("-z"),
                OsString::from("-uall"),
            ],
        )?;
        let files = parse_status_z(&raw)?
            .into_iter()
            .take(500)
            .map(|(path, status)| GitFile { path, status })
            .collect();
        Ok(GitStatus {
            branch,
            root: repo_root.to_string_lossy().to_string(),
            files,
        })
    })
    .await
    .map_err(|error| format!("git_status: worker failed: {error}"))?
}

fn diff_argv(staged: bool) -> Vec<OsString> {
    let mut args = vec![
        "diff".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--no-renames".into(),
    ];
    if staged {
        args.push("--cached".into());
    }
    args
}

fn git_diff_paths(
    dir: &Path,
    repo_root: &Path,
    staged: bool,
    requested: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    let mut args = vec![
        "diff".into(),
        "--no-ext-diff".into(),
        "--name-only".into(),
        "-z".into(),
        "--no-renames".into(),
    ];
    if staged {
        args.push("--cached".into());
    }
    args.push("--".into());
    if let Some(path) = requested {
        args.push(repo_relative_path(path, repo_root)?.into_os_string());
    }
    let raw = git_cmd_bytes(dir, &args)?;
    let mut safe_paths = Vec::new();
    for record in raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let value = String::from_utf8(record.to_vec())
            .map_err(|_| "git: diff path is not valid UTF-8".to_string())?;
        let candidate = PathBuf::from(value);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            dir.join(candidate)
        };
        let relative = repo_relative_path(&candidate, repo_root)?;
        let relative_text = relative.to_string_lossy();
        if has_git_pathspec_syntax(&relative_text) {
            return Err("git_diff: diff produced an unsafe pathspec".to_string());
        }
        if is_private_git_path(&relative_text)
            || reject_generic_private_path(repo_root, &candidate, "git_diff").is_err()
        {
            continue;
        }
        if !safe_paths.contains(&relative) {
            safe_paths.push(relative);
        }
    }
    Ok(safe_paths)
}

fn git_diff_output(
    dir: &Path,
    repo_root: &Path,
    staged: bool,
    requested: Option<&Path>,
) -> Result<String, String> {
    let paths = git_diff_paths(dir, repo_root, staged, requested)?;
    if paths.is_empty() {
        return Ok(String::new());
    }
    let mut args = diff_argv(staged);
    args.push("--".into());
    args.extend(paths.into_iter().map(PathBuf::into_os_string));
    let output = git_cmd_bytes(dir, &args)?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

#[tauri::command]
pub(crate) async fn git_diff(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    let workspace = canonical_workspace_root(&root_snapshot(&state, window.label()))?;
    let requested = git_cwd(&state, window.label(), cwd)?;
    let safe = match path {
        Some(value) if !value.trim().is_empty() => {
            let value = normalize_concrete_user_path(&value, "git_diff.path")?;
            Some(checked_path(
                &state,
                window.label(),
                value,
                "git_diff.path",
            )?)
        }
        _ => None,
    };
    let staged = staged.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let (dir, repo_root) = git_repo_context(&requested, &workspace, "git_diff")?;
        if let Some(safe) = &safe {
            let relative = repo_relative_path(safe, &repo_root)?;
            if is_private_git_path(&relative.to_string_lossy()) {
                return Err("git_diff.path: app-private paths are not available".to_string());
            }
            ensure_within_root(safe, &repo_root, "git_diff.path")?;
        }
        let out = git_diff_output(&dir, &repo_root, staged, safe.as_deref())?;
        Ok(truncate_chars(out, 60_000))
    })
    .await
    .map_err(|error| format!("git_diff: worker failed: {error}"))?
}

#[derive(Debug, Serialize)]
pub struct GitCommitOut {
    pub hash: String,
}

fn validate_commit_message(message: &str) -> Result<String, String> {
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
    Ok(message)
}

fn git_commit_paths(
    dir: &Path,
    repo_root: &Path,
    message: &str,
    paths: &[PathBuf],
) -> Result<String, String> {
    let message = validate_commit_message(message)?;
    if paths.is_empty() {
        return Err("git_commit: approved file list required".to_string());
    }
    if paths.len() > 100 {
        return Err("git_commit: too many files (100 max)".to_string());
    }
    let mut safe_paths = Vec::with_capacity(paths.len());
    for path in paths {
        safe_paths.push(validate_repo_file(path, repo_root, "git_commit.files")?);
    }
    let mut add_args: Vec<OsString> = vec!["add".into(), "-A".into(), "--".into()];
    add_args.extend(safe_paths.iter().map(|path| path.as_os_str().to_owned()));
    git_cmd_bytes(dir, &add_args)?;
    for path in &safe_paths {
        validate_repo_file(path, repo_root, "git_commit.files")?;
    }
    let mut commit_args: Vec<OsString> = vec![
        "commit".into(),
        "--only".into(),
        "-m".into(),
        message.into(),
        "--".into(),
    ];
    commit_args.extend(safe_paths.iter().map(|path| path.as_os_str().to_owned()));
    git_cmd_bytes(dir, &commit_args)?;
    git_cmd(dir, &["rev-parse", "HEAD"]).map(|value| value.trim().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_commit(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    approvals: tauri::State<'_, approvals::ApprovalStore>,
    cwd: String,
    message: String,
    files: Option<Vec<String>>,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<GitCommitOut, String> {
    let message = validate_commit_message(&message)?;
    let workspace = canonical_workspace_root(&root_snapshot(&state, window.label()))?;
    let requested = git_cwd(&state, window.label(), cwd)?;
    let list = files.unwrap_or_default();
    if list.is_empty() {
        return Err("git_commit: approved file list required".to_string());
    }
    if list.len() > 100 {
        return Err("git_commit: too many files (100 max)".to_string());
    }
    let mut paths = Vec::with_capacity(list.len());
    for value in list {
        let value = normalize_concrete_user_path(&value, "git_commit.files")?;
        paths.push(checked_path(
            &state,
            window.label(),
            value,
            "git_commit.files",
        )?);
    }
    approvals::approval_consume(
        &approvals,
        window.label(),
        "git_commit",
        &approval_detail,
        &approval_token,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let (dir, repo_root) = git_repo_context(&requested, &workspace, "git_commit")?;
        let hash = git_commit_paths(&dir, &repo_root, &message, &paths)?;
        Ok(GitCommitOut { hash })
    })
    .await
    .map_err(|error| format!("git_commit: worker failed: {error}"))?
}

#[derive(Debug, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

#[tauri::command]
pub(crate) async fn git_log(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
    limit: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let workspace = canonical_workspace_root(&root_snapshot(&state, window.label()))?;
    let requested = git_cwd(&state, window.label(), cwd)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (dir, _) = git_repo_context(&requested, &workspace, "git_log")?;
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
    })
    .await
    .map_err(|error| format!("git_log: worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn git_init(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    cwd: String,
) -> Result<String, String> {
    let dir = git_cwd(&state, window.label(), cwd)?;
    tauri::async_runtime::spawn_blocking(move || {
        git_cmd(&dir, &["init"])?;
        Ok(dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("git_init: worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(label: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("vtnexa-git-{label}-{id}"));
        fs::create_dir_all(&root).unwrap();
        git_cmd(&root, &["init", "-q"]).unwrap();
        git_cmd(&root, &["config", "user.name", "VTNexa Test"]).unwrap();
        git_cmd(&root, &["config", "user.email", "test@example.invalid"]).unwrap();
        root.canonicalize().unwrap()
    }

    fn output(root: &Path, args: &[&str]) -> String {
        git_cmd(root, args).unwrap()
    }

    #[test]
    fn parent_repository_is_rejected() {
        let repository = fixture("parent");
        let workspace = repository.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let err = git_repo_context(&workspace, &workspace, "git").unwrap_err();
        assert!(err.contains("outside workspace"));
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn commit_isolates_unrelated_staged_files() {
        let repository = fixture("staged");
        let approved = repository.join("approved.txt");
        let unrelated = repository.join("unrelated.txt");
        fs::write(&approved, "approved").unwrap();
        fs::write(&unrelated, "unrelated").unwrap();
        git_cmd(&repository, &["add", "unrelated.txt"]).unwrap();
        git_commit_paths(
            &repository,
            &repository,
            "approved only",
            std::slice::from_ref(&approved),
        )
        .unwrap();
        let committed = output(&repository, &["show", "--format=", "--name-only", "HEAD"]);
        assert!(committed.lines().any(|line| line == "approved.txt"));
        assert!(!committed.lines().any(|line| line == "unrelated.txt"));
        assert_eq!(
            output(&repository, &["diff", "--cached", "--name-only"]).trim(),
            "unrelated.txt"
        );
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn empty_and_private_commit_lists_fail() {
        let repository = fixture("lists");
        assert!(git_commit_paths(&repository, &repository, "empty", &[]).is_err());
        for name in [".nexa", ".vtnexa"] {
            let private = repository.join(name).join("private.txt");
            fs::create_dir_all(private.parent().unwrap()).unwrap();
            fs::write(&private, "private").unwrap();
            assert!(git_commit_paths(
                &repository,
                &repository,
                "private",
                std::slice::from_ref(&private)
            )
            .is_err());
        }
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn private_paths_are_rejected_at_any_depth() {
        let repository = fixture("nested-private");
        for relative in [
            "src/.nexa/session.json",
            "src/nested/.vtnexa/token",
            "src/nested/.git/config",
            "src/nested/.hg/hgrc",
            "src/nested/.svn/entries",
        ] {
            assert!(
                is_private_git_path(relative),
                "should be private: {}",
                relative
            );
            let path = repository.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "private").unwrap();
            assert!(git_commit_paths(
                &repository,
                &repository,
                "private",
                std::slice::from_ref(&path),
            )
            .is_err());
        }
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn unscoped_diff_filters_private_paths() {
        let repository = fixture("unscoped-diff");
        let visible = repository.join("visible.txt");
        let private = repository.join("src/nested/.nexa/private.txt");
        fs::create_dir_all(private.parent().unwrap()).unwrap();
        fs::write(&visible, "before").unwrap();
        fs::write(&private, "PRIVATE-BEFORE").unwrap();
        git_cmd(&repository, &["add", "-A"]).unwrap();
        git_cmd(&repository, &["commit", "-m", "baseline"]).unwrap();
        fs::write(&visible, "visible-after").unwrap();
        fs::write(&private, "PRIVATE-AFTER").unwrap();
        let diff = git_diff_output(&repository, &repository, false, None).unwrap();
        assert!(diff.contains("visible.txt"));
        assert!(!diff.contains("PRIVATE-AFTER"));
        assert!(!diff.contains("private.txt"));
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn user_paths_are_normalized_and_pathspecs_are_rejected() {
        assert_eq!(
            normalize_user_path("  \"/tmp/repository/file.txt\"  ", "test").unwrap(),
            "/tmp/repository/file.txt"
        );
        for raw in [
            "/tmp/repository/*.rs",
            ":(exclude).nexa",
            "/tmp/repository/file[0].txt",
            "/tmp/repository/file.{rs,txt}",
        ] {
            assert!(
                normalize_concrete_user_path(raw, "test").is_err(),
                "should reject pathspec: {}",
                raw
            );
        }
    }

    #[test]
    fn normal_commit_succeeds() {
        let repository = fixture("normal");
        let file = repository.join("normal.txt");
        fs::write(&file, "normal").unwrap();
        let hash = git_commit_paths(
            &repository,
            &repository,
            "normal commit",
            std::slice::from_ref(&file),
        )
        .unwrap();
        assert_eq!(hash.len(), 40);
        assert_eq!(
            output(&repository, &["show", "--format=", "--name-only", "HEAD"]).trim(),
            "normal.txt"
        );
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn nul_status_filters_private_paths() {
        let repository = fixture("private-status");
        fs::create_dir_all(repository.join(".nexa")).unwrap();
        fs::write(repository.join(".nexa/private.txt"), "private").unwrap();
        fs::write(repository.join("visible.txt"), "visible").unwrap();
        let raw = git_cmd_bytes(
            &repository,
            &[
                "status".into(),
                "--porcelain=v1".into(),
                "-z".into(),
                "-uall".into(),
            ],
        )
        .unwrap();
        let entries = parse_status_z(&raw).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "visible.txt");
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn nul_status_handles_renames_and_non_ascii_paths() {
        let repository = fixture("status");
        let old_path = repository.join("old name.txt");
        let new_path = repository.join("new ü name.txt");
        fs::write(&old_path, "old").unwrap();
        git_commit_paths(
            &repository,
            &repository,
            "initial",
            std::slice::from_ref(&old_path),
        )
        .unwrap();
        fs::rename(&old_path, &new_path).unwrap();
        git_cmd(&repository, &["add", "-A"]).unwrap();
        let raw = git_cmd_bytes(
            &repository,
            &[
                "status".into(),
                "--porcelain=v1".into(),
                "-z".into(),
                "-uall".into(),
            ],
        )
        .unwrap();
        let entries = parse_status_z(&raw).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "new ü name.txt");
        assert!(entries[0].1.starts_with('R'));
        let _ = fs::remove_dir_all(repository);
    }
}
