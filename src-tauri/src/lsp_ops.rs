// Full LSP ops (OpenCode `lsp`-tool port): hover, definition, references,
// documentSymbol, workspaceSymbol. One-shot per call — spawn the server,
// initialize, didOpen with disk content, request, shutdown, kill — so there
// is no daemon to drift out of sync (the failure mode OpenCode documents).
// Read-only and auto-approved; argv-direct spawn (no shell); workspace
// confined; outputs truncated. Servers: typescript-language-server and
// rust-analyzer when installed, with install hints otherwise.

use std::io::{BufRead, BufReader, Read, Write};
use std::time::{Duration, Instant};

pub(crate) const LSP_OP_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const LSP_OP_MAX_CHARS: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LspOp {
    Hover,
    Definition,
    References,
    DocumentSymbol,
    WorkspaceSymbol,
}

pub(crate) fn parse_op(s: &str) -> Option<LspOp> {
    match s {
        "hover" => Some(LspOp::Hover),
        "definition" | "goToDefinition" => Some(LspOp::Definition),
        "references" | "findReferences" => Some(LspOp::References),
        "documentSymbol" => Some(LspOp::DocumentSymbol),
        "workspaceSymbol" => Some(LspOp::WorkspaceSymbol),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LspLang {
    Ts,
    Rust,
}

pub(crate) fn lang_for_ext(ext: &str) -> Option<LspLang> {
    match ext.to_lowercase().as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => Some(LspLang::Ts),
        "rs" => Some(LspLang::Rust),
        _ => None,
    }
}

pub(crate) fn language_id(lang: LspLang, ext: &str) -> &'static str {
    match lang {
        LspLang::Rust => "rust",
        LspLang::Ts => match ext.to_lowercase().as_str() {
            "tsx" => "typescriptreact",
            "jsx" => "javascriptreact",
            "js" | "mjs" | "cjs" => "javascript",
            _ => "typescript",
        },
    }
}

/// Server command for the language. TypeScript prefers the project's own
/// install (node_modules/.bin walking up), else PATH. Pure — unit tested.
pub(crate) fn server_command(lang: LspLang, file: &std::path::Path) -> (String, Vec<String>) {
    match lang {
        LspLang::Rust => ("rust-analyzer".to_string(), vec![]),
        LspLang::Ts => {
            let mut dir = file.parent().map(|p| p.to_path_buf());
            for _ in 0..8 {
                let d = match dir {
                    Some(d) => d,
                    None => break,
                };
                let cand = d
                    .join("node_modules")
                    .join(".bin")
                    .join("typescript-language-server");
                if cand.is_file() {
                    return (
                        cand.to_string_lossy().to_string(),
                        vec!["--stdio".to_string()],
                    );
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
            (
                "typescript-language-server".to_string(),
                vec!["--stdio".to_string()],
            )
        }
    }
}

pub(crate) fn install_hint(lang: LspLang) -> &'static str {
    match lang {
        LspLang::Ts => "install typescript-language-server (npm i -D typescript-language-server)",
        LspLang::Rust => "install rust-analyzer (rustup component add rust-analyzer)",
    }
}

/// 1-based model lines/cols to 0-based LSP, clamped.
pub(crate) fn to_position(line_1based: i64, col_1based: i64) -> (u32, u32) {
    (line_1based.max(1) as u32 - 1, col_1based.max(1) as u32 - 1)
}

/// Minimal file:// URI (spaces encoded; exotic paths rejected upstream).
pub(crate) fn file_uri(path: &std::path::Path) -> String {
    format!("file://{}", path.to_string_lossy().replace(' ', "%20"))
}

fn frame(body: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
}

fn rpc(method: &str, id: Option<u64>, params: serde_json::Value) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("jsonrpc".to_string(), "2.0".into());
    if let Some(i) = id {
        obj.insert("id".to_string(), i.into());
    }
    obj.insert("method".to_string(), method.into());
    obj.insert("params".to_string(), params);
    serde_json::Value::Object(obj).to_string()
}

/// Spawn, stage the LSP lifecycle (initialize -> initialized/didOpen/op ->
/// shutdown -> exit), collect responses. Staged, not pipelined: real servers
/// may terminate on `exit` before answering queued requests, so each request
/// goes out only after the previous reply arrives. Always reaps the child.
struct Roundtrip<'a> {
    program: &'a str,
    args: &'a [String],
    cwd: &'a std::path::Path,
    init_frames: &'a [Vec<u8>],
    open_frames: &'a [Vec<u8>],
    op_frame: &'a dyn Fn(u64) -> Vec<u8>,
    op_first_id: u64,
    timeout: Duration,
}

