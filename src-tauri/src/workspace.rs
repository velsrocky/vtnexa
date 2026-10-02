use crate::util::{reject_sensitive, safe_absolute};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrustedPath {
    pub pattern: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub trusted_paths: Vec<TrustedPath>,
}

// ---- Workspace root: allowlist sandbox, per window ----
// Each top-level window is an independent app instance with its own root;
// commands resolve it from the calling window's label.
#[derive(Default)]
pub(crate) struct WorkspaceRoots(pub(crate) Mutex<HashMap<String, std::path::PathBuf>>);

#[derive(Default)]
pub(crate) struct AppSettings(pub(crate) Mutex<AppConfig>);

pub(crate) const MAX_TRUSTED_PATHS: usize = 50;
pub(crate) const MAX_TRUSTED_PATTERN_LEN: usize = 256;
pub(crate) const MAX_TRUSTED_REASON_LEN: usize = 256;

/// Normalize a user-supplied trusted-path pattern to a relative fragment.
/// Rejects anything that could match too broadly (absolute paths, `..`,
/// `~`, empty, or over-long). Returns the normalized `a/b/c` form.
pub(crate) fn normalize_trusted_pattern(raw: &str) -> Result<String, String> {
    let t = raw.trim().replace('\\', "/");
    if t.is_empty() {
        return Err("trusted path: pattern is empty".to_string());
    }
    if t.len() > MAX_TRUSTED_PATTERN_LEN {
        return Err(format!(
            "trusted path: pattern too long ({} > {})",
            t.len(),
            MAX_TRUSTED_PATTERN_LEN
        ));
    }
    if t.contains('\0') {
        return Err("trusted path: invalid pattern".to_string());
    }
    // Collapse duplicate slashes, strip leading/trailing slashes.
    let mut parts: Vec<&str> = Vec::new();
    for seg in t.split('/') {
        let s = seg.trim();
        if s.is_empty() {
            continue;
        }
        if s == "." || s == ".." {
            return Err("trusted path: '..' and '.' are not allowed".to_string());
        }
        if s == "~" || s.starts_with('~') {
            return Err("trusted path: '~' is not allowed".to_string());
        }
        parts.push(s);
    }
    if parts.is_empty() {
        return Err("trusted path: pattern matches everything (refused)".to_string());
    }
    let norm = parts.join("/");
    // A lone "/" (or "///") normalizes to empty — already rejected above,
    // but belt-and-braces against a match-all entry.
    if norm.is_empty() || norm == "/" {
        return Err("trusted path: pattern matches everything (refused)".to_string());
    }
    Ok(norm)
}

fn split_path_components(path: &std::path::Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect()
}

pub(crate) fn is_trusted_path(path: &std::path::Path, trusted_paths: &[TrustedPath]) -> bool {
    let comps = split_path_components(path);
    if comps.is_empty() {
        return false;
    }
    for tp in trusted_paths {
        // Skip entries that would never validate (e.g. written before
        // validation landed): fail-closed, they simply don't match.
        let norm = match normalize_trusted_pattern(&tp.pattern) {
            Ok(n) => n.to_lowercase(),
            Err(_) => continue,
        };
        let pat: Vec<&str> = norm.split('/').collect();
        if pat.is_empty() || pat.len() > comps.len() {
            continue;
        }
        // Contiguous component-subsequence match: "docs" matches
        // /ws/docs/a and /ws/x/docs/a, but NOT /ws/mydocs/a or /ws/docs2/a.
        if comps
            .windows(pat.len())
            .any(|w| w.iter().zip(&pat).all(|(a, b)| a == b))
        {
            return true;
        }
    }
    false
}

pub(crate) fn native_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let variable = "USERPROFILE";
    #[cfg(not(windows))]
    let variable = "HOME";
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn canonical_workspace_root(root: &Path) -> Result<PathBuf, String> {
    root.canonicalize().map_err(|error| {
        format!(
            "workspace: cannot canonicalize {}: {}",
            root.display(),
            error
        )
    })
}

pub(crate) fn default_root() -> PathBuf {
    native_home().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")))
}

