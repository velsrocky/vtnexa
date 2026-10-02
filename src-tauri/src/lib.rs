pub(crate) mod approvals;
pub(crate) mod browser;
pub(crate) mod fsops;
mod git;
mod keys;
pub(crate) mod lsp;
pub(crate) mod lsp_ops;
mod mcp;
pub(crate) mod mcp_oauth;
mod nexa;
pub(crate) mod process;
pub(crate) mod pty;
pub(crate) mod rate_limiter;
pub(crate) mod sandbox;
mod shell;
pub(crate) mod shell_jobs;
mod skills;
pub(crate) mod util;
pub(crate) mod window;
#[cfg(windows)]
mod windows_job;
pub(crate) mod workspace;

// Re-exports: names other backend modules address as `crate::X`.
pub(crate) use keys::KEY_SERVICE;
pub(crate) use shell::shell_deny_reason;
pub(crate) use util::{truncate_chars, write_atomic, MAX_CMD_BYTES, MAX_OUT_CHARS};
pub(crate) use workspace::{checked_path, root_snapshot, WorkspaceRoots};

use pty::PtyStore;
use tauri::Manager;
use window::next_window_label;
use workspace::AppSettings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .manage(mcp::McpTrustStore::default())
        .manage(rate_limiter::RateLimiter::default())
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
                                pty::retire_session(sess);
                            }
                        }
                    }
                }
                if let Some(jobs) = window.try_state::<shell_jobs::ShellJobs>() {
                    shell_jobs::kill_jobs_for_window(&jobs, &label);
                }
                // <=1: robust to whether the destroyed window is still listed.
                if window.webview_windows().len() <= 1 {
                    if let Some(state) = window.try_state::<browser::BrowserState>() {
                        browser::stop_process(&state);
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
            workspace::path_is_within,
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
            sandbox::sandbox_status,
            shell_jobs::shell_bg,
            shell_jobs::shell_poll,
            shell_jobs::shell_kill,
            pty::pty_spawn,
            pty::pty_set_cwd,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            browser::browser_preflight,
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

#[cfg(test)]
mod ipc_tests {
    use super::*;
    use crate::approvals::{ApprovalStore, APPROVAL_PROTO};
    use crate::rate_limiter::RateLimiter;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::MockRuntime;
    use tauri::webview::InvokeRequest;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn test_app() -> tauri::App<MockRuntime> {
        tauri::test::mock_builder()
            .manage(WorkspaceRoots::default())
            .manage(ApprovalStore::default())
            .manage(mcp::McpTrustStore::default())
            .manage(RateLimiter::default())
            .invoke_handler(tauri::generate_handler![
                approvals::approval_claim,
                workspace::path_is_within,
                workspace::set_workspace_root,
                fsops::fs_list,
                fsops::fs_read,
                fsops::fs_create,
                fsops::fs_rename,
                fsops::fs_delete,
                fsops::fs_search,
                fsops::fs_glob,
                mcp::mcp_list_servers,
                mcp::mcp_list_tools,
                mcp::mcp_call_tool
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    fn test_window(app: &tauri::App<MockRuntime>) -> tauri::WebviewWindow<MockRuntime> {
        tauri::WebviewWindowBuilder::new(app, "main", Default::default())
            .build()
            .unwrap()
    }

    fn set_root(app: &tauri::App<MockRuntime>, root: &std::path::Path) {
        app.state::<WorkspaceRoots>()
            .0
            .lock()
            .unwrap()
            .insert("main".to_string(), root.to_path_buf());
    }

    fn temp_root(label: &str) -> PathBuf {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("vtnexa-ipc-{label}-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn call(
        window: &tauri::WebviewWindow<MockRuntime>,
        cmd: &str,
        payload: Value,
    ) -> Result<Value, Value> {
        let url = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap();
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url,
                body: InvokeBody::Json(payload),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    }

    fn ok(window: &tauri::WebviewWindow<MockRuntime>, cmd: &str, payload: Value) -> Value {
        match call(window, cmd, payload) {
            Ok(value) => value,
            Err(error) => panic!("{cmd} failed: {error}"),
        }
    }

    fn claim(window: &tauri::WebviewWindow<MockRuntime>, action: &str, detail: &str) -> String {
        ok(
            window,
            "approval_claim",
            json!({ "action": action, "detail": detail, "proto": APPROVAL_PROTO }),
        )
        .as_str()
        .unwrap()
        .to_string()
    }

    #[test]
    fn path_is_within_binds_actual_containment_command() {
        let app = test_app();
        let window = test_window(&app);
        let root = temp_root("containment");
        let inside = ok(
            &window,
            "path_is_within",
            json!({ "path": root.join("a/../b.txt"), "root": root }),
        );
        let sibling = ok(
            &window,
            "path_is_within",
            json!({
                "path": root.parent().unwrap().join(format!("{}-sibling", root.file_name().unwrap().to_string_lossy())),
                "root": root
            }),
        );
        assert_eq!(inside, Value::Bool(true));
        assert_eq!(sibling, Value::Bool(false));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fs_create_binds_is_dir_from_camel_case_ipc() {
        let app = test_app();
        let window = test_window(&app);
        let root = temp_root("create");
        set_root(&app, &root);
        let target = root.join("created-dir");
        let result = ok(
            &window,
            "fs_create",
            json!({ "path": target, "isDir": true }),
        );
        assert_eq!(result.as_str(), Some(target.to_string_lossy().as_ref()));
        assert!(target.is_dir());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn generic_fs_ipc_rejects_private_targets_and_filters_metadata_entries() {
        let app = test_app();
        let window = test_window(&app);
        let root = temp_root("generic-private-ipc");
        set_root(&app, &root);
        for name in [".nexa", ".vtnexa", ".git", ".hg", ".svn"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("secret.txt"), "secret").unwrap();
        }
        std::fs::write(root.join("visible.txt"), "visible").unwrap();
        let entries = ok(&window, "fs_list", json!({ "path": root }));
        let names = entries
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(names.contains(&"visible.txt"));
        assert!(!names.iter().any(|name| name.starts_with('.')));
        let glob = ok(&window, "fs_glob", json!({ "pattern": "*", "path": root }));
        assert!(glob
            .as_array()
            .unwrap()
            .iter()
            .all(|value| { !value.as_str().unwrap_or_default().contains(".git") }));
        let search = ok(
            &window,
            "fs_search",
            json!({ "query": "secret", "path": root }),
        );
        assert!(search.as_array().unwrap().is_empty());
        for (command, payload) in [
            ("fs_read", json!({ "path": root.join(".git/config") })),
            (
                "fs_create",
                json!({ "path": root.join(".nexa/new.txt"), "isDir": false }),
            ),
            (
                "fs_search",
                json!({ "query": "secret", "path": root.join(".nexa") }),
            ),
            (
                "fs_glob",
                json!({ "pattern": "*", "path": root.join(".svn") }),
            ),
            ("fs_delete", json!({ "path": root.join(".hg") })),
            (
                "fs_rename",
                json!({ "oldPath": root.join("visible.txt"), "newPath": root.join(".git/moved") }),
            ),
        ] {
            assert!(
                call(&window, command, payload).is_err(),
                "accepted {}",
                command
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fs_rename_binds_paths_and_approval_from_camel_case_ipc() {
        let app = test_app();
        let window = test_window(&app);
        let root = temp_root("rename");
        set_root(&app, &root);
        let source = root.join("old.txt");
        let target = root.join("new.txt");
        ok(
            &window,
            "fs_create",
            json!({ "path": source, "isDir": false }),
        );
        let detail = "rename-binding-detail";
        let token = claim(&window, "fs_rename", detail);
        let result = ok(
            &window,
            "fs_rename",
            json!({
                "oldPath": source,
                "newPath": target,
                "approvalToken": token,
                "approvalDetail": detail
            }),
        );
        assert_eq!(result.as_str(), Some(target.to_string_lossy().as_ref()));
        assert!(!source.exists());
        assert!(target.is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn set_workspace_root_binds_confirm_dangerous_from_camel_case_ipc() {
        let app = test_app();
        let window = test_window(&app);
        #[cfg(unix)]
        let root = PathBuf::from("/");
        #[cfg(windows)]
        let root = PathBuf::from("C:\\");
        let result = ok(
            &window,
            "set_workspace_root",
            json!({ "path": root, "confirmDangerous": true }),
        );
        assert_eq!(result.as_str(), Some(root.to_string_lossy().as_ref()));
    }

    #[test]
    fn mcp_call_tool_binds_approval_from_camel_case_ipc() {
        let app = test_app();
        let window = test_window(&app);
        let root = temp_root("mcp");
        set_root(&app, &root);
        let detail = "mcp-binding-detail";
        let token = claim(&window, "mcp_call_tool", detail);
        let error = call(
            &window,
            "mcp_call_tool",
            json!({
                "server": "missing_test_server",
                "tool": "lookup",
                "args": {},
                "approvalToken": token,
                "approvalDetail": detail
            }),
        )
        .unwrap_err();
        assert_eq!(
            error.as_str(),
            Some("mcp: unknown server 'missing_test_server'")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mcp_list_and_discovery_skip_untrusted_workspace_servers() {
        let app = test_app();
        let window = test_window(&app);
        let root = temp_root("mcp-list");
        set_root(&app, &root);
        let marker = root.join("spawned");
        std::fs::create_dir_all(root.join(".vtnexa")).unwrap();
        std::fs::write(
            root.join(".vtnexa/vtnexa.json"),
            r#"{"mcp":{"ipc_workspace_only":{"type":"local","command":["python3","-c","open('spawned','w').write('x')"]}}}"#,
        )
        .unwrap();
        let servers = ok(&window, "mcp_list_servers", json!({}));
        assert_eq!(servers[0]["consent_required"], Value::Bool(true));
        assert_eq!(servers[0]["enabled"], Value::Bool(false));
        let tools = ok(&window, "mcp_list_tools", json!({}));
        assert!(tools.as_array().unwrap().is_empty());
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