fn roundtrip(rt: Roundtrip<'_>) -> Result<Vec<serde_json::Value>, String> {
    let Roundtrip {
        program,
        args,
        cwd,
        init_frames,
        open_frames,
        op_frame,
        op_first_id,
        timeout,
    } = rt;
    let mut child = std::process::Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "lsp: cannot run {} ({}). Hint: {}",
                program, e, "see install hint"
            )
        })?;
    let mut stdin = child.stdin.take().ok_or("lsp: no stdin")?;
    let stdout = child.stdout.take().ok_or("lsp: no stdout")?;

    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            // Header scan for Content-Length.
            let mut len: Option<usize> = None;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let t = line.trim();
                if t.is_empty() {
                    break;
                }
                if let Some(v) = t
                    .strip_prefix("Content-Length:")
                    .or_else(|| t.strip_prefix("Content-length:"))
                {
                    len = v.trim().parse().ok();
                }
            }
            let len = match len {
                Some(l) if l > 0 && l <= 8 * 1024 * 1024 => l,
                _ => {
                    if len.is_none() {
                        break;
                    } // EOF or garbage: stop.
                    continue;
                }
            };
            let mut buf = vec![0u8; len];
            if reader.read_exact(&mut buf).is_err() {
                break;
            }
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });

    let deadline = Instant::now() + timeout;
    let out = std::cell::RefCell::new(Vec::<serde_json::Value>::new());
    // Each stage: send, then wait for its reply id (None = notification-only).
    let mut stage = |frames: &[Vec<u8>], wait_id: Option<u64>| -> Result<(), String> {
        for f in frames {
            stdin
                .write_all(f)
                .map_err(|e| format!("lsp: stdin write failed: {}", e))?;
        }
        stdin
            .flush()
            .map_err(|e| format!("lsp: stdin flush failed: {}", e))?;
        let Some(want) = wait_id else { return Ok(()) };
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("lsp: server gave no response (timeout or crash — retry; first runs index the project)".to_string());
            }
            match rx.recv_timeout(left.min(Duration::from_millis(250))) {
                Ok(v) => {
                    let is_want = v.get("id").and_then(|i| i.as_u64()) == Some(want);
                    out.borrow_mut().push(v);
                    if out.borrow().len() > 100 {
                        return Err("lsp: server chattered too much (50+ messages)".to_string());
                    }
                    if is_want {
                        return Ok(());
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("lsp: server gave no response (timeout or crash — retry; first runs index the project)".to_string())
                }
            }
        }
    };

    let shutdown = frame(&rpc("shutdown", Some(3), serde_json::json!(null)));
    let exit = frame(&rpc("exit", None, serde_json::json!(null)));
    // Settle retries: a cold server answers empty until analysis lands.
    // Same session (no respawn), fresh ids, bounded sleeps.
    let mut next_id = op_first_id;
    let mut last_id = op_first_id;
    let result = (|| {
        stage(init_frames, Some(1))?;
        stage(open_frames, None)?;
        for attempt in 0..3 {
            let id = next_id;
            next_id += 2;
            last_id = id;
            stage(std::slice::from_ref(&op_frame(id)), Some(id))?;
            if !result_is_empty(find_id(&out.borrow(), id)) || attempt == 2 {
                break;
            }
            std::thread::sleep(Duration::from_secs(2 * (attempt + 1) as u64));
        }
        // Shutdown handshake before exit: exiting early drops queued replies
        // on conforming servers. Best-effort under the same deadline.
        let _ = stage(std::slice::from_ref(&shutdown), Some(3));
        let _ = stage(std::slice::from_ref(&exit), None);
        // Let the goodbye flush through the pipe before reaping.
        std::thread::sleep(Duration::from_millis(300));
        Ok(last_id)
    })();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    result.map(|id| {
        out.borrow()
            .iter()
            .filter(|v| v.get("id").and_then(|i| i.as_u64()) == Some(id))
            .cloned()
            .collect()
    })
}

/// Cold servers answer `result: null` (or `[]`) until analysis lands.
fn result_is_empty(resp: Option<&serde_json::Value>) -> bool {
    match resp.and_then(|r| r.get("result")) {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::Array(a)) => a.is_empty(),
        Some(_) => false,
    }
}