pub(crate) fn root_snapshot(state: &tauri::State<'_, WorkspaceRoots>, label: &str) -> PathBuf {
    let g = state.0.lock().ok();
    if let Some(r) = g.as_ref().and_then(|m| m.get(label)) {
        return r.canonicalize().unwrap_or_else(|_| r.clone());
    }
    let r = default_root();
    r.canonicalize().unwrap_or(r)
}

fn path_component_key(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let value = component.as_os_str().to_string_lossy().into_owned();
            #[cfg(windows)]
            let value = value.to_lowercase();
            value
        })
        .collect()
}

fn path_is_within_fs(path: &Path, root: &Path) -> bool {
    let path = path_component_key(path);
    let root = path_component_key(root);
    path.len() >= root.len() && path.iter().zip(&root).all(|(left, right)| left == right)
}

fn relative_path_within(path: &Path, root: &Path) -> Option<PathBuf> {
    let path_components: Vec<_> = path.components().collect();
    let root_components: Vec<_> = root.components().collect();
    if path_components.len() < root_components.len() {
        return None;
    }
    let path_keys = path_component_key(path);
    let root_keys = path_component_key(root);
    if !path_keys
        .iter()
        .zip(&root_keys)
        .all(|(left, right)| left == right)
    {
        return None;
    }
    let mut relative = PathBuf::new();
    for component in &path_components[root_components.len()..] {
        relative.push(component.as_os_str());
    }
    Some(relative)
}

fn metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(crate) fn is_link_or_reparse(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata_is_link_or_reparse(&metadata))
        .unwrap_or(false)
}

pub(crate) fn has_link_or_reparse_ancestor(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if is_link_or_reparse(candidate) {
            return true;
        }
        current = candidate.parent();
    }
    false
}

pub(crate) fn ensure_within_root(norm: &Path, root: &Path, what: &str) -> Result<(), String> {
    let root = canonical_workspace_root(root)?;
    let outside = |via: &str| {
        format!(
            "{}: outside workspace {} (got {}, {})",
            what,
            root.display(),
            norm.display(),
            via
        )
    };
    if let Ok(canon) = norm.canonicalize() {
        if path_is_within_fs(&canon, &root) {
            return Ok(());
        }
        return Err(outside("symlink or path resolves outside"));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(norm) {
        if metadata_is_link_or_reparse(&metadata) {
            return Err(format!(
                "{}: dangling symlink or reparse point (cannot verify where it points)",
                what
            ));
        }
    }
    let mut ancestor = norm.parent();
    while let Some(candidate) = ancestor {
        if candidate.as_os_str().is_empty() {
            break;
        }
        if let Ok(metadata) = std::fs::symlink_metadata(candidate) {
            if metadata_is_link_or_reparse(&metadata) {
                return Err(format!("{}: symlink or reparse point in path", what));
            }
        }
        if let Ok(canon) = candidate.canonicalize() {
            if !path_is_within_fs(&canon, &root) {
                return Err(outside("nearest existing ancestor resolves outside"));
            }
            return Ok(());
        }
        ancestor = candidate.parent();
    }
    Err(outside("no existing ancestor inside workspace"))
}

fn is_private_name(component: &str) -> bool {
    #[cfg(windows)]
    {
        let normalized = component.trim_end_matches(['.', ' ']);
        normalized.eq_ignore_ascii_case(".nexa") || normalized.eq_ignore_ascii_case(".vtnexa")
    }
    #[cfg(not(windows))]
    {
        component == ".nexa" || component == ".vtnexa"
    }
}

fn normalize_internal_relative(relative: &Path, what: &str) -> Result<PathBuf, String> {
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.is_empty() || text.contains('\0') || text.starts_with('/') {
        return Err(format!("{}: invalid internal path", what));
    }
    let mut components = Vec::new();
    for component in text.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            return Err(format!("{}: traversal is not allowed", what));
        }
        if component.contains(':') {
            return Err(format!("{}: invalid internal path component", what));
        }
        components.push(component);
    }
    let first_private = components.first().copied().map(is_private_name);
    if components.is_empty() || !first_private.unwrap_or(false) {
        return Err(format!("{}: path is outside app-private storage", what));
    }
    Ok(PathBuf::from(components.join("/")))
}

