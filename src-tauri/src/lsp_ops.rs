// Full LSP ops (OpenCode `lsp`-tool port): hover, definition, references,
// documentSymbol, workspaceSymbol. One-shot per call — spawn the server,
// initialize, didOpen with disk content, request, shutdown, kill — so there
// is no daemon to drift out of sync (the failure mode OpenCode documents).
// Read-only and auto-approved; argv-direct spawn (no shell); workspace
// confined; outputs truncated. Servers: typescript-language-server and
// rust-analyzer when installed, with install hints otherwise.

use crate::process;
use std::io::{BufReader, Read, Write};
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
/// install (node_modules/.bin walking up, clamped to workspace), else PATH.
/// Pure — unit tested.
pub(crate) fn server_command(
    lang: LspLang,
    file: &std::path::Path,
    workspace_root: Option<&std::path::Path>,
) -> (String, Vec<String>) {
    match lang {
        LspLang::Rust => ("rust-analyzer".to_string(), vec![]),
        LspLang::Ts => {
            let mut dir = file.parent().map(|p| p.to_path_buf());
            for _ in 0..8 {
                let d = match dir {
                    Some(d) => d,
                    None => break,
                };
                // Clamp: never walk above the workspace looking for binaries.
                if let Some(ws) = workspace_root {
                    if !d.starts_with(ws) {
                        break;
                    }
                }
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
                // Stop at the workspace root itself.
                if let Some(ws) = workspace_root {
                    if d == ws {
                        break;
                    }
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

/// True when the resolved server binary lives inside the workspace (attacker-
/// plantable). Such runs need approval even though the op is "read-only".
pub(crate) fn server_is_workspace_local(program: &str, workspace_root: &std::path::Path) -> bool {
    let p = std::path::Path::new(program);
    if !p.is_absolute() {
        return false;
    }
    // Canonicalize when possible; lexical fallback otherwise.
    if let Ok(canon) = p.canonicalize() {
        let ws_canon = workspace_root
            .canonicalize()
            .unwrap_or_else(|_| workspace_root.to_path_buf());
        return canon.starts_with(&ws_canon);
    }
    p.starts_with(workspace_root)
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

const LSP_MAX_HEADER_LINE: usize = 8 * 1024;
const LSP_MAX_BODY: usize = 1024 * 1024;
const LSP_MAX_MESSAGES: usize = 100;
const LSP_MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;

struct BoundedLspReader<R> {
    reader: R,
    total: usize,
    messages: usize,
}

impl<R: Read> BoundedLspReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            total: 0,
            messages: 0,
        }
    }

    fn read_header_line(&mut self) -> Result<Option<Vec<u8>>, String> {
        let mut line = Vec::new();
        loop {
            let mut byte = [0u8; 1];
            match self.reader.read(&mut byte) {
                Ok(0) if line.is_empty() => return Ok(None),
                Ok(0) => return Err("lsp: truncated message header".to_string()),
                Ok(_) => {}
                Err(error) => return Err(format!("lsp: stdout read failed: {}", error)),
            }
            self.total = self.total.saturating_add(1);
            if self.total > LSP_MAX_TOTAL_BYTES {
                return Err(format!(
                    "lsp: response exceeded {} bytes",
                    LSP_MAX_TOTAL_BYTES
                ));
            }
            if byte[0] == b'\n' {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(line));
            }
            if line.len() >= LSP_MAX_HEADER_LINE {
                return Err(format!(
                    "lsp: header line exceeded {} bytes",
                    LSP_MAX_HEADER_LINE
                ));
            }
            line.push(byte[0]);
        }
    }

    fn read_body(&mut self, length: usize) -> Result<Vec<u8>, String> {
        if length == 0 || length > LSP_MAX_BODY {
            return Err(format!(
                "lsp: Content-Length must be 1..={} bytes",
                LSP_MAX_BODY
            ));
        }
        if self.total.saturating_add(length) > LSP_MAX_TOTAL_BYTES {
            return Err(format!(
                "lsp: response exceeded {} bytes",
                LSP_MAX_TOTAL_BYTES
            ));
        }
        let mut body = vec![0u8; length];
        let mut read = 0;
        while read < length {
            let count = match self.reader.read(&mut body[read..]) {
                Ok(0) => return Err("lsp: truncated message body".to_string()),
                Ok(count) => count,
                Err(error) => return Err(format!("lsp: stdout read failed: {}", error)),
            };
            read += count;
            self.total = self.total.saturating_add(count);
        }
        Ok(body)
    }

    fn next_message(&mut self) -> Result<Option<serde_json::Value>, String> {
        let mut content_length = None;
        let mut headers = 0;
        loop {
            let Some(line) = self.read_header_line()? else {
                return Ok(None);
            };
            if line.is_empty() {
                break;
            }
            headers += 1;
            if headers > 32 {
                return Err("lsp: too many message headers".to_string());
            }
            let Some(separator) = line.iter().position(|byte| *byte == b':') else {
                return Err("lsp: malformed message header".to_string());
            };
            let name = &line[..separator];
            let value = &line[separator + 1..];
            if name.eq_ignore_ascii_case(b"content-length") {
                let value = std::str::from_utf8(value)
                    .map_err(|_| "lsp: invalid Content-Length".to_string())?
                    .trim();
                content_length = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| "lsp: invalid Content-Length".to_string())?,
                );
            }
        }
        let Some(length) = content_length else {
            return Err("lsp: message has no Content-Length".to_string());
        };
        let body = self.read_body(length)?;
        self.messages = self.messages.saturating_add(1);
        if self.messages > LSP_MAX_MESSAGES {
            return Err(format!(
                "lsp: server sent more than {} messages",
                LSP_MAX_MESSAGES
            ));
        }
        serde_json::from_slice(&body)
            .map(Some)
            .map_err(|error| format!("lsp: malformed JSON message: {}", error))
    }
}