fn find_id(responses: &[serde_json::Value], id: u64) -> Option<&serde_json::Value> {
    responses
        .iter()
        .find(|v| v.get("id").and_then(|i| i.as_u64()) == Some(id))
}

// ---- Result rendering (pure, tested) ----

fn md_to_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(_) => v
            .get("value")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn loc_line(loc: &serde_json::Value) -> String {
    let uri = loc.get("uri").and_then(|u| u.as_str()).unwrap_or("?");
    let target = loc.get("targetUri").and_then(|u| u.as_str()).unwrap_or(uri);
    let range = loc
        .get("targetRange")
        .or_else(|| loc.get("targetSelectionRange"))
        .or_else(|| loc.get("range"));
    let line = range
        .and_then(|r| r.get("start"))
        .and_then(|s| s.get("line"))
        .and_then(|l| l.as_u64())
        .map(|l| l + 1)
        .unwrap_or(0);
    // Strip file:// for readability; keep remote URIs whole.
    let path = target.strip_prefix("file://").unwrap_or(target);
    format!("{}:{}", path, line)
}

/// Render an op result to short text. Never panics on odd shapes.
pub(crate) fn render_result(op: LspOp, result: &serde_json::Value) -> String {
    if result.is_null() {
        return "no result".to_string();
    }
    match op {
        LspOp::Hover => {
            let contents = &result["contents"];
            if let Some(arr) = contents.as_array() {
                let parts: Vec<String> = arr
                    .iter()
                    .map(md_to_text)
                    .filter(|s| !s.trim().is_empty())
                    .collect();
                if parts.is_empty() {
                    return "no result".to_string();
                }
                return parts.join("\n---\n");
            }
            let s = md_to_text(contents);
            if s.trim().is_empty() {
                "no result".to_string()
            } else {
                s
            }
        }
        LspOp::Definition => match result {
            serde_json::Value::Array(items) => {
                if items.is_empty() {
                    return "no result".to_string();
                }
                items.iter().map(loc_line).collect::<Vec<_>>().join("\n")
            }
            _ => loc_line(result),
        },
        LspOp::References => match result.as_array() {
            Some(items) if !items.is_empty() => {
                items.iter().map(loc_line).collect::<Vec<_>>().join("\n")
            }
            _ => "no result".to_string(),
        },
        LspOp::DocumentSymbol | LspOp::WorkspaceSymbol => match result.as_array() {
            Some(items) if !items.is_empty() => items
                .iter()
                .take(100)
                .map(|s| {
                    let name = s.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                    // WorkspaceSymbol carries `location`; DocumentSymbol nests `range`/`children`.
                    let line = s
                        .get("location")
                        .and_then(|l| l.get("range"))
                        .or_else(|| s.get("range"))
                        .and_then(|r| r.get("start"))
                        .and_then(|st| st.get("line"))
                        .and_then(|l| l.as_u64())
                        .map(|l| l + 1)
                        .unwrap_or(0);
                    format!("{}:{}", name, line)
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => "no result".to_string(),
        },
    }
}

pub(crate) fn op_needs_position(op: LspOp) -> bool {
    matches!(op, LspOp::Hover | LspOp::Definition | LspOp::References)
}

// ---- Entry point ----

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_lsp_op(
    program: &str,
    args: &[String],
    project_root: &std::path::Path,
    file: &std::path::Path,
    language_id: &str,
    disk_text: &str,
    op: LspOp,
    line_1based: i64,
    col_1based: i64,
    symbol_query: &str,
) -> Result<String, String> {
    let uri = file_uri(file);
    let root_uri = file_uri(project_root);
    let (line, character) = to_position(line_1based, col_1based);
    let pos = serde_json::json!({"line": line, "character": character});

    let init = vec![frame(&rpc(
        "initialize",
        Some(1),
        serde_json::json!({
            "processId": null,
            "rootUri": root_uri,
            "capabilities": {},
        }),
    ))];
    let frames = vec![
        frame(&rpc("initialized", None, serde_json::json!({}))),
        frame(&rpc(
            "textDocument/didOpen",
            None,
            serde_json::json!({"textDocument": {
                "uri": uri, "languageId": language_id, "version": 1, "text": disk_text,
            }}),
        )),
    ];
    let (method, params) = match op {
        LspOp::Hover => (
            "textDocument/hover",
            serde_json::json!({"textDocument": {"uri": uri}, "position": pos}),
        ),
        LspOp::Definition => (
            "textDocument/definition",
            serde_json::json!({"textDocument": {"uri": uri}, "position": pos}),
        ),
        LspOp::References => (
            "textDocument/references",
            serde_json::json!({"textDocument": {"uri": uri}, "position": pos, "context": {"includeDeclaration": true}}),
        ),
        LspOp::DocumentSymbol => (
            "textDocument/documentSymbol",
            serde_json::json!({"textDocument": {"uri": uri}}),
        ),
        LspOp::WorkspaceSymbol => (
            "workspace/symbol",
            serde_json::json!({"query": symbol_query}),
        ),
    };
    let op_frame = |id: u64| frame(&rpc(method, Some(id), params.clone()));

    let mut responses = roundtrip(Roundtrip {
        program,
        args,
        cwd: project_root,
        init_frames: &init,
        open_frames: &frames,
        op_frame: &op_frame,
        op_first_id: 2,
        timeout: LSP_OP_TIMEOUT,
    })?;
    let resp = responses.pop().ok_or_else(|| {
        "lsp: server gave no response (timeout or crash — retry; first runs index the project)"
            .to_string()
    })?;
    if let Some(err) = resp.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!(
            "lsp: server error: {}",
            msg.chars().take(300).collect::<String>()
        ));
    }
    let rendered = render_result(op, resp.get("result").unwrap_or(&serde_json::Value::Null));
    Ok(crate::truncate_chars(rendered, LSP_OP_MAX_CHARS))
}

