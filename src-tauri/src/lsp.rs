// Diagnostics-as-feedback (OpenCode LSP-pattern port, slice 3a).
//
// No language servers are spawned: this runs the project's own checkers with
// a fixed allowlist (tsc / cargo check / py_compile) and returns output
// filtered to the requested file. Read-only and auto-approved like git_status:
// argv-direct execution (no shell), workspace-confined paths, timeouts with
// SIGKILL, truncated output. The model supplies only `path`; everything else
// is derived server-side so there is no command-injection surface.

use std::time::{Duration, Instant};

pub(crate) const LSP_MAX_OUTPUT_CHARS: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LspProvider {
    Ts,
    Rust,
    Python,
}

/// Extension dispatch. Lowercases, so `App.TSX` works. Pure — unit tested.
pub(crate) fn provider_for_ext(ext: &str) -> Option<LspProvider> {
    match ext.to_lowercase().as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => Some(LspProvider::Ts),
        "rs" => Some(LspProvider::Rust),
        "py" | "pyi" => Some(LspProvider::Python),
        _ => None,
    }
}

pub(crate) fn markers_for(provider: LspProvider) -> &'static [&'static str] {
    match provider {
        LspProvider::Ts => &["tsconfig.json"],
        LspProvider::Rust => &["Cargo.toml"],
        LspProvider::Python => &["pyproject.toml", "setup.py", "setup.cfg"],
    }
}