fn is_internal_relative(path: &Path) -> bool {
    let Some(component) = path
        .components()
        .next()
        .and_then(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
    else {
        return false;
    };
    is_private_name(component)
}

pub(crate) fn internal_relative_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    if let Some(relative) = relative_path_within(path, &root) {
        if is_internal_relative(&relative) {
            return Some(relative);
        }
    }
    if let Ok(canonical) = path.canonicalize() {
        if let Some(relative) = relative_path_within(&canonical, &root) {
            if is_internal_relative(&relative) {
                return Some(relative);
            }
        }
    }
    let mut current = path;
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(canonical) = current.canonicalize() {
            if let Some(mut relative) = relative_path_within(&canonical, &root) {
                for component in suffix.iter().rev() {
                    relative.push(component);
                }
                if is_internal_relative(&relative) {
                    return Some(relative);
                }
            }
            break;
        }
        suffix.push(current.file_name()?.to_os_string());
        current = current.parent()?;
    }
    None
}

pub(crate) fn is_internal_path(root: &Path, path: &Path) -> bool {
    internal_relative_path(root, path).is_some()
}

const GENERIC_PRIVATE_COMPONENTS: &[&str] = &[".nexa", ".vtnexa", ".git", ".hg", ".svn"];

fn is_generic_private_component(component: &str) -> bool {
    let normalized = component.trim_end_matches(['.', ' ']);
    let lower = normalized.to_ascii_lowercase();
    GENERIC_PRIVATE_COMPONENTS
        .iter()
        .any(|name| lower == *name || lower.starts_with(&format!("{name}:")))
}

fn path_has_generic_private_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        std::path::Component::Normal(value) => {
            is_generic_private_component(&value.to_string_lossy())
        }
        _ => false,
    })
}

fn generic_private_relative(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    if let Some(relative) = relative_path_within(path, &root) {
        if path_has_generic_private_component(&relative) {
            return Some(relative);
        }
    }
    if let Ok(canonical) = path.canonicalize() {
        if let Some(relative) = relative_path_within(&canonical, &root) {
            if path_has_generic_private_component(&relative) {
                return Some(relative);
            }
        }
    }
    let mut current = path;
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(canonical) = current.canonicalize() {
            if let Some(mut relative) = relative_path_within(&canonical, &root) {
                for component in suffix.iter().rev() {
                    relative.push(component);
                }
                if path_has_generic_private_component(&relative) {
                    return Some(relative);
                }
            }
            break;
        }
        suffix.push(current.file_name()?.to_os_string());
        current = current.parent()?;
    }
    None
}

pub(crate) fn is_generic_private_path(root: &Path, path: &Path) -> bool {
    generic_private_relative(root, path).is_some()
}

pub(crate) fn reject_generic_private_path(
    root: &Path,
    path: &Path,
    what: &str,
) -> Result<(), String> {
    if let Some(relative) = generic_private_relative(root, path) {
        return Err(format!(
            "{}: app-private or repository-metadata path {} is not available through generic file APIs",
            what,
            relative.to_string_lossy()
        ));
    }
    if path_has_generic_private_component(path) {
        return Err(format!(
            "{}: app-private or repository-metadata paths are not available through generic file APIs",
            what
        ));
    }
    Ok(())
}

