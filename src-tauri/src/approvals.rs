// Backend approval tokens (review-gate enforcement).
//
// The frontend ApprovalModal is UX; this store is the enforcement point.
// Privileged commands (shell_*, git_commit, fs_rename/delete, browser_*,
// mcp_call_tool, lsp exec paths) require a single-use token minted via
// `approval_issue` AFTER the user clicks Approve, bound to the calling
// window label + action, expiring after 5 minutes.
//
// Why not detail-bound (yet): exact arg canonicalization between JS/Rust
// risks false rejects breaking legit flows. Single-use + window + action +
// TTL already prevents: replay across windows, replay across actions, stale
// reuse, and silent renderer calls without an explicit issue step (which is
// where a future native OS confirm will live).
//
// Future: make `approval_issue` itself show a native OS confirm dialog
// (not HTML) so XSS cannot self-approve. The choke point is already here.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const APPROVAL_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ACTION_LEN: usize = 64;
const MAX_DETAIL_LEN: usize = 20_000;

/// Privileged actions that must go through approval_issue -> token -> consume.
pub(crate) const PRIVILEGED_ACTIONS: &[&str] = &[
    "shell_run",
    "shell_bg",
    "shell_kill",
    "git_commit",
    "fs_rename",
    "fs_delete",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_back",
    "mcp_call_tool",
    "lsp_diagnostics",
    "lsp_op",
];

pub(crate) struct Approval {
    pub label: String,
    pub action: String,
    pub expires: Instant,
}

#[derive(Default)]
pub(crate) struct ApprovalStore(pub Mutex<HashMap<String, Approval>>);

fn gen_token() -> String {
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let mut bytes = [0u8; 32];
        if std::io::Read::read_exact(&mut f, &mut bytes).is_ok() {
            return bytes.iter().map(|b| format!("{:02x}", b)).collect();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "fallback-{:x}-{}-{}",
        nanos,
        std::process::id(),
        nanos.wrapping_mul(0x9E3779B97F4A7C15)
    )
}

fn prune(map: &mut HashMap<String, Approval>) {
    let now = Instant::now();
    map.retain(|_, a| a.expires > now);
}

pub(crate) fn is_privileged(action: &str) -> bool {
    PRIVILEGED_ACTIONS.contains(&action)
}

#[tauri::command]
pub(crate) fn approval_issue(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, ApprovalStore>,
    action: String,
    _detail: Option<String>,
) -> Result<String, String> {
    let action = action.trim().to_string();
    if action.is_empty() || action.len() > MAX_ACTION_LEN {
        return Err("approval_issue: invalid action".to_string());
    }
    if !is_privileged(&action) {
        return Err(format!(
            "approval_issue: '{}' is not a privileged action",
            action
        ));
    }
    if let Some(d) = &_detail {
        if d.len() > MAX_DETAIL_LEN || d.contains('\0') {
            return Err("approval_issue: invalid detail".to_string());
        }
    }
    let token = gen_token();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    prune(&mut map);
    map.insert(
        token.clone(),
        Approval {
            label: window.label().to_string(),
            action,
            expires: Instant::now() + APPROVAL_TTL,
        },
    );
    Ok(token)
}

/// Single-use consume: validates window + action, expiry, then burns the token.
pub(crate) fn approval_consume(
    store: &tauri::State<'_, ApprovalStore>,
    label: &str,
    action: &str,
    token: &Option<String>,
) -> Result<(), String> {
    let t = token.as_deref().unwrap_or("").trim().to_string();
    if t.is_empty() {
        return Err(format!(
            "{}: approval required (request via approval_issue after user Approve)",
            action
        ));
    }
    if t.len() > 256 {
        return Err(format!("{}: invalid approval token", action));
    }
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    prune(&mut map);
    let entry = map.remove(&t).ok_or_else(|| {
        format!(
            "{}: invalid or expired approval (single-use, 5min, this window only)",
            action
        )
    })?;
    if entry.label != label {
        return Err(format!(
            "{}: approval issued for another window (cross-window replay refused)",
            action
        ));
    }
    if entry.action != action {
        return Err(format!(
            "{}: approval was issued for '{}' (cross-action replay refused)",
            action, entry.action
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privileged_set_covers_side_effects() {
        for a in [
            "shell_run",
            "shell_bg",
            "git_commit",
            "fs_delete",
            "browser_navigate",
            "mcp_call_tool",
        ] {
            assert!(is_privileged(a), "missing {}", a);
        }
        assert!(!is_privileged("fs_read"));
        assert!(!is_privileged("git_status"));
    }

    #[test]
    fn rejects_unknown_action_names() {
        assert!(!is_privileged(""));
        assert!(!is_privileged("rm -rf /"));
        assert!(!is_privileged("shell_run; evil"));
    }
}
