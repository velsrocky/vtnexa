pub(crate) mod approvals;
mod browser;
pub(crate) mod fsops;
mod git;
pub(crate) mod health;
mod keys;
pub(crate) mod lsp;
pub(crate) mod lsp_ops;
mod mcp;
pub(crate) mod mcp_oauth;
mod nexa;
pub(crate) mod pty;
pub(crate) mod rate_limiter;
pub(crate) mod sandbox;
mod shell;
pub(crate) mod shell_jobs;
mod skills;
pub(crate) mod util;
pub(crate) mod window;
pub(crate) mod workspace;

// Re-exports: names other backend modules address as `crate::X`.
pub(crate) use keys::KEY_SERVICE;
pub(crate) use shell::shell_deny_reason;
pub(crate) use util::{truncate_chars, write_atomic, MAX_CMD_BYTES, MAX_OUT_CHARS};
pub(crate) use workspace::{checked_path, root_snapshot, WorkspaceRoots};

use tauri::Manager;
use pty::PtyStore;
use window::next_window_label;
use workspace::AppSettings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch opens a NEW independent window (each window is
            // its own app instance with its own session file - no clobbering).
            let label = next_window_label(app);
            if let Ok(w) = tauri::WebviewWindowBuilder::new(
                app,
                &label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("VTNexa")
            .inner_size(1400.0, 900.0)
            .build()
            {
                let _ = w.set_focus();
            }
        }))
        .manage(PtyStore::default())
        .manage(WorkspaceRoots::default())
        .manage(AppSettings::default())
        .manage(browser::BrowserState::default())
        .manage(shell_jobs::ShellJobs::default())
        .manage(approvals::ApprovalStore::default())
        .manage(rate_limiter::RateLimiter::default())
        .manage(health::HealthMonitor::default())
        // Stop the browser sidecar only when the LAST window closes - other
        // windows would lose a running browser otherwise. kill_on_drop (set
        // at spawn) is the backstop for abnormal exits; this is the clean path.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                // Reap this window's per-window state: sandbox root + PTYs
                // (ids are namespaced "<window-label>:<n>" by the frontend).
                let label = window.label().to_string();
                if let Some(state) = window.try_state::<WorkspaceRoots>() {
                    if let Ok(mut m) = state.0.lock() {
                        m.remove(&label);
                    }
                }
                if let Some(store) = window.try_state::<PtyStore>() {
                    if let Ok(mut map) = store.0.lock() {
                        let doomed: Vec<String> = map
                            .keys()
                            .filter(|k| k.starts_with(&format!("{label}:")))
                            .cloned()
                            .collect();
                        for id in doomed {
                            if let Some(sess) = map.remove(&id) {
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
                }
                // <=1: robust to whether the destroyed window is still listed.
                if window.webview_windows().len() <= 1 {
                    if let Some(state) = window.try_state::<browser::BrowserState>() {
                        if let Ok(mut inner) = state.0.lock() {
                            if let Some(mut child) = inner.child.take() {
                                let _ = child.kill();
                                let _ = child.wait();
                            }
                        }
                    }
                    // Background shell jobs die with the app too: no orphans.
                    if let Some(jobs) = window.try_state::<shell_jobs::ShellJobs>() {
                        shell_jobs::kill_all_jobs(&jobs);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            window::create_window,
            workspace::update_trusted_paths,
            keys::key_get,
            keys::key_set,
            workspace::workspace_root,
            workspace::set_workspace_root,
            nexa::nexa_read,
            nexa::nexa_write,
            nexa::session_load,
            nexa::session_save,
            nexa::sessions_list,
            nexa::session_get,
            nexa::session_put,
            nexa::session_delete,
            nexa::routines_load,
            nexa::routines_save,
            skills::skill_list,
            skills::skill_read,
            fsops::fs_list,
            fsops::fs_read,
            fsops::fs_write,
            fsops::fs_create,
            fsops::fs_rename,
            fsops::fs_delete,
            fsops::fs_search,
            fsops::fs_glob,
            git::git_status,
            git::git_diff,
            git::git_commit,
            git::git_log,
            git::git_init,
            shell::shell_run,
            shell_jobs::shell_bg,
            shell_jobs::shell_poll,
            shell_jobs::shell_kill,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            browser::browser_start,
            browser::browser_stop,
            browser::browser_status,
            browser::browser_navigate,
            browser::browser_snapshot,
            browser::browser_click,
            browser::browser_type,
            browser::browser_screenshot,
            browser::browser_scroll,
            browser::browser_back,
            mcp::mcp_list_servers,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            mcp::mcp_config_get,
            mcp::mcp_set_server_enabled,
            mcp::mcp_workspace_trust,
            mcp_oauth::mcp_oauth_status,
            mcp_oauth::mcp_oauth_login,
            mcp_oauth::mcp_oauth_logout,
            lsp::lsp_diagnostics,
            lsp_ops::lsp_op,
            approvals::approval_issue,
            approvals::approval_claim
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