fn lsp_reader(
    stdout: impl Read + Send + 'static,
) -> std::sync::mpsc::Receiver<Result<serde_json::Value, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BoundedLspReader::new(BufReader::new(stdout));
        loop {
            match reader.next_message() {
                Ok(Some(value)) => {
                    if tx.send(Ok(value)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = tx.send(Err(error));
                    break;
                }
            }
        }
    });
    rx
}

fn roundtrip(rt: Roundtrip<'_>) -> Result<serde_json::Value, String> {
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
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = process::spawn_managed(&mut command).map_err(|error| {
        format!(
            "lsp: cannot run {} ({}). Hint: {}",
            program, error, "see install hint"
        )
    })?;
    let mut stdin = match child.child_mut().stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.terminate();
            return Err("lsp: no stdin".to_string());
        }
    };
    let stdout = match child.child_mut().stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.terminate();
            return Err("lsp: no stdout".to_string());
        }
    };
    let rx = lsp_reader(stdout);
    let deadline = Instant::now() + timeout;
    let mut stage = |frames: &[Vec<u8>],
                     wait_id: Option<u64>|
     -> Result<Option<serde_json::Value>, String> {
        for frame in frames {
            stdin
                .write_all(frame)
                .map_err(|error| format!("lsp: stdin write failed: {}", error))?;
        }
        stdin
            .flush()
            .map_err(|error| format!("lsp: stdin flush failed: {}", error))?;
        let Some(want) = wait_id else {
            return Ok(None);
        };
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("lsp: server gave no response (timeout or crash — retry; first runs index the project)".to_string());
            }
            match rx.recv_timeout(left.min(Duration::from_millis(250))) {
                Ok(Ok(value)) => {
                    if value.get("id").and_then(|id| id.as_u64()) == Some(want) {
                        return Ok(Some(value));
                    }
                }
                Ok(Err(error)) => return Err(error),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("lsp: server gave no response (timeout or crash — retry; first runs index the project)".to_string());
                }
            }
        }
    };
    let result = (|| {
        stage(init_frames, Some(1))?;
        stage(open_frames, None)?;
        let mut id = op_first_id;
        for attempt in 0..3 {
            let current = id;
            id += 2;
            let Some(value) = stage(std::slice::from_ref(&op_frame(current)), Some(current))?
            else {
                return Err("lsp: server gave no operation response".to_string());
            };
            if !result_is_empty(Some(&value)) || attempt == 2 {
                return Ok(value);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("lsp: server gave no response (timeout or crash — retry; first runs index the project)".to_string());
            }
            std::thread::sleep(Duration::from_secs(2 * (attempt + 1) as u64).min(left));
        }
        Err("lsp: server gave no operation response".to_string())
    })();
    drop(stdin);
    match (result, child.terminate()) {
        (Ok(value), Ok(_)) => Ok(value),
        (Err(error), Ok(_)) => Err(error),
        (Ok(_), Err(cleanup)) => Err(format!("lsp: process cleanup failed: {cleanup}")),
        (Err(error), Err(cleanup)) => Err(format!("{error}; cleanup failed: {cleanup}")),
    }
}

