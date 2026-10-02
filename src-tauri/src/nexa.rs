use crate::util::{truncate_chars, write_atomic};
use crate::workspace::{
    checked_internal_path, ensure_internal_parents, root_snapshot, WorkspaceRoots,
};
use std::io::Read;

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

fn read_bounded_internal_bytes(
    root: &std::path::Path,
    relative: &std::path::Path,
    max: usize,
    what: &str,
) -> Result<Vec<u8>, (std::io::ErrorKind, String)> {
    let path = checked_internal_path(root, relative, what)
        .map_err(|error| (std::io::ErrorKind::Other, error))?;
    let file = std::fs::File::open(&path).map_err(|error| (error.kind(), error.to_string()))?;
    let metadata = file
        .metadata()
        .map_err(|error| (error.kind(), error.to_string()))?;
    if !metadata.is_file() {
        return Err((
            std::io::ErrorKind::InvalidData,
            format!("{}: not a regular file", what),
        ));
    }
    if metadata.len() > max as u64 {
        return Err((
            std::io::ErrorKind::InvalidData,
            format!(
                "{}: file too large ({} bytes, max {})",
                what,
                metadata.len(),
                max
            ),
        ));
    }
    checked_internal_path(root, relative, what)
        .map_err(|error| (std::io::ErrorKind::Other, error))?;
    let capacity = usize::try_from(metadata.len()).unwrap_or(0).min(max);
    let mut bytes = Vec::with_capacity(capacity);
    let limit = max as u64 + 1;
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| (error.kind(), error.to_string()))?;
    if bytes.len() > max {
        return Err((
            std::io::ErrorKind::InvalidData,
            format!("{}: file too large (more than {} bytes)", what, max),
        ));
    }
    Ok(bytes)
}

fn read_capped(
    root: &std::path::Path,
    relative: &std::path::Path,
    max: usize,
    what: &str,
) -> Result<String, String> {
    let bytes = match read_bounded_internal_bytes(root, relative, max, what) {
        Ok(bytes) => bytes,
        Err((std::io::ErrorKind::NotFound, _)) => return Err("__not_found__".to_string()),
        Err((_, error)) => return Err(error),
    };
    String::from_utf8(bytes).map_err(|_| format!("{}: file is not valid UTF-8", what))
}

#[allow(dead_code)]
pub(crate) fn nexa_path_for(
    root: &std::path::Path,
    kind: &str,
) -> Result<std::path::PathBuf, String> {
    Ok(root.join(".nexa").join(nexa_filename(kind)?))
}

#[tauri::command]
pub(crate) fn nexa_read(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    kind: String,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let relative = std::path::Path::new(".nexa").join(nexa_filename(&kind)?);
    match read_capped(&root, &relative, NEXA_MAX_BYTES, "nexa_read") {
        Ok(content) => Ok(truncate_chars(content, NEXA_MAX_BYTES)),
        Err(error) if error == "__not_found__" => Ok(String::new()),
        Err(error) => Err(error),
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
    let relative = std::path::Path::new(".nexa").join(nexa_filename(&kind)?);
    ensure_internal_parents(&root, &relative, "nexa_write")?;
    let path = checked_internal_path(&root, &relative, "nexa_write")?;
    write_atomic(&path, content.as_bytes())
}

// ---- Session persistence ----
// Full lane/chat state lives at <workspace>/.nexa/session.json so a restart
// restores the workspace exactly as it was left. Larger cap than the notes.
pub(crate) const SESSION_MAX_BYTES: usize = 2 * 1024 * 1024;

#[allow(dead_code)]
pub(crate) fn session_path_for(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".nexa").join("session.json")
}

