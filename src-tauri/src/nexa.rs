use crate::util::{truncate_chars, write_atomic};
use crate::workspace::{root_snapshot, WorkspaceRoots};

// ---- Nexa Pad/Plan: two small live files the agent can read AND write ----
// Confined by construction: `kind` is an enum, never a path, so there is no
// traversal vector. Files live at <workspace>/.nexa/{pad,plan}.md and are
// injected into every agent turn, hence the tight size cap.
pub(crate) const NEXA_MAX_BYTES: usize = 16 * 1024;

pub(crate) fn nexa_filename(kind: &str) -> Result<&'static str, String> {
    match kind {
        "pad" => Ok("pad.md"),
        "plan" => Ok("plan.md"),
        "memory" => Ok("memory.md"),
        _ => Err("nexa: kind must be \"pad\", \"plan\" or \"memory\"".to_string()),
    }
}

/// Size-checked read: refuse files bigger than `max` BEFORE loading them
/// into memory (metadata gate + post-read check against TOCTOU growth).
fn read_capped(path: &std::path::Path, max: usize, what: &str) -> Result<String, String> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > max as u64 {
            return Err(format!(
                "{}: file too large ({} bytes, max {})",
                what,
                meta.len(),
                max
            ));
        }
    }
    let s = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("__not_found__".to_string()),
        Err(e) => return Err(e.to_string()),
    };
    if s.len() > max {
        return Err(format!(
            "{}: file too large ({} bytes, max {})",
            what,
            s.len(),
            max
        ));
    }
    Ok(s)
}

pub(crate) fn nexa_path_for(root: &std::path::Path, kind: &str) -> Result<std::path::PathBuf, String> {
    Ok(root.join(".nexa").join(nexa_filename(kind)?))
}

#[tauri::command]
pub(crate) fn nexa_read(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    kind: String,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let path = nexa_path_for(&root, &kind)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(truncate_chars(s, NEXA_MAX_BYTES)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub(crate) fn nexa_write(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    kind: String,
    content: String,
) -> Result<(), String> {
    if content.contains('\0') {
        return Err("nexa: invalid content".to_string());
    }
    if content.len() > NEXA_MAX_BYTES {
        return Err(format!(
            "nexa: content too large ({} bytes, max {}). Keep notes short - they ride along on every turn.",
            content.len(),
            NEXA_MAX_BYTES
        ));
    }
    let root = root_snapshot(&state, window.label());
    let path = nexa_path_for(&root, &kind)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, content.as_bytes())
}

// ---- Session persistence ----
// Full lane/chat state lives at <workspace>/.nexa/session.json so a restart
// restores the workspace exactly as it was left. Larger cap than the notes.
pub(crate) const SESSION_MAX_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn session_path_for(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".nexa").join("session.json")
}