/// Cold servers answer `result: null` (or `[]`) until analysis lands.
fn result_is_empty(resp: Option<&serde_json::Value>) -> bool {
    match resp.and_then(|r| r.get("result")) {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::Array(a)) => a.is_empty(),
        Some(_) => false,
    }
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

    let resp = roundtrip(Roundtrip {
        program,
        args,
        cwd: project_root,
        init_frames: &init,
        open_frames: &frames,
        op_frame: &op_frame,
        op_first_id: 2,
        timeout: LSP_OP_TIMEOUT,
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn lsp_op(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    op: String,
    path: String,
    line: Option<i64>,
    character: Option<i64>,
    symbol: Option<String>,
    approval_token: Option<String>,
    approval_detail: Option<String>,
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
    let ws_root = crate::root_snapshot(&state, window.label());
    let project_root =
        crate::lsp::find_project_root(&file, markers, Some(&ws_root)).ok_or_else(|| {
            format!(
                "lsp: no project marker ({}) above {}",
                markers.join(" or "),
                file.parent()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            )
        })?;
    let (program, args) = server_command(lang, &file, Some(&ws_root));
    // Exec gate: workspace-local language servers are attacker-plantable.
    // PATH-installed servers stay auto-approved; local .bin needs a token.
    if server_is_workspace_local(&program, &ws_root) {
        crate::approvals::approval_consume(
            &approvals,
            window.label(),
            "lsp_op",
            &approval_detail,
            &approval_token,
        )?;
    }
    tauri::async_runtime::spawn_blocking(move || {
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
            &symbol.unwrap_or_default(),
        )
        .map_err(|e| {
            if e.contains("cannot run") {
                format!("{} — {}", e, install_hint(lang))
            } else {
                e
            }
        })
    })
    .await
    .map_err(|error| format!("lsp: worker failed: {error}"))?
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
        let (prog, args) = server_command(LspLang::Ts, &file, Some(&base));
        assert!(prog.ends_with("typescript-language-server"), "got {}", prog);
        assert_eq!(args, vec!["--stdio"]);
        assert!(server_is_workspace_local(&prog, &base));
        let (prog, _) = server_command(LspLang::Rust, &file, Some(&base));
        assert_eq!(prog, "rust-analyzer");
        // Clamp: binary above the workspace is ignored.
        let outside = std::env::temp_dir().join(format!("vtnexa-lspops-out-{}", tag));
        let _ = std::fs::remove_dir_all(&outside);
        let (prog2, _) = server_command(LspLang::Ts, &outside.join("a.ts"), Some(&base));
        assert_eq!(prog2, "typescript-language-server");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
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

    #[test]
    fn oversized_lsp_header_is_rejected() {
        let data = format!("X: {}\r\n\r\n", "x".repeat(LSP_MAX_HEADER_LINE + 1));
        let mut reader = BoundedLspReader::new(std::io::Cursor::new(data.into_bytes()));
        let error = reader.next_message().unwrap_err();
        assert!(error.contains("header line exceeded"));
    }

    #[test]
    fn oversized_lsp_body_is_rejected() {
        let data = format!("Content-Length: {}\r\n\r\n", LSP_MAX_BODY + 1);
        let mut reader = BoundedLspReader::new(std::io::Cursor::new(data.into_bytes()));
        let error = reader.next_message().unwrap_err();
        assert!(error.contains("Content-Length"));
    }

    #[test]
    fn malformed_lsp_json_is_rejected() {
        let body = b"not-json";
        let data = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut bytes = data.into_bytes();
        bytes.extend_from_slice(body);
        let mut reader = BoundedLspReader::new(std::io::Cursor::new(bytes));
        let error = reader.next_message().unwrap_err();
        assert!(error.contains("malformed JSON"));
    }
}
