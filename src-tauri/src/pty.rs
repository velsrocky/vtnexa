use crate::workspace::{checked_path, root_snapshot, WorkspaceRoots};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
    process: Arc<Mutex<PtyProcess>>,
    pub(crate) size: PtySize,
    active: Arc<AtomicBool>,
}

#[derive(Default)]
pub(crate) struct PtyStore(pub(crate) Mutex<HashMap<String, PtySession>>);

#[cfg(unix)]
struct UnixPtyProcess {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    reaped: bool,
    tree: crate::process::UnixTree,
}

#[cfg(unix)]
fn unix_pty_child_exited(child: &(dyn portable_pty::Child + Send + Sync)) -> std::io::Result<bool> {
    let pid = child
        .process_id()
        .and_then(|pid| libc::pid_t::try_from(pid).ok())
        .filter(|pid| *pid > 0)
        .ok_or_else(|| std::io::Error::other("PTY child process ID is invalid"))?;
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    loop {
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(unsafe { info.si_pid() } == pid);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(error);
    }
}

#[cfg(unix)]
fn terminate_unix_pty(process: &mut UnixPtyProcess) -> std::io::Result<()> {
    if process.reaped {
        return Ok(());
    }
    unix_pty_child_exited(process.child.as_ref())?;
    let cleanup = process.tree.terminate();
    let wait = process.child.wait();
    match wait {
        Ok(_) => {
            process.reaped = true;
            let reap = process.tree.reap_collected();
            match (cleanup, reap) {
                (Err(error), Ok(())) => Err(error),
                (Ok(()), Err(error)) => Err(error),
                (Err(cleanup), Err(reap)) => Err(std::io::Error::other(format!(
                    "{cleanup}; descendant reaping failed: {reap}"
                ))),
                (Ok(()), Ok(())) => Ok(()),
            }
        }
        Err(wait) => match cleanup {
            Ok(()) => Err(wait),
            Err(cleanup) => Err(std::io::Error::other(format!(
                "{cleanup}; PTY child wait failed: {wait}"
            ))),
        },
    }
}

enum PtyProcess {
    #[cfg(unix)]
    Unix(UnixPtyProcess),
    #[cfg(windows)]
    Windows(crate::windows_job::JobHandle),
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

impl PtyProcess {
    #[cfg(unix)]
    fn try_reap(&mut self) -> std::io::Result<bool> {
        match self {
            Self::Unix(process) => {
                if process.reaped {
                    return Ok(true);
                }
                if !unix_pty_child_exited(process.child.as_ref())? {
                    return Ok(false);
                }
                terminate_unix_pty(process)?;
                Ok(true)
            }
        }
    }

    #[cfg(windows)]
    fn try_reap(
        &mut self,
        child: &mut (dyn portable_pty::Child + Send + Sync),
    ) -> std::io::Result<bool> {
        match self {
            Self::Windows(job) => {
                let exited = child.try_wait()?.is_some();
                if exited {
                    job.try_terminate()?;
                }
                Ok(exited)
            }
        }
    }

    fn terminate(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(process) => terminate_unix_pty(process),
            #[cfg(windows)]
            Self::Windows(job) => {
                job.terminate();
                Ok(())
            }
        }
    }
}

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

fn resolve_pty_cwd(
    ws: &tauri::State<'_, WorkspaceRoots>,
    label: &str,
    cwd: String,
    what: &str,
) -> Result<PathBuf, String> {
    if cwd.is_empty() || cwd == "." {
        return Ok(root_snapshot(ws, label));
    }
    let safe = checked_path(ws, label, cwd, what)?;
    if !safe.is_dir() {
        return Err(format!("{}: not a directory", what));
    }
    Ok(safe)
}

pub(crate) fn retire_session(session: PtySession) {
    session.active.store(false, Ordering::Release);
    if let Ok(mut process) = session.process.lock() {
        let _ = process.terminate();
    }
    drop(session.writer);
    drop(session.master);
}