pub(crate) fn checked_internal_path(
    root: &Path,
    relative: &Path,
    what: &str,
) -> Result<PathBuf, String> {
    let root = canonical_workspace_root(root)?;
    let relative = normalize_internal_relative(relative, what)?;
    let candidate = root.join(&relative);
    let mut current = root.clone();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata_is_link_or_reparse(&metadata) {
                    return Err(format!(
                        "{}: app-private path contains a symlink or reparse point",
                        what
                    ));
                }
                if index + 1 < components.len() && !metadata.is_dir() {
                    return Err(format!("{}: app-private parent is not a directory", what));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("{}: {}", what, error)),
        }
    }
    if let Ok(canonical) = candidate.canonicalize() {
        if !path_is_within_fs(&canonical, &root) {
            return Err(format!("{}: resolves outside workspace", what));
        }
    } else {
        let mut ancestor = candidate.parent();
        while let Some(candidate_parent) = ancestor {
            if candidate_parent.as_os_str().is_empty() {
                break;
            }
            if let Ok(metadata) = std::fs::symlink_metadata(candidate_parent) {
                if metadata_is_link_or_reparse(&metadata) {
                    return Err(format!(
                        "{}: app-private path contains a symlink or reparse point",
                        what
                    ));
                }
            }
            if let Ok(canonical_parent) = candidate_parent.canonicalize() {
                if !path_is_within_fs(&canonical_parent, &root) {
                    return Err(format!("{}: resolves outside workspace", what));
                }
                break;
            }
            ancestor = candidate_parent.parent();
        }
    }
    Ok(candidate)
}

pub(crate) fn create_internal_directory(
    root: &Path,
    relative: &Path,
    what: &str,
) -> Result<PathBuf, String> {
    let path = checked_internal_path(root, relative, what)?;
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
                return Err(format!("{}: app-private path is not a directory", what));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&path).map_err(|error| format!("{}: {}", what, error))?;
        }
        Err(error) => return Err(format!("{}: {}", what, error)),
    }
    let checked = checked_internal_path(root, relative, what)?;
    if !checked.is_dir() {
        return Err(format!("{}: app-private path is not a directory", what));
    }
    Ok(checked)
}

pub(crate) fn ensure_internal_parents(
    root: &Path,
    relative: &Path,
    what: &str,
) -> Result<PathBuf, String> {
    let parent = relative
        .parent()
        .ok_or_else(|| format!("{}: missing app-private parent", what))?;
    create_internal_directory(root, parent, what)?;
    checked_internal_path(root, relative, what)
}

pub(crate) fn checked_path(
    state: &tauri::State<'_, WorkspaceRoots>,
    label: &str,
    raw: String,
    what: &str,
) -> Result<PathBuf, String> {
    let norm = safe_absolute(raw, what)?;
    let root = root_snapshot(state, label);
    if let Some(relative) = internal_relative_path(&root, &norm) {
        if has_link_or_reparse_ancestor(&norm) {
            return Err(format!(
                "{}: app-private path contains a symlink or reparse point",
                what
            ));
        }
        return checked_internal_path(&root, &relative, what);
    }
    ensure_within_root(&norm, &root, what)?;
    Ok(norm)
}

fn normalized_absolute(raw: &str) -> Result<std::path::PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err("path is empty or invalid".to_string());
    }
    let path = std::path::PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    let mut normalized = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn comparable_components(path: &std::path::Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let value = component.as_os_str().to_string_lossy().into_owned();
            #[cfg(windows)]
            let value = value.to_lowercase();
            value
        })
        .collect()
}

#[tauri::command]
pub(crate) fn path_is_within(path: String, root: String) -> Result<bool, String> {
    let path = comparable_components(&normalized_absolute(&path)?);
    let root = comparable_components(&normalized_absolute(&root)?);
    Ok(path.len() >= root.len() && path.iter().zip(&root).all(|(left, right)| left == right))
}