/// Walk up from `file` (max 8 levels) for the nearest dir containing one of
/// `markers`. Clamped to `workspace_root` when provided: never escapes the
/// sandbox even if markers are missing (a `Cargo.toml` 5 levels up outside
/// the workspace must not redirect `cargo check` there).
/// Returns None when the file floats outside any project.
pub(crate) fn find_project_root(
    file: &std::path::Path,
    markers: &[&str],
    workspace_root: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    let ws_canon = workspace_root.and_then(|w| w.canonicalize().ok());
    let mut dir = file.parent()?.to_path_buf();
    for _ in 0..8 {
        // Clamp: stop when we leave the workspace.
        if let Some(ws) = &ws_canon {
            if let Ok(canon) = dir.canonicalize() {
                if !canon.starts_with(ws) {
                    break;
                }
            } else if let Some(wroot) = workspace_root {
                // Non-existing ancestor: lexical check (no unwrap — ws_canon
                // being Some implies workspace_root was Some, but don't rely
                // on that coupling).
                if !dir.starts_with(wroot) {
                    break;
                }
            } else {
                break;
            }
        }
        if markers.iter().any(|m| dir.join(m).is_file()) {
            return Some(dir);
        }
        if let Some(ws) = workspace_root {
            if dir == ws {
                break;
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

pub(crate) fn command_for(
    provider: LspProvider,
    project_root: &std::path::Path,
    file: &std::path::Path,
) -> (String, Vec<String>) {
    match provider {
        // Whole-project check with the project's own config, then filter to
        // the file. Per-file tsc flags would ignore tsconfig and lie.
        LspProvider::Ts => (
            "npx".to_string(),
            vec![
                "--no-install".to_string(),
                "tsc".to_string(),
                "--noEmit".to_string(),
                "--pretty".to_string(),
                "false".to_string(),
                "-p".to_string(),
                project_root.to_string_lossy().to_string(),
            ],
        ),
        LspProvider::Rust => (
            "cargo".to_string(),
            vec![
                "check".to_string(),
                "--message-format".to_string(),
                "short".to_string(),
            ],
        ),
        // Per-file and instant; accurate without project context.
        LspProvider::Python => (
            "python3".to_string(),
            vec![
                "-m".to_string(),
                "py_compile".to_string(),
                file.to_string_lossy().to_string(),
            ],
        ),
    }
}

pub(crate) fn timeout_for(provider: LspProvider) -> Duration {
    match provider {
        // First runs compile the world; bounded anyway.
        LspProvider::Ts => Duration::from_secs(90),
        LspProvider::Rust => Duration::from_secs(120),
        LspProvider::Python => Duration::from_secs(30),
    }
}

/// argv-direct spawn with drain threads + kill on timeout. Modeled on
/// lib.rs run_capped but without a shell (fixed argv — nothing to screen).
fn run_argv(
    program: &str,
    args: &[String],
    cwd: &std::path::Path,
    timeout: Duration,
) -> Result<(String, i32), String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("lsp_diagnostics: cannot run {}: {}", program, e))?;
    let out_pipe = child
        .stdout
        .take()
        .ok_or("lsp_diagnostics: missing stdout")?;
    let err_pipe = child
        .stderr
        .take()
        .ok_or("lsp_diagnostics: missing stderr")?;
    let (otx, orx) = std::sync::mpsc::channel::<String>();
    let (etx, erx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut s = String::new();
        let mut r = std::io::BufReader::new(out_pipe);
        use std::io::Read;
        if r.read_to_string(&mut s).is_ok() {
            let _ = otx.send(s);
        }
    });
    std::thread::spawn(move || {
        let mut s = String::new();
        let mut r = std::io::BufReader::new(err_pipe);
        use std::io::Read;
        if r.read_to_string(&mut s).is_ok() {
            let _ = etx.send(s);
        }
    });
    let deadline = Instant::now() + timeout;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "lsp_diagnostics: checker timed out after {}s (first runs compile dependencies — retry)",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = orx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let stderr = erx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let mut combined = stdout;
    if !stderr.trim().is_empty() {
        combined.push_str(&stderr);
    }
    Ok((combined, code))
}

/// Keep output lines that mention the file (absolute or project-relative —
/// tsc/cargo print either). When nothing matches but the checker failed,
/// return the whole output (the error is likely config-level and still
/// useful). Pure — unit tested.
pub(crate) fn filter_to_file(
    output: &str,
    absolute: &std::path::Path,
    project_root: &std::path::Path,
) -> (String, usize) {
    let abs = absolute.to_string_lossy().to_string();
    let rel = absolute
        .strip_prefix(project_root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let kept: Vec<&str> = output
        .lines()
        .filter(|l| l.contains(abs.as_str()) || (!rel.is_empty() && l.contains(rel.as_str())))
        .collect();
    (kept.join("\n"), output.lines().count())
}

pub(crate) fn render_result(
    file_display: &str,
    code: i32,
    filtered: &str,
    total_lines: usize,
) -> String {
    if code == 0 && filtered.trim().is_empty() {
        return format!("clean: no diagnostics for {}", file_display);
    }
    let shown_lines = filtered.lines().count();
    let mut out = if filtered.trim().is_empty() {
        // Checker failed without naming the file: config/root error.
        format!(
            "checker failed (exit {}) with no lines for the file:\n",
            code
        )
    } else if code == 0 {
        // Some checkers exit 0 with warnings.
        format!("warnings for {}:\n", file_display)
    } else {
        format!("diagnostics for {}:\n", file_display)
    };
    let capped = crate::truncate_chars(filtered.to_string(), LSP_MAX_OUTPUT_CHARS);
    out.push_str(&capped);
    if shown_lines > capped.lines().count() || total_lines > shown_lines {
        out.push_str(&format!(
            "\n…[{} of {} output lines shown]",
            capped.lines().count(),
            total_lines
        ));
    }
    out
}

#[tauri::command]
pub(crate) fn lsp_diagnostics(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    path: String,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<String, String> {
    let file = crate::checked_path(&state, window.label(), path, "lsp_diagnostics.path")?;
    if !file.is_file() {
        return Err("lsp_diagnostics: not a file (fs_read it first)".to_string());
    }
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let provider = provider_for_ext(&ext).ok_or_else(|| {
        format!(
            "lsp_diagnostics: no diagnostics provider for .{} (supported: ts/tsx/js/jsx/mjs/cjs/mts/cts, rs, py/pyi)",
            ext
        )
    })?;
    // Exec gate: `cargo check` runs build.rs, `npx tsc` runs workspace code.
    // Python py_compile is pure — auto-approved. Everything else needs the
    // same approval token as shell (user saw what will execute).
    if provider != LspProvider::Python {
        crate::approvals::approval_consume(
            &approvals,
            window.label(),
            "lsp_diagnostics",
            &approval_detail,
            &approval_token,
        )?;
    }
    let ws_root = crate::root_snapshot(&state, window.label());
    let (cwd, filter_root) = if provider == LspProvider::Python {
        let parent = file.parent().unwrap_or(&file).to_path_buf();
        (parent.clone(), parent)
    } else {
        match find_project_root(&file, markers_for(provider), Some(&ws_root)) {
            Some(root) => (root.clone(), root),
            None => {
                let marker = markers_for(provider).join(" or ");
                return Err(format!(
                    "lsp_diagnostics: no {} found above {} — diagnostics need project config",
                    marker,
                    file.parent()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default()
                ));
            }
        }
    };
    let (program, args) = command_for(provider, &cwd, &file);
    let (output, code) = run_argv(&program, &args, &cwd, timeout_for(provider))?;
    let display = file.to_string_lossy().to_string();
    if provider == LspProvider::Python {
        if code == 0 {
            return Ok(format!("clean: no diagnostics for {}", display));
        }
        return Ok(crate::truncate_chars(
            format!("diagnostics for {}:\n{}", display, output),
            LSP_MAX_OUTPUT_CHARS,
        ));
    }
    let (filtered, total) = filter_to_file(&output, &file, &filter_root);
    Ok(render_result(&display, code, &filtered, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_by_extension() {
        for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "TSX"] {
            assert_eq!(provider_for_ext(ext), Some(LspProvider::Ts), "ext {}", ext);
        }
        assert_eq!(provider_for_ext("rs"), Some(LspProvider::Rust));
        assert_eq!(provider_for_ext("py"), Some(LspProvider::Python));
        assert_eq!(provider_for_ext("pyi"), Some(LspProvider::Python));
        assert_eq!(provider_for_ext("md"), None);
        assert_eq!(provider_for_ext(""), None);
    }

    #[test]
    fn finds_project_root_within_depth() {
        let tag = std::process::id();
        let base = std::env::temp_dir().join(format!("vtnexa-lsp-{}", tag));
        let _ = std::fs::remove_dir_all(&base);
        let deep = base.join("a").join("b").join("c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(base.join("tsconfig.json"), b"{}").unwrap();
        let file = deep.join("x.ts");
        std::fs::write(&file, b"").unwrap();
        assert_eq!(
            find_project_root(&file, &["tsconfig.json"], Some(&base)).unwrap(),
            base
        );
        assert!(find_project_root(&file, &["Cargo.toml"], Some(&base)).is_none());
        // Clamp: marker outside the workspace must not be found.
        let outside = std::env::temp_dir().join(format!("vtnexa-lsp-out-{}", tag));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("tsconfig.json"), b"{}").unwrap();
        // Simulate file inside ws but marker only outside: walk must stop at ws.
        assert!(find_project_root(&file, &["nope.json"], Some(&base)).is_none());
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn commands_are_argv_direct() {
        let root = std::path::PathBuf::from("/ws/proj");
        let file = root.join("src").join("a.ts");
        let (prog, args) = command_for(LspProvider::Ts, &root, &file);
        assert_eq!(prog, "npx");
        assert!(args.contains(&"--noEmit".to_string()));
        assert!(!args.iter().any(|a| a.contains(';') || a.contains("&&")));
        let (prog, _) = command_for(LspProvider::Rust, &root, &root.join("main.rs"));
        assert_eq!(prog, "cargo");
        let (prog, args) = command_for(LspProvider::Python, &root, &file);
        assert_eq!(prog, "python3");
        assert!(args.iter().any(|a| a.ends_with("a.ts")));
    }

    #[test]
    fn filter_keeps_only_matching_lines() {
        let root = std::path::Path::new("/ws/proj");
        let abs = root.join("src").join("a.ts");
        let out = "src/a.ts(1,2): error TS2322: nope\nsrc/b.ts(3,4): error TS0000: other\n";
        let (kept, total) = filter_to_file(out, &abs, root);
        assert_eq!(total, 2);
        assert!(kept.contains("a.ts"));
        assert!(!kept.contains("b.ts"));
    }

    #[test]
    fn clean_renders_short() {
        let s = render_result("/ws/a.ts", 0, "", 0);
        assert!(s.starts_with("clean:"));
    }

    #[test]
    fn failure_without_matching_lines_still_reports() {
        let s = render_result("/ws/a.ts", 2, "", 5);
        assert!(s.contains("checker failed"));
    }
}
