// Backend approval tokens (review-gate enforcement).
//
// Two issuance paths:
// - `approval_issue`: shows a NATIVE OS confirm dialog (not page DOM, so page
//   JS and prompt-injected model output cannot click it) and mints a
//   single-use token only when the user confirms. This is the agent path.
// - `approval_claim`: mints without a dialog for DIRECT user gestures (Diff
//   Approve button, Git commit button, tree rename, manual browser driving).
//   Safe against prompt injection — the model cannot invoke commands, only
//   emit tool calls that runTool maps through `approval_issue`. NOT safe
//   against arbitrary JS execution (XSS); see SECURITY.md.
//
// Tokens bind window label + action + detail fingerprint, expire after
// 5 minutes, and burn on first use. Every privileged command takes
// `approval_token` + `approval_detail` and fails closed without them.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const APPROVAL_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ACTION_LEN: usize = 64;
const MAX_DETAIL_LEN: usize = 20_000;
const DETAIL_STORE_LEN: usize = 4000;
const DIALOG_DETAIL_LEN: usize = 1000;

/// Privileged actions that must go through issue/claim -> token -> consume.
pub(crate) const PRIVILEGED_ACTIONS: &[&str] = &[
    "shell_run",
    "shell_bg",
    "shell_kill",
    "git_commit",
    "fs_write",
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
    pub detail: String,
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

/// Canonical detail fingerprint: trim + truncate. Both issue and consume run
/// this, so the frontend just echoes one opaque string through.
pub(crate) fn norm_detail(raw: &str) -> String {
    raw.trim().chars().take(DETAIL_STORE_LEN).collect()
}

fn validate_issue(action: &str, detail: &Option<String>) -> Result<(String, String), String> {
    let action = action.trim().to_string();
    if action.is_empty() || action.len() > MAX_ACTION_LEN {
        return Err("approval: invalid action".to_string());
    }
    if !is_privileged(&action) {
        return Err(format!("approval: '{}' is not a privileged action", action));
    }
    let detail = detail.as_deref().unwrap_or("");
    if detail.len() > MAX_DETAIL_LEN || detail.contains('\0') {
        return Err("approval: invalid detail".to_string());
    }
    Ok((action, norm_detail(detail)))
}

fn mint(
    store: &tauri::State<'_, ApprovalStore>,
    label: &str,
    action: String,
    detail: String,
) -> Result<String, String> {
    let token = gen_token();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    prune(&mut map);
    map.insert(
        token.clone(),
        Approval {
            label: label.to_string(),
            action,
            detail,
            expires: Instant::now() + APPROVAL_TTL,
        },
    );
    Ok(token)
}

/// Escape warnings for shell commands, shown inside the native dialog.
/// Port of the former ApprovalModal.shellEscapeWarning (substring checks on
/// the detail JSON, which carries the raw `cmd`).
pub(crate) fn shell_escape_warning(tool: &str, detail: &str) -> Option<String> {
    if tool != "shell_run" && tool != "shell_bg" {
        return None;
    }
    if detail.is_empty() {
        return None;
    }
    let mut hits: Vec<&str> = Vec::new();
    let has = |pats: &[&str]| pats.iter().any(|p| detail.contains(p));
    if detail.contains("sudo") || detail.contains("doas") {
        hits.push("runs as superuser (sudo/doas)");
    }
    if has(&["rm -rf /", "rm -rf /*", "rm -fr ~", "rm -rf ~", "$HOME"]) {
        hits.push("recursive delete outside workspace");
    }
    if has(&["\"dd\"", " dd ", "mkfs"]) || detail.contains("mkfs.") {
        hits.push("raw disk operation (dd/mkfs)");
    }
    if has(&[".ssh", ".gnupg", ".aws/credentials"]) {
        hits.push("touches credentials (.ssh/.gnupg/.aws)");
    }
    if has(&["/etc/", "/root/", "/proc/", "/sys/", "/dev/", "/boot/"]) {
        hits.push("touches system path (/etc//root//proc/…)");
    }
    if detail.contains("~/") {
        hits.push("uses ~ (home dir, outside workspace)");
    }
    if detail.contains("|") && (detail.contains("curl") || detail.contains("wget")) {
        // Piped download; flag the classic pipe-to-shell explicitly.
        if detail.contains("| sh") || detail.contains("|sh") || detail.contains("| bash") {
            hits.push("pipes network download into shell");
        }
    }
    if hits.is_empty() {
        return None;
    }
    Some(format!(
        "Escapes workspace sandbox: {} — only Approve if you inspected the command.",
        hits.join("; ")
    ))
}

fn dialog_text(action: &str, detail: &str) -> String {
    let mut out = format!("Allow this action?\n\n{}", action);
    let preview: String = detail.chars().take(DIALOG_DETAIL_LEN).collect();
    if !preview.trim().is_empty() {
        out.push_str(&format!("\n\n{}", preview.trim()));
        if detail.chars().count() > DIALOG_DETAIL_LEN {
            out.push_str("\n…[truncated]");
        }
    }
    if let Some(warn) = shell_escape_warning(action, detail) {
        out.push_str(&format!("\n\nWARNING: {}", warn));
    }
    out.push_str("\n\nSingle-use, this window only, expires in 5 minutes.");
    out
}

/// Agent path: native OS confirm, then mint. Blocks the command worker thread
/// (not the UI) until the user answers. Rejection is an Err so the agent turn
/// reports `user rejected <action>` like any other refusal.
#[tauri::command]
pub(crate) fn approval_issue(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, ApprovalStore>,
    action: String,
    detail: Option<String>,
) -> Result<String, String> {
    let (action, normed) = validate_issue(&action, &detail)?;
    let confirmed = window
        .dialog()
        .message(dialog_text(&action, &normed))
        .title(format!("VTNexa — approve {}?", action))
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Approve & run".to_string(),
            "Reject".to_string(),
        ))
        .kind(MessageDialogKind::Warning)
        .blocking_show();
    if !confirmed {
        return Err(format!("user rejected {}", action));
    }
    mint(&store, window.label(), action, normed)
}