#[tauri::command]
pub(crate) fn workspace_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
) -> Result<String, String> {
    Ok(root_snapshot(&state, window.label())
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub(crate) fn set_workspace_root<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, WorkspaceRoots>,
    path: String,
    confirm_dangerous: Option<bool>,
) -> Result<String, String> {
    let norm = safe_absolute(path, "workspace")?;
    if !norm.is_dir() {
        return Err("workspace: not a directory".to_string());
    }
    let canon = norm.canonicalize().map_err(|e| e.to_string())?;
    reject_sensitive(&canon)?;
    if path_has_generic_private_component(&canon) {
        return Err(
            "workspace: app-private or repository-metadata directories cannot be workspaces"
                .to_string(),
        );
    }
    // Disallow widening to / or $HOME itself without explicit opt-in.
    // One blind Approve must not silently grant the whole machine.
    let is_fs_root = canon.parent().is_none();
    let home_canon = native_home().and_then(|home| home.canonicalize().ok());
    let is_home = home_canon.as_ref().map(|h| &canon == h).unwrap_or(false);
    if (is_fs_root || is_home) && !confirm_dangerous.unwrap_or(false) {
        return Err(if is_fs_root {
            "workspace: refusing filesystem root without explicit confirm (pick a project folder, or confirm you understand the sandbox is effectively off)".to_string()
        } else {
            "workspace: refusing $HOME without explicit confirm (pick a project folder, or confirm you understand shell+fs can reach dotfiles)".to_string()
        });
    }
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window.label().to_string(), canon.clone());
    Ok(canon.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn update_trusted_paths(
    app: tauri::AppHandle,
    new_paths: Vec<TrustedPath>,
) -> Result<(), String> {
    // Direct-UI only (Settings modal): the agent has no tool that calls this.
    // Still validate server-side so a stale/compromised renderer cannot plant
    // a match-all entry ("/", "..", "~") and silently bypass fs_write gates.
    if new_paths.len() > MAX_TRUSTED_PATHS {
        return Err(format!(
            "trusted paths: too many entries ({} > {})",
            new_paths.len(),
            MAX_TRUSTED_PATHS
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut clean: Vec<TrustedPath> = Vec::with_capacity(new_paths.len());
    for tp in new_paths {
        let norm = normalize_trusted_pattern(&tp.pattern)?;
        let reason: String = tp.reason.chars().take(MAX_TRUSTED_REASON_LEN).collect();
        if seen.insert(norm.clone()) {
            clean.push(TrustedPath {
                pattern: norm,
                reason,
            });
        }
    }
    if let Some(settings) = app.try_state::<AppSettings>() {
        if let Ok(mut guard) = settings.0.lock() {
            guard.trusted_paths = clean;
            return Ok(());
        }
    }
    Err("Failed to update trusted paths".to_string())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_patterns_match_on_component_boundaries() {
        let tps = vec![TrustedPath {
            pattern: "docs".to_string(),
            reason: String::new(),
        }];
        assert!(is_trusted_path(std::path::Path::new("/ws/docs/a.md"), &tps));
        assert!(is_trusted_path(
            std::path::Path::new("/ws/x/docs/a.md"),
            &tps
        ));
        // Substring lookalikes must NOT match.
        assert!(!is_trusted_path(
            std::path::Path::new("/ws/mydocs/a.md"),
            &tps
        ));
        assert!(!is_trusted_path(
            std::path::Path::new("/ws/docs2/a.md"),
            &tps
        ));
        assert!(!is_trusted_path(std::path::Path::new("/ws/src/a.md"), &tps));

        let multi = vec![TrustedPath {
            pattern: "src/generated".to_string(),
            reason: String::new(),
        }];
        assert!(is_trusted_path(
            std::path::Path::new("/ws/src/generated/a.ts"),
            &multi
        ));
        assert!(!is_trusted_path(
            std::path::Path::new("/ws/src/other/a.ts"),
            &multi
        ));
    }

    #[test]
    fn trusted_patterns_reject_match_all_and_escapes() {
        for bad in ["", "/", "///", "..", "../x", "a/../b", "~", "~/x", "."] {
            assert!(
                normalize_trusted_pattern(bad).is_err(),
                "should reject {:?}",
                bad
            );
        }
        assert!(normalize_trusted_pattern("docs/").unwrap() == "docs");
        assert!(normalize_trusted_pattern("src/generated/").unwrap() == "src/generated");
        // Legacy substring entries fail closed (no match, no panic).
        let legacy = vec![TrustedPath {
            pattern: "/".to_string(),
            reason: String::new(),
        }];
        assert!(!is_trusted_path(
            std::path::Path::new("/ws/docs/a.md"),
            &legacy
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escapes_are_rejected() {
        let tag = std::process::id();
        let root = std::env::temp_dir().join(format!("vtnexa-root-{}", tag));
        let outside = std::env::temp_dir().join(format!("vtnexa-out-{}", tag));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let r = root.canonicalize().unwrap();
        // A symlinked dir inside the workspace pointing outside is the escape vector.
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        std::fs::write(outside.join("secret.txt"), b"x").unwrap();
        // Existing file reached through the escape symlink: rejected.
        assert!(ensure_within_root(&link.join("secret.txt"), &r, "t").is_err());
        // NEW file through the same symlink (the pre-fix fast-path hole): rejected.
        assert!(ensure_within_root(&link.join("new.txt"), &r, "t").is_err());
        // Dangling symlink (target never existed): rejected - unverifiable.
        let dangling = root.join("dangling");
        std::os::unix::fs::symlink(outside.join("nope.txt"), &dangling).unwrap();
        assert!(ensure_within_root(&dangling, &r, "t").is_err());
        // Legit paths inside the root still work, existing or not.
        assert!(ensure_within_root(&root.join("ok.txt"), &r, "t").is_ok());
        std::fs::write(root.join("real.txt"), b"x").unwrap();
        assert!(ensure_within_root(&root.join("real.txt"), &r, "t").is_ok());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    fn internal_fixture(label: &str) -> PathBuf {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("vtnexa-internal-{label}-{id}"));
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn generic_paths_reject_private_components_and_metadata() {
        let root = internal_fixture("generic-private");
        for name in [".nexa", ".vtnexa", ".git", ".hg", ".svn"] {
            let path = root.join(name).join("secret.txt");
            assert!(reject_generic_private_path(&root, &path, "fs_read").is_err());
        }
        assert!(reject_generic_private_path(&root, &root.join("src/main.rs"), "fs_read").is_ok());
        assert!(
            reject_generic_private_path(&root, &root.join("src/../.git/config"), "fs_read")
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn generic_paths_reject_symlinks_to_private_metadata() {
        let root = internal_fixture("generic-private-link");
        let target = root.join(".git");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("config"), b"private").unwrap();
        let link = root.join("source");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(reject_generic_private_path(&root, &link.join("config"), "fs_read").is_err());
        assert!(is_generic_private_path(&root, &root.join("source")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn internal_paths_accept_nested_and_missing_children() {
        let root = internal_fixture("nested");
        for relative in [".nexa/sessions/new.json", ".vtnexa/skills/new.md"] {
            assert!(checked_internal_path(&root, Path::new(relative), "test").is_ok());
        }
        let directory =
            create_internal_directory(&root, Path::new(".vtnexa/skills"), "test").unwrap();
        assert!(directory.is_dir());
        assert!(
            checked_internal_path(&root, Path::new(".vtnexa/skills/missing.md"), "test").is_ok()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn internal_paths_reject_traversal_and_non_private_namespaces() {
        let root = internal_fixture("invalid");
        for relative in [
            ".",
            "normal/file",
            "../outside",
            ".nexa/../outside",
            ".vtnexa/./../outside",
            "/outside",
            "C:\\outside",
            "\\\\server\\share\\.nexa",
            "\\\\?\\C:\\outside",
            ".nexa::$DATA",
            "..\\outside",
        ] {
            assert!(
                checked_internal_path(&root, Path::new(relative), "test").is_err(),
                "accepted {}",
                relative
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn private_directory_symlinks_are_rejected_even_when_internal() {
        let root = internal_fixture("symlink");
        let outside = internal_fixture("symlink-outside");
        let inside = root.join("inside");
        std::fs::create_dir_all(&inside).unwrap();
        let nexa = root.join(".nexa");
        std::os::unix::fs::symlink(&outside, &nexa).unwrap();
        assert!(checked_internal_path(&root, Path::new(".nexa/secret.txt"), "test").is_err());
        std::fs::remove_file(&nexa).unwrap();
        std::os::unix::fs::symlink(&inside, &nexa).unwrap();
        assert!(checked_internal_path(&root, Path::new(".nexa/secret.txt"), "test").is_err());
        std::fs::remove_file(&nexa).unwrap();
        let vtnexa = root.join(".vtnexa");
        std::os::unix::fs::symlink(&outside, &vtnexa).unwrap();
        assert!(
            checked_internal_path(&root, Path::new(".vtnexa/skills/secret.md"), "test").is_err()
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
