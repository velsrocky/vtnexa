use crate::workspace::{checked_path, root_snapshot, WorkspaceRoots};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

// ---- Real PTY lanes ----
// Interactive terminal: USER-gesture only, never agent-callable.
// The agent's tool surface (TOOL_DEFS / runTool) has no pty_* entry, so the
// model cannot drive this shell — only keystrokes from TerminalPane reach
// pty_write. That is why there is no approval token here: an approval modal
// per keystroke would be unusable, and the threat model is "your shell, your
// responsibility" (same as any terminal emulator). Confinement is limited to
// workspace-root cwd + per-window id ownership below.
pub(crate) struct PtySession {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    // Kept for SIGKILL-on-kill: the child handle itself is moved into the
    // reader thread so it gets reaped there (no zombie until next respawn).
    pub(crate) pid: Option<u32>,
}

#[derive(Default)]
pub(crate) struct PtyStore(pub(crate) Mutex<HashMap<String, PtySession>>);

pub(crate) fn valid_pty_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 96 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
}

/// PTY ids are namespaced "<window-label>:<lane>". Enforce ownership so one
/// window cannot drive another's shell by guessing the id.
pub(crate) fn check_pty_owner(label: &str, id: &str) -> Result<(), String> {
    if !valid_pty_id(id) {
        return Err("pty: invalid id".to_string());
    }
    let prefix = format!("{}:", label);
    if label != "main" && !id.starts_with(&prefix) {
        // "main" is the legacy first window: allow "main:..." or bare ids
        // that start with "main:" only. Everything else must match caller.
        return Err("pty: id belongs to another window".to_string());
    }
    if label == "main" && !(id.starts_with("main:") || id == "main") {
        // Tighten even main: must be namespaced.
        if !id.starts_with(&prefix) {
            return Err("pty: id belongs to another window".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn pty_spawn(
    app: tauri::AppHandle,
    store: tauri::State<'_, PtyStore>,
    window: tauri::WebviewWindow,
    ws: tauri::State<'_, WorkspaceRoots>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    check_pty_owner(window.label(), &id)?;
    // kill existing session with same id (after validation - don't nuke a
    // valid PTY then fail to respawn and leave the lane headless)
    pty_kill_inner(&store, &id);
    // Interactive PTY is NOT agent-gated, but it must stay inside the workspace.
    let dir = if cwd.is_empty() || cwd == "." {
        root_snapshot(&ws, window.label())
    } else {
        let safe = checked_path(&ws, window.label(), cwd, "pty_spawn.cwd")?;
        if !safe.is_dir() {
            return Err("pty_spawn.cwd: not a directory".to_string());
        }
        safe
    };

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("bash");
    cmd.cwd(&dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // slave no longer needed in parent after spawn (dropped here)

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.try_clone_writer().map_err(|e| e.to_string())?;
    let pid = child.process_id();

    {
        let mut map = store.0.lock().map_err(|e| e.to_string())?;
        map.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                pid,
            },
        );
    }

    let out_event = format!("pty-output-{}", id);
    let exit_event = format!("pty-exit-{}", id);
    std::thread::spawn(move || {
        let mut child = child;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(&out_event, text);
                }
                Err(_) => break,
            }
        }
        // Reader hit EOF: the shell is gone (or dying). Reap it so it does not
        // linger as a zombie until the lane is respawned or the app exits.
        let reap_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {
                    if Instant::now() >= reap_deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
        let _ = app.emit(&exit_event, true);
    });

    Ok(())
}

pub(crate) fn pty_kill_inner(store: &tauri::State<'_, PtyStore>, id: &str) {
    if let Ok(mut map) = store.0.lock() {
        if let Some(sess) = map.remove(id) {
            // Closing master+writer hangs up the pty (kernel SIGHUPs the
            // child's foreground group); SIGKILL by pid is the belt, and the
            // reader thread reaps. Order matters: drop handles first.
            drop(sess.writer);
            drop(sess.master);
            #[cfg(unix)]
            if let Some(pid) = sess.pid {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) fn pty_write(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, PtyStore>,
    id: String,
    data: String,
) -> Result<(), String> {
    check_pty_owner(window.label(), &id)?;
    if data.len() > 64 * 1024 {
        return Err("pty_write: chunk too large".to_string());
    }
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    let sess = map.get_mut(&id).ok_or_else(|| format!("no pty: {}", id))?;
    sess.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    sess.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn pty_resize(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, PtyStore>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    check_pty_owner(window.label(), &id)?;
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    let sess = map.get_mut(&id).ok_or_else(|| format!("no pty: {}", id))?;
    sess.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn pty_kill(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, PtyStore>,
    id: String,
) -> Result<(), String> {
    check_pty_owner(window.label(), &id)?;
    pty_kill_inner(&store, &id);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_ids_are_window_bound() {
        assert!(check_pty_owner("main", "main:pty").is_ok());
        assert!(check_pty_owner("main-2", "main-2:pty").is_ok());
        assert!(check_pty_owner("main-2", "main:pty").is_err());
        assert!(check_pty_owner("main", "main-2:pty").is_err());
        assert!(check_pty_owner("main", "../../etc").is_err());
        assert!(check_pty_owner("main", "").is_err());
    }

    #[test]
    fn pty_stays_outside_the_agent_approval_surface() {
        // pty_* is user-gesture only: the agent gate must never claim it,
        // otherwise a future refactor could route agent output into a shell.
        for a in ["pty_spawn", "pty_write", "pty_resize", "pty_kill"] {
            assert!(
                !crate::approvals::is_privileged(a),
                "{} must stay user-only",
                a
            );
        }
    }
}