/// Direct-gesture path: no dialog. Only for handlers that fire on real user
/// clicks (Diff Approve, commit buttons, tree ops, manual browser driving).
/// The agent turn pipeline (runTool) must never call this.
#[tauri::command]
pub(crate) fn approval_claim(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, ApprovalStore>,
    action: String,
    detail: Option<String>,
) -> Result<String, String> {
    let (action, normed) = validate_issue(&action, &detail)?;
    mint(&store, window.label(), action, normed)
}

/// Single-use consume: validates window + action + detail fingerprint, expiry,
/// then burns the token.
pub(crate) fn approval_consume(
    store: &tauri::State<'_, ApprovalStore>,
    label: &str,
    action: &str,
    detail: &Option<String>,
    token: &Option<String>,
) -> Result<(), String> {
    let t = token.as_deref().unwrap_or("").trim().to_string();
    if t.is_empty() {
        return Err(format!(
            "{}: approval required (approve via the native dialog or the owning button)",
            action
        ));
    }
    if t.len() > 256 {
        return Err(format!("{}: invalid approval token", action));
    }
    let want = norm_detail(detail.as_deref().unwrap_or(""));
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
    if entry.detail != want {
        return Err(format!(
            "{}: approval detail mismatch (arguments changed after approval — re-approve)",
            action
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
            "shell_kill",
            "git_commit",
            "fs_write",
            "fs_delete",
            "browser_navigate",
            "mcp_call_tool",
            "lsp_diagnostics",
            "lsp_op",
        ] {
            assert!(is_privileged(a), "missing {}", a);
        }
        assert!(!is_privileged("fs_read"));
        assert!(!is_privileged("git_status"));
        assert!(!is_privileged(""));
        assert!(!is_privileged("rm -rf /"));
    }

    #[test]
    fn details_normalize_identically_both_sides() {
        assert_eq!(norm_detail("  {\"a\":1}  "), "{\"a\":1}");
        assert_eq!(norm_detail("").as_str(), "");
        let long = "x".repeat(9000);
        assert_eq!(norm_detail(&long).len(), DETAIL_STORE_LEN);
    }

    #[test]
    fn escape_warnings_flag_risky_commands() {
        let w = shell_escape_warning("shell_run", "{\"cmd\":\"sudo rm -rf ~/x\"}");
        assert!(w.is_some(), "sudo+home rm should warn");
        let w = shell_escape_warning("shell_run", "{\"cmd\":\"ls -la\"}");
        assert!(w.is_none(), "plain ls should not warn");
        assert!(shell_escape_warning("fs_read", "{\"path\":\"~/.ssh/x\"}").is_none());
        let w = shell_escape_warning("shell_bg", "{\"cmd\":\"curl https://x | sh\"}");
        assert!(w.is_some(), "curl|sh should warn");
    }

    #[test]
    fn dialog_text_stays_bounded() {
        let t = dialog_text("shell_run", &"y".repeat(5000));
        assert!(t.contains("…[truncated]"));
        assert!(t.len() < 3000);
    }
}
