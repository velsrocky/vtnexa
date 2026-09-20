use crate::util::{reject_sensitive, safe_absolute};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

pub(crate) fn default_root() -> std::path::PathBuf {
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return std::path::PathBuf::from(h);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"))
}

pub(crate) fn root_snapshot(
    state: &tauri::State<'_, WorkspaceRoots>,
    label: &str,
) -> std::path::PathBuf {
    let g = state.0.lock().ok();
    if let Some(r) = g.as_ref().and_then(|m| m.get(label)) {
        return r.clone();
    }
    // Fresh window: default to $HOME (set_workspace_root canonicalizes).
    let r = default_root();
    r.canonicalize().unwrap_or(r)
}

/// Enforce allowlist: target (lexically normalized, absolute) must live inside root.
/// Symlink-safe for existing AND non-existing targets: if the target itself
/// resolves, its canonical path must be inside root; if it doesn't resolve,
/// the nearest existing ancestor is canonicalized and must be inside root
/// (a dangling symlink is refused outright - its final path is unverifiable).
pub(crate) fn ensure_within_root(
    norm: &std::path::Path,
    root: &std::path::Path,
    what: &str,
) -> Result<(), String> {
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
        if canon.starts_with(root) {
            return Ok(());
        }
        return Err(outside("symlink or path resolves outside"));
    }
    // Does not resolve: either it doesn't exist or it's a dangling symlink.
    if let Ok(sm) = std::fs::symlink_metadata(norm) {
        if sm.file_type().is_symlink() {
            return Err(format!(
                "{}: dangling symlink (cannot verify where it points)",
                what
            ));
        }
    }
    // Non-existing target: walk to the nearest existing ancestor. A write
    // through that ancestor lands wherever the ancestor points, so it must
    // be inside root; the lexical remainder is already normalized.
    let mut anc = norm.parent();
    while let Some(a) = anc {
        if a.as_os_str().is_empty() {
            break;
        }
        if let Ok(canon) = a.canonicalize() {
            if !canon.starts_with(root) {
                return Err(outside("nearest existing ancestor resolves outside"));
            }
            return Ok(());
        }
        anc = a.parent();
    }
    Err(outside("no existing ancestor inside workspace"))
}

pub(crate) fn checked_path(
    state: &tauri::State<'_, WorkspaceRoots>,
    label: &str,
    raw: String,
    what: &str,
) -> Result<std::path::PathBuf, String> {
    let norm = safe_absolute(raw, what)?;
    let root = root_snapshot(state, label);
    ensure_within_root(&norm, &root, what)?;
    Ok(norm)
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
pub(crate) fn set_workspace_root(
    window: tauri::WebviewWindow,
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
    // Disallow widening to / or $HOME itself without explicit opt-in.
    // One blind Approve must not silently grant the whole machine.
    let is_fs_root = canon.as_os_str() == "/";
    let home_canon = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(std::path::PathBuf::from)
        .and_then(|h| h.canonicalize().ok());
    let is_home = home_canon.as_ref().map(|h| &canon == h).unwrap_or(false);
    if (is_fs_root || is_home) && !confirm_dangerous.unwrap_or(false) {
        return Err(if is_fs_root {
            "workspace: refusing / without explicit confirm (pick a project folder, or confirm you understand the sandbox is effectively off)".to_string()
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
}