fn spawn_pty_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    store: &tauri::State<'_, PtyStore>,
    id: String,
    dir: PathBuf,
    size: PtySize,
) -> Result<(), String> {
    #[cfg(unix)]
    crate::process::ensure_unix_tree_ready().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let tree_token = crate::process::new_unix_tree_token()
        .ok_or_else(|| "PTY process tree token is unavailable".to_string())?;
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    #[cfg(not(windows))]
    let mut cmd = CommandBuilder::new("bash");
    #[cfg(windows)]
    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.cwd(&dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    #[cfg(unix)]
    {
        cmd.env_remove(crate::process::unix_tree_token_env());
        cmd.env(crate::process::unix_tree_token_env(), &tree_token);
    }

    #[cfg(windows)]
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let tree = match child
        .process_id()
        .ok_or_else(|| "PTY child process ID is unavailable".to_string())
        .and_then(|pid| {
            crate::process::UnixTree::capture(pid, Some(tree_token))
                .map_err(|error| error.to_string())
        }) {
        Ok(tree) => tree,
        Err(error) => {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(unix)]
    let process = Arc::new(Mutex::new(PtyProcess::Unix(UnixPtyProcess {
        child,
        reaped: false,
        tree,
    })));
    #[cfg(windows)]
    let process = {
        let job = match crate::windows_job::JobHandle::new() {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let Some(handle) = child.as_raw_handle() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("pty: Windows child process handle is unavailable".to_string());
        };
        if let Err(error) = job.assign_handle(handle as _) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Arc::new(Mutex::new(PtyProcess::Windows(job)))
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            if let Ok(mut owned) = process.lock() {
                let _ = owned.terminate();
            }
            #[cfg(windows)]
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(error.to_string());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            if let Ok(mut owned) = process.lock() {
                let _ = owned.terminate();
            }
            #[cfg(windows)]
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(error.to_string());
        }
    };
    let active = Arc::new(AtomicBool::new(true));
    let session = PtySession {
        master: pair.master,
        writer,
        process: process.clone(),
        size,
        active: active.clone(),
    };

    let mut map = match store.0.lock() {
        Ok(map) => map,
        Err(error) => {
            if let Ok(mut owned) = process.lock() {
                let _ = owned.terminate();
            }
            #[cfg(windows)]
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(error.to_string());
        }
    };
    if let Some(previous) = map.insert(id.clone(), session) {
        retire_session(previous);
    }
    drop(map);

    let out_event = format!("pty-output-{}", id);
    let exit_event = format!("pty-exit-{}", id);
    let owner = window.label().to_string();
    std::thread::spawn(move || {
        #[cfg(windows)]
        let mut child = child;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if active.load(Ordering::Acquire) {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app.emit_to(
                            tauri::EventTarget::webview_window(owner.clone()),
                            &out_event,
                            text,
                        );
                    }
                }
                Err(_) => break,
            }
        }
        let reap_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let reaped = match process.lock() {
                Ok(mut owned) => {
                    #[cfg(unix)]
                    {
                        owned.try_reap()
                    }
                    #[cfg(windows)]
                    {
                        owned.try_reap(child.as_mut())
                    }
                }
                Err(_) => Err(std::io::Error::other("PTY process state lock poisoned")),
            };
            match reaped {
                Ok(true) => break,
                Ok(false) => {
                    if Instant::now() >= reap_deadline {
                        if let Ok(mut owned) = process.lock() {
                            let _ = owned.terminate();
                        }
                        #[cfg(windows)]
                        {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    if let Ok(mut owned) = process.lock() {
                        let _ = owned.terminate();
                    }
                    #[cfg(windows)]
                    {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    break;
                }
            }
        }
        if active.load(Ordering::Acquire) {
            let _ = app.emit_to(
                tauri::EventTarget::webview_window(owner.clone()),
                &exit_event,
                true,
            );
        }
    });

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
    let dir = resolve_pty_cwd(&ws, window.label(), cwd, "pty_spawn.cwd")?;
    spawn_pty_session(
        app,
        window,
        &store,
        id,
        dir,
        PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        },
    )
}

#[tauri::command]
pub(crate) fn pty_set_cwd(
    app: tauri::AppHandle,
    store: tauri::State<'_, PtyStore>,
    window: tauri::WebviewWindow,
    ws: tauri::State<'_, WorkspaceRoots>,
    id: String,
    cwd: String,
) -> Result<(), String> {
    check_pty_owner(window.label(), &id)?;
    let dir = resolve_pty_cwd(&ws, window.label(), cwd, "pty_set_cwd.cwd")?;
    let size = store
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .map(|session| session.size)
        .unwrap_or_default();
    spawn_pty_session(app, window, &store, id, dir, size)
}

pub(crate) fn pty_kill_inner(store: &tauri::State<'_, PtyStore>, id: &str) {
    if let Ok(mut map) = store.0.lock() {
        if let Some(session) = map.remove(id) {
            retire_session(session);
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
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    sess.master.resize(size).map_err(|e| e.to_string())?;
    sess.size = size;
    Ok(())
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

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn pty_cleanup_kills_descendant_session() {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("vtnexa-pty-tree-{id}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let child_path = dir.join("child.pid");
        let grandchild_path = dir.join("grandchild.pid");
        let script = "setsid sleep 30 & grandchild=$!; printf '%s' \"$grandchild\" > \"$VTNEXA_PTY_GRANDCHILD_PID\"; printf '%s' \"$$\" > \"$VTNEXA_PTY_CHILD_PID\"; wait \"$grandchild\"";
        let mut command = CommandBuilder::new("sh");
        command.arg("-c");
        command.arg(script);
        command.env("VTNEXA_PTY_CHILD_PID", &child_path);
        command.env("VTNEXA_PTY_GRANDCHILD_PID", &grandchild_path);
        crate::process::ensure_unix_tree_ready().unwrap();
        let token = crate::process::new_unix_tree_token().unwrap();
        command.env(crate::process::unix_tree_token_env(), &token);
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let child = pair.slave.spawn_command(command).unwrap();
        let tree =
            crate::process::UnixTree::capture(child.process_id().unwrap(), Some(token)).unwrap();
        let process = PtyProcess::Unix(UnixPtyProcess {
            child,
            reaped: false,
            tree,
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let child_pid = loop {
            if let Ok(pid) = std::fs::read_to_string(&child_path) {
                if let Ok(pid) = pid.trim().parse::<i32>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "PTY PID file was not written");
            std::thread::sleep(Duration::from_millis(10));
        };
        let grandchild_pid = loop {
            if let Ok(pid) = std::fs::read_to_string(&grandchild_path) {
                if let Ok(pid) = pid.trim().parse::<i32>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "PTY PID file was not written");
            std::thread::sleep(Duration::from_millis(10));
        };
        drop(process);
        let deadline = Instant::now() + Duration::from_secs(2);
        while [child_pid, grandchild_pid]
            .iter()
            .any(|pid| unsafe { libc::kill(*pid, 0) } == 0)
        {
            assert!(Instant::now() < deadline, "PTY process tree is still alive");
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

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
        for a in [
            "pty_spawn",
            "pty_set_cwd",
            "pty_write",
            "pty_resize",
            "pty_kill",
        ] {
            assert!(
                !crate::approvals::is_privileged(a),
                "{} must stay user-only",
                a
            );
        }
    }
}