#[tauri::command]
pub(crate) fn session_load(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let relative = std::path::Path::new(".nexa/session.json");
    match read_capped(&root, relative, SESSION_MAX_BYTES, "session") {
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
    let relative = std::path::Path::new(".nexa/session.json");
    ensure_internal_parents(&root, relative, "session_save")?;
    let path = checked_internal_path(&root, relative, "session_save")?;
    write_atomic(&path, content.as_bytes())
}

// ---- Named sessions (.nexa/sessions/<id>.json) ----
// OpenCode-style: many sessions per directory, newest-first list, explicit
// resume. The app always boots a FRESH session; the user resumes a previous
// one from the dropdown. The legacy single `.nexa/session.json` is left
// untouched as a backup and is never read by the new flow.
pub(crate) const SESSIONS_MAX_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const SESSIONS_LIST_LIMIT: usize = 100;

#[allow(dead_code)]
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

#[allow(dead_code)]
pub(crate) fn session_file_for(
    root: &std::path::Path,
    id: &str,
) -> Result<std::path::PathBuf, String> {
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

fn session_meta_from_bounded_file(
    root: &std::path::Path,
    relative: &std::path::Path,
    id: &str,
) -> Option<SessionMeta> {
    let bytes = read_bounded_internal_bytes(root, relative, SESSIONS_MAX_BYTES, "session").ok()?;
    let value = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
    Some(session_meta_from_value(id, &value))
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
    let relative_dir = std::path::Path::new(".nexa/sessions");
    let dir = checked_internal_path(&root, relative_dir, "sessions_list")?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok("[]".to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut out: Vec<SessionMeta> = Vec::new();
    for e in entries.flatten().take(SESSIONS_LIST_LIMIT * 2) {
        let file_name = e.file_name();
        let relative = relative_dir.join(&file_name);
        let path = checked_internal_path(&root, &relative, "sessions_list")?;
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_session_id(stem) {
            continue;
        }
        let Some(meta) = session_meta_from_bounded_file(&root, &relative, stem) else {
            continue;
        };
        out.push(meta);
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
    if !valid_session_id(&id) {
        return Err("session: invalid id (letters, numbers, -, _; 64 max)".to_string());
    }
    let relative = std::path::Path::new(".nexa/sessions").join(format!("{}.json", id));
    match read_capped(&root, &relative, SESSIONS_MAX_BYTES, "session") {
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
    if !valid_session_id(&id) {
        return Err("session: invalid id (letters, numbers, -, _; 64 max)".to_string());
    }
    let relative = std::path::Path::new(".nexa/sessions").join(format!("{}.json", id));
    ensure_internal_parents(&root, &relative, "session_put")?;
    let path = checked_internal_path(&root, &relative, "session_put")?;
    write_atomic(&path, content.as_bytes())
}

#[tauri::command]
pub(crate) fn session_delete(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    id: String,
) -> Result<(), String> {
    let root = root_snapshot(&state, window.label());
    if !valid_session_id(&id) {
        return Err("session: invalid id (letters, numbers, -, _; 64 max)".to_string());
    }
    let relative = std::path::Path::new(".nexa/sessions").join(format!("{}.json", id));
    checked_internal_path(&root, &relative, "session_delete")?;
    let path = checked_internal_path(&root, &relative, "session_delete")?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Routines persistence (.nexa/routines.json) ----
pub(crate) const ROUTINES_MAX_BYTES: usize = 256 * 1024;

#[allow(dead_code)]
pub(crate) fn routines_path_for(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".nexa").join("routines.json")
}

#[tauri::command]
pub(crate) fn routines_load(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
) -> Result<String, String> {
    let root = root_snapshot(&state, window.label());
    let relative = std::path::Path::new(".nexa/routines.json");
    match read_capped(&root, relative, ROUTINES_MAX_BYTES, "routines") {
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
    let relative = std::path::Path::new(".nexa/routines.json");
    ensure_internal_parents(&root, relative, "routines_save")?;
    let path = checked_internal_path(&root, relative, "routines_save")?;
    write_atomic(&path, content.as_bytes())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root(label: &str) -> std::path::PathBuf {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("vtnexa-nexa-{label}-{id}"));
        std::fs::create_dir_all(root.join(".nexa/sessions")).unwrap();
        root
    }

    fn make_oversized(path: &std::path::Path, prefix: &[u8], size: usize) {
        std::fs::write(path, prefix).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(size as u64)
            .unwrap();
    }

    #[test]
    fn oversized_note_is_rejected_before_utf8_use() {
        let root = fixture_root("oversized-note");
        let path = root.join(".nexa/pad.md");
        make_oversized(&path, b"# heading\nvisible\n", NEXA_MAX_BYTES + 1);
        let error = read_capped(
            &root,
            std::path::Path::new(".nexa/pad.md"),
            NEXA_MAX_BYTES,
            "nexa_read",
        )
        .unwrap_err();
        assert!(error.contains("file too large"), "got: {}", error);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_session_is_rejected_before_utf8_use() {
        let root = fixture_root("oversized-session");
        let path = root.join(".nexa/session.json");
        make_oversized(&path, br#"{"title":"visible"}"#, SESSION_MAX_BYTES + 1);
        let error = read_capped(
            &root,
            std::path::Path::new(".nexa/session.json"),
            SESSION_MAX_BYTES,
            "session",
        )
        .unwrap_err();
        assert!(error.contains("file too large"), "got: {}", error);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_named_session_is_skipped_without_partial_parse() {
        let root = fixture_root("oversized-named-session");
        let relative = std::path::Path::new(".nexa/sessions/large.json");
        make_oversized(
            &root.join(relative),
            br#"{"title":"visible","updated":1}"#,
            SESSIONS_MAX_BYTES + 1,
        );
        assert!(session_meta_from_bounded_file(&root, relative, "large").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

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