#[tauri::command]
pub(crate) fn session_load(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let path = session_path_for(&root);
    match read_capped(&path, SESSION_MAX_BYTES, "session") {
        Ok(s) => Ok(s),
        Err(e) if e == "__not_found__" => Ok(String::new()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub(crate) fn session_save(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    content: String,
) -> Result<(), String> {
    if content.contains('\0') {
        return Err("session: invalid content".to_string());
    }
    if content.len() > SESSION_MAX_BYTES {
        return Err(format!(
            "session: content too large ({} bytes, max {})",
            content.len(),
            SESSION_MAX_BYTES
        ));
    }
    let root = root_snapshot(&state, window.label());
    let path = session_path_for(&root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, content.as_bytes())
}

// ---- Named sessions (.nexa/sessions/<id>.json) ----
// OpenCode-style: many sessions per directory, newest-first list, explicit
// resume. The app always boots a FRESH session; the user resumes a previous
// one from the dropdown. The legacy single `.nexa/session.json` is left
// untouched as a backup and is never read by the new flow.
pub(crate) const SESSIONS_MAX_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const SESSIONS_LIST_LIMIT: usize = 100;

pub(crate) fn sessions_dir_for(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".nexa").join("sessions")
}

pub(crate) fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn session_file_for(root: &std::path::Path, id: &str) -> Result<std::path::PathBuf, String> {
    if !valid_session_id(id) {
        return Err("session: invalid id (letters, numbers, -, _; 64 max)".to_string());
    }
    Ok(sessions_dir_for(root).join(format!("{}.json", id)))
}

#[derive(Debug, serde::Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub directory: String,
    pub created: i64,
    pub updated: i64,
    pub message_count: usize,
    pub preview: String,
}

pub(crate) fn session_meta_from_value(id: &str, v: &serde_json::Value) -> SessionMeta {
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("Untitled session")
        .chars()
        .take(120)
        .collect::<String>();
    let directory = v
        .get("directory")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let created = v.get("created").and_then(|t| t.as_i64()).unwrap_or(0);
    let updated = v.get("updated").and_then(|t| t.as_i64()).unwrap_or(created);
    let (message_count, preview) = match v.get("workspace").and_then(|w| w.get("messages")) {
        Some(serde_json::Value::Array(msgs)) => {
            let count = msgs.len();
            let first_user = msgs
                .iter()
                .filter_map(|m| {
                    let role_ok = m.get("role").and_then(|r| r.as_str()) == Some("user");
                    let text = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                    if role_ok && !text.trim().is_empty() {
                        Some(text.trim().chars().take(160).collect::<String>())
                    } else {
                        None
                    }
                })
                .next()
                .unwrap_or_default();
            (count, first_user)
        }
        _ => (0, String::new()),
    };
    SessionMeta {
        id: id.to_string(),
        title,
        directory,
        created,
        updated,
        message_count,
        preview,
    }
}

#[tauri::command]
pub(crate) fn sessions_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let dir = sessions_dir_for(&root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok("[]".to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut out: Vec<SessionMeta> = Vec::new();
    for e in entries.flatten().take(SESSIONS_LIST_LIMIT * 2) {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_session_id(stem) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.len() > SESSIONS_MAX_BYTES {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue; // skip corrupt files, never fail the whole list
        };
        out.push(session_meta_from_value(stem, &v));
        if out.len() >= SESSIONS_LIST_LIMIT {
            break;
        }
    }
    // Newest-first, like `opencode session list` (time_updated DESC).
    out.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| b.id.cmp(&a.id)));
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn session_get(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    id: String,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let path = session_file_for(&root, &id)?;
    match read_capped(&path, SESSIONS_MAX_BYTES, "session") {
        Ok(s) => Ok(s),
        Err(e) if e == "__not_found__" => Err("session: not found".to_string()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub(crate) fn session_put(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    id: String,
    content: String,
) -> Result<(), String> {
    if content.contains('\0') {
        return Err("session: invalid content".to_string());
    }
    if content.len() > SESSIONS_MAX_BYTES {
        return Err(format!(
            "session: content too large ({} bytes, max {})",
            content.len(),
            SESSIONS_MAX_BYTES
        ));
    }
    // Validate JSON early so the list reader never chokes on it later.
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("session: invalid JSON: {}", e))?;
    let root = root_snapshot(&state, window.label());
    let path = session_file_for(&root, &id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, content.as_bytes())
}

#[tauri::command]
pub(crate) fn session_delete(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    id: String,
) -> Result<(), String> {
    let root = root_snapshot(&state, window.label());
    let path = session_file_for(&root, &id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Routines persistence (.nexa/routines.json) ----
pub(crate) const ROUTINES_MAX_BYTES: usize = 256 * 1024;

pub(crate) fn routines_path_for(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".nexa").join("routines.json")
}

#[tauri::command]
pub(crate) fn routines_load(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let path = routines_path_for(&root);
    match read_capped(&path, ROUTINES_MAX_BYTES, "routines") {
        Ok(s) => Ok(s),
        Err(e) if e == "__not_found__" => Ok(String::new()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub(crate) fn routines_save(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    content: String,
) -> Result<(), String> {
    if content.contains('\0') {
        return Err("routines: invalid content".to_string());
    }
    if content.len() > ROUTINES_MAX_BYTES {
        return Err(format!(
            "routines: content too large ({} bytes, max {})",
            content.len(),
            ROUTINES_MAX_BYTES
        ));
    }
    let root = root_snapshot(&state, window.label());
    let path = routines_path_for(&root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, content.as_bytes())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nexa_paths_stay_inside_root() {
        let root = std::path::PathBuf::from("/tmp/some-workspace");
        assert_eq!(
            nexa_path_for(&root, "pad").unwrap(),
            std::path::PathBuf::from("/tmp/some-workspace/.nexa/pad.md")
        );
        assert_eq!(
            nexa_path_for(&root, "plan").unwrap(),
            std::path::PathBuf::from("/tmp/some-workspace/.nexa/plan.md")
        );
        // confinement by construction
        assert!(nexa_path_for(&root, "pad").unwrap().starts_with(&root));
        assert!(nexa_path_for(&root, "plan").unwrap().starts_with(&root));
        // kind is an enum: traversal / typos rejected, never touch fs
        for bad in [
            "",
            "PAD",
            "../evil",
            "pad.md",
            ".nexa/pad.md",
            "/etc/passwd",
        ] {
            assert!(
                nexa_path_for(&root, bad).is_err(),
                "kind {:?} must be rejected",
                bad
            );
        }
    }
    #[test]
    fn session_ids_are_validated() {
        for good in ["ses_abc123", "a", "A-1_2", &"x".repeat(64)] {
            assert!(valid_session_id(good), "should accept: {}", good);
        }
        for bad in [
            "",
            "../evil",
            "a/b",
            "a.json",
            "a b",
            ".hidden",
            &"x".repeat(65),
        ] {
            assert!(!valid_session_id(bad), "should reject: {}", bad);
        }
        // Traversal can never become a file path.
        let root = std::path::PathBuf::from("/tmp/ws");
        assert!(session_file_for(&root, "../evil").is_err());
        assert_eq!(
            session_file_for(&root, "ses_1").unwrap(),
            std::path::PathBuf::from("/tmp/ws/.nexa/sessions/ses_1.json")
        );
    }
    #[test]
    fn session_meta_extracts_preview() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"title":"Fix bug","directory":"/w","created":1,"updated":2,
                "workspace":{"messages":[
                  {"role":"user","content":"  hello world  "},
                  {"role":"assistant","content":"hi"}]}}"#,
        )
        .unwrap();
        let m = session_meta_from_value("ses_1", &v);
        assert_eq!(m.title, "Fix bug");
        assert_eq!(m.message_count, 2);
        assert_eq!(m.preview, "hello world");
        // Missing fields degrade gracefully (never fail the list).
        let empty = session_meta_from_value("ses_2", &serde_json::json!({}));
        assert_eq!(empty.title, "Untitled session");
        assert_eq!(empty.message_count, 0);
    }
}