#[tauri::command]
pub(crate) fn lsp_op(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    op: String,
    path: String,
    line: Option<i64>,
    character: Option<i64>,
    symbol: Option<String>,
) -> Result<String, String> {
    let file = crate::checked_path(&state, window.label(), path, "lsp.path")?;
    if !file.is_file() {
        return Err("lsp: not a file (fs_read it first)".to_string());
    }
    let op = parse_op(op.trim()).ok_or_else(|| {
        "lsp: unknown op (want hover|definition|references|documentSymbol|workspaceSymbol)"
            .to_string()
    })?;
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let lang = lang_for_ext(&ext).ok_or_else(|| {
        format!(
            "lsp: no language server for .{} (supported: ts/tsx/js/jsx/mjs/cjs/mts/cts, rs)",
            ext
        )
    })?;
    if op_needs_position(op) && line.unwrap_or(0) < 1 {
        return Err("lsp: hover/definition/references need a 1-based line".to_string());
    }
    if op == LspOp::WorkspaceSymbol && symbol.as_deref().unwrap_or("").trim().is_empty() {
        return Err("lsp: workspaceSymbol needs a symbol query".to_string());
    }
    let markers: &[&str] = match lang {
        LspLang::Ts => &["tsconfig.json"],
        LspLang::Rust => &["Cargo.toml"],
    };
    let project_root = crate::lsp::find_project_root(&file, markers).ok_or_else(|| {
        format!(
            "lsp: no project marker ({}) above {}",
            markers.join(" or "),
            file.parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        )
    })?;
    let (program, args) = server_command(lang, &file);
    let disk_text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    if disk_text.len() > 1024 * 1024 {
        return Err("lsp: file too large (1MB max)".to_string());
    }
    run_lsp_op(
        &program,
        &args,
        &project_root,
        &file,
        language_id(lang, &ext),
        &disk_text,
        op,
        line.unwrap_or(1),
        character.unwrap_or(1),
        symbol.as_deref().unwrap_or(""),
    )
    .map_err(|e| {
        // Spawn failure = missing server: point at the install, not the OS error.
        if e.contains("cannot run") {
            format!("{} — {}", e, install_hint(lang))
        } else {
            e
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_and_langs_dispatch() {
        assert_eq!(parse_op("hover"), Some(LspOp::Hover));
        assert_eq!(parse_op("goToDefinition"), Some(LspOp::Definition));
        assert_eq!(parse_op("findReferences"), Some(LspOp::References));
        assert_eq!(parse_op("nope"), None);
        assert_eq!(lang_for_ext("tsx"), Some(LspLang::Ts));
        assert_eq!(lang_for_ext("RS"), Some(LspLang::Rust));
        assert_eq!(lang_for_ext("md"), None);
        assert!(op_needs_position(LspOp::Hover));
        assert!(!op_needs_position(LspOp::DocumentSymbol));
    }

    #[test]
    fn positions_clamp_to_zero_based() {
        assert_eq!(to_position(1, 1), (0, 0));
        assert_eq!(to_position(10, 5), (9, 4));
        assert_eq!(to_position(0, -3), (0, 0));
    }

    #[test]
    fn language_ids() {
        assert_eq!(language_id(LspLang::Ts, "ts"), "typescript");
        assert_eq!(language_id(LspLang::Ts, "tsx"), "typescriptreact");
        assert_eq!(language_id(LspLang::Ts, "js"), "javascript");
        assert_eq!(language_id(LspLang::Rust, "rs"), "rust");
    }

    #[test]
    fn project_server_prefers_local_install() {
        let tag = std::process::id();
        let base = std::env::temp_dir().join(format!("vtnexa-lspops-{}", tag));
        let _ = std::fs::remove_dir_all(&base);
        let bin = base.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("typescript-language-server"), b"x").unwrap();
        let file = base.join("src").join("a.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let (prog, args) = server_command(LspLang::Ts, &file);
        assert!(prog.ends_with("typescript-language-server"), "got {}", prog);
        assert_eq!(args, vec!["--stdio"]);
        let (prog, _) = server_command(LspLang::Rust, &file);
        assert_eq!(prog, "rust-analyzer");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hover_renders_all_shapes() {
        assert_eq!(
            render_result(LspOp::Hover, &serde_json::Value::Null),
            "no result"
        );
        let res = serde_json::json!({"contents": {"kind": "markdown", "value": "hi"}});
        assert_eq!(render_result(LspOp::Hover, &res), "hi");
        let res = serde_json::json!({"contents": "plain"});
        assert_eq!(render_result(LspOp::Hover, &res), "plain");
        let res = serde_json::json!({"contents": [{"language": "ts", "value": "const x"}, "docs"]});
        assert_eq!(render_result(LspOp::Hover, &res), "const x\n---\ndocs");
        let res = serde_json::json!({"contents": []});
        assert_eq!(render_result(LspOp::Hover, &res), "no result");
    }

    #[test]
    fn locations_render_as_path_line() {
        let one = serde_json::json!({"uri": "file:///w/a.ts", "range": {"start": {"line": 4, "character": 0}}});
        assert_eq!(render_result(LspOp::Definition, &one), "/w/a.ts:5");
        let many = serde_json::json!([
            {"uri": "file:///w/a.ts", "range": {"start": {"line": 0, "character": 0}}},
            {"uri": "file:///w/b.ts", "range": {"start": {"line": 9, "character": 0}}},
        ]);
        assert_eq!(
            render_result(LspOp::References, &many),
            "/w/a.ts:1\n/w/b.ts:10"
        );
        assert_eq!(
            render_result(LspOp::References, &serde_json::json!([])),
            "no result"
        );
        let syms =
            serde_json::json!([{"name": "foo", "range": {"start": {"line": 2, "character": 0}}}]);
        assert_eq!(render_result(LspOp::DocumentSymbol, &syms), "foo:3");
    }
}

#[cfg(test)]
mod roundtrip_tests {
    use super::*;

    const MOCK: &str = r#"
import json, sys
def read_msg():
    length = None
    while True:
        line = sys.stdin.buffer.readline().decode()
        if not line:
            return None
        line = line.strip()
        if not line:
            break
        if line.lower().startswith("content-length:"):
            length = int(line.split(":")[1].strip())
    if length is None:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode())
def send(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    sys.stdout.buffer.flush()
count = {"n": 0}
while True:
    msg = read_msg()
    if msg is None:
        break
    method = msg.get("method", "")
    mid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"capabilities": {}}})
    elif method == "shutdown":
        send({"jsonrpc": "2.0", "id": mid, "result": None})
    elif method == "exit":
        break
    elif mid is not None:
        count["n"] += 1
        if count["n"] == 1:
            # Cold server: empty until analysis lands. Client must retry.
            send({"jsonrpc": "2.0", "id": mid, "result": None})
        else:
            send({"jsonrpc": "2.0", "id": mid, "result": {"contents": "mock-hover"}})
"#;

    #[test]
    fn hover_roundtrips_through_mock_server() {
        let dir = std::env::temp_dir();
        let file = dir.join("vtnexa-mock-lsp.txt");
        let _ = std::fs::remove_file(&file);
        let out = run_lsp_op(
            "python3",
            &["-c".to_string(), MOCK.to_string()],
            &dir,
            &dir.join("vtnexa-mock-lsp.txt"),
            "plaintext",
            "hello",
            LspOp::Hover,
            1,
            1,
            "",
        )
        .expect("roundtrip failed");
        assert_eq!(out, "mock-hover");
        let _ = std::fs::remove_file(&file);
    }
}
