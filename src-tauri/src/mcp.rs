// Minimal MCP host (OpenCode-pattern port, local stdio only).
//
// Scope: read `mcp` section from vtnexa.json (global + workspace merge),
// speak newline-delimited JSON-RPC over stdio to `type: "local"` servers,
// expose tools/list + tools/call. `type: "remote"` is rejected with a clear
// error until the HTTP/SSE transport lands.
//
// Security: servers are arbitrary code. Cwd is confined to the workspace,
// stderr is captured (capped) for errors, outputs are truncated, and secrets
// (headers/env) are never echoed back or written to logs. All `mcp_*` calls
// from the agent go through the approval popup (see frontend GATED_TOOLS).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};

pub(crate) const MCP_DEFAULT_TIMEOUT_MS: u64 = 5000;
pub(crate) const MCP_MAX_TIMEOUT_MS: u64 = 30_000;
pub(crate) const MCP_MAX_OUTPUT_CHARS: usize = 30_000;
const MCP_MAX_ARGS_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize, Default)]
pub(crate) struct VtnexaConfigFile {
    #[serde(default)]
    pub mcp: HashMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // url/headers reserved for remote transport ( minimal build rejects remote )
pub(crate) struct McpServerConfig {
    /// "local" (supported) or "remote" (rejected for now with a clear error).
    #[serde(default = "default_server_type")]
    pub r#type: String,
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}

fn default_server_type() -> String {
    "local".to_string()
}
fn default_enabled() -> bool {
    true
}
fn default_timeout() -> u64 {
    MCP_DEFAULT_TIMEOUT_MS
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            r#type: default_server_type(),
            command: None,
            url: None,
            headers: None,
            environment: None,
            cwd: None,
            enabled: true,
            timeout: MCP_DEFAULT_TIMEOUT_MS,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct McpServerStatus {
    pub name: String,
    pub kind: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct McpToolInfo {
    pub server: String,
    pub name: String,
    /// LLM-facing name: mcp_<server>_<tool> (sanitized).
    pub qualified_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: serde_json::Value,
}

// ---- Config loading: global < workspace (per-server merge) ----

pub(crate) fn global_config_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|h| {
            std::path::PathBuf::from(h)
                .join(".config")
                .join("vtnexa")
                .join("vtnexa.json")
        })
}

pub(crate) fn project_config_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".vtnexa").join("vtnexa.json")
}

fn parse_config_file(path: &std::path::Path) -> Result<VtnexaConfigFile, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(VtnexaConfigFile::default())
        }
        Err(e) => return Err(format!("mcp config: cannot read {}: {}", path.display(), e)),
    };
    // Support JSONC (comments) minimally: serde_json can't, so strip // and /* */.
    let stripped = strip_json_comments(&raw);
    serde_json::from_str(&stripped)
        .map_err(|e| format!("mcp config: invalid JSON in {}: {}", path.display(), e))
}

fn strip_json_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    let mut in_str = false;
    let mut esc = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            continue;
        }
        if c == '/' {
            match chars.peek() {
                Some('/') => {
                    for nc in chars.by_ref() {
                        if nc == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    let mut prev_star = false;
                    for nc in chars.by_ref() {
                        if prev_star && nc == '/' {
                            break;
                        }
                        prev_star = nc == '*';
                    }
                    continue;
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub(crate) fn load_merged_mcp_config(
    root: &std::path::Path,
) -> Result<HashMap<String, McpServerConfig>, String> {
    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();
    if let Some(gp) = global_config_path() {
        for (k, v) in parse_config_file(&gp)?.mcp {
            if valid_server_name(&k) {
                merged.insert(k, v);
            }
        }
    }
    // Workspace wins per server name (full entry replacement, like opencode).
    for (k, v) in parse_config_file(&project_config_path(root))?.mcp {
        if valid_server_name(&k) {
            merged.insert(k, v);
        }
    }
    Ok(merged)
}

pub(crate) fn clamp_timeout(ms: u64) -> u64 {
    ms.clamp(1000, MCP_MAX_TIMEOUT_MS)
}

pub(crate) fn valid_server_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ---- Tool-name sanitizing (LLM-facing `mcp_<server>_<tool>`) ----

fn sanitize_fragment(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if c == '_' || c == '-' || c == '.' {
            out.push('_');
        }
        // drop everything else
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "tool".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

/// Returns None when the server name itself is invalid.
pub(crate) fn qualified_tool_name(server: &str, tool: &str) -> Option<String> {
    if !valid_server_name(server) {
        return None;
    }
    if tool.is_empty() || tool.len() > 128 {
        return None;
    }
    Some(format!(
        "mcp_{}_{}",
        sanitize_fragment(server),
        sanitize_fragment(tool)
    ))
}

pub(crate) fn truncate_output(s: String) -> String {
    crate::truncate_chars(s, MCP_MAX_OUTPUT_CHARS)
}

// ---- JSON-RPC framing ----

pub(crate) fn jsonrpc_request(method: &str, id: Option<u64>, params: serde_json::Value) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "jsonrpc".to_string(),
        serde_json::Value::String("2.0".to_string()),
    );
    if let Some(i) = id {
        obj.insert("id".to_string(), serde_json::Value::Number(i.into()));
    }
    obj.insert(
        "method".to_string(),
        serde_json::Value::String(method.to_string()),
    );
    obj.insert("params".to_string(), params);
    serde_json::Value::Object(obj).to_string()
}

fn find_response(lines: &[String], id: u64) -> Option<serde_json::Value> {
    for line in lines {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) => continue, // server logs on stdout: skip non-JSON
        };
        if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
            return Some(v);
        }
    }
    None
}

fn rpc_error_to_string(resp: &serde_json::Value) -> Option<String> {
    resp.get("error").map(|e| {
        let msg = e
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        format!(
            "mcp: server error: {}",
            msg.chars().take(500).collect::<String>()
        )
    })
}

// ---- Process spawning (one-shot per operation) ----

fn resolve_cwd(
    cfg: &McpServerConfig,
    root: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let raw = cfg.cwd.as_deref().unwrap_or("").trim();
    if raw.is_empty() {
        return Ok(root.to_path_buf());
    }
    let p = if std::path::Path::new(raw).is_absolute() {
        std::path::PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    // Confine: must resolve inside the workspace when it exists.
    if let Ok(canon) = p.canonicalize() {
        let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if !canon.starts_with(&root_canon) {
            return Err("mcp: cwd resolves outside workspace".to_string());
        }
        return Ok(canon);
    }
    // Non-existing: lexical check must stay inside root.
    if !p.starts_with(root) {
        return Err("mcp: cwd is outside workspace".to_string());
    }
    Ok(root.to_path_buf())
}

/// Spawn `command`, feed `send_lines` (each + "\n"), collect stdout lines until
/// `expect_ids` are all seen, EOF, or timeout. Always reaps the child.
fn run_stdio_once(
    command: &[String],
    cwd: &std::path::Path,
    env: &HashMap<String, String>,
    send_lines: &[String],
    timeout: Duration,
) -> Result<(Vec<String>, String), String> {
    if command.is_empty() || command[0].trim().is_empty() {
        return Err("mcp: server command is empty".to_string());
    }
    let mut cmd = std::process::Command::new(&command[0]);
    if command.len() > 1 {
        cmd.args(&command[1..]);
    }
    cmd.current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in env {
        if k.is_empty() || k.contains('\0') || v.contains('\0') {
            continue;
        }
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("mcp: spawn failed: {}", e))?;
    let mut stdin = child.stdin.take().ok_or("mcp: no stdin")?;
    let stdout = child.stdout.take().ok_or("mcp: no stdout")?;
    let mut stderr = child.stderr.take();

    for line in send_lines {
        writeln!(stdin, "{}", line).map_err(|e| format!("mcp: stdin write failed: {}", e))?;
    }
    stdin
        .flush()
        .map_err(|e| format!("mcp: stdin flush failed: {}", e))?;
    drop(stdin); // keep stdout open; server replies then waits — we read with timeout

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + timeout;
    let mut out: Vec<String> = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left.min(Duration::from_millis(250))) {
            Ok(line) => {
                out.push(line);
                if out.len() > 500 {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let mut err_tail = String::new();
    if let Some(mut e) = stderr.take() {
        use std::io::Read;
        let mut buf = String::new();
        // Best-effort, non-blocking-ish: read whatever is available (up to 4KB).
        let mut limited = (&mut e).take(4096);
        if limited.read_to_string(&mut buf).is_ok() && !buf.trim().is_empty() {
            err_tail = buf.chars().take(1000).collect();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok((out, err_tail))
}

fn handshake_lines() -> Vec<String> {
    vec![
        jsonrpc_request(
            "initialize",
            Some(1),
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "vtnexa", "version": env!("CARGO_PKG_VERSION")}
            }),
        ),
        jsonrpc_request("notifications/initialized", None, serde_json::json!({})),
    ]
}

pub(crate) fn list_tools_for_server(
    name: &str,
    cfg: &McpServerConfig,
    root: &std::path::Path,
) -> Result<Vec<McpToolInfo>, String> {
    if cfg.r#type != "local" {
        return Err(format!(
            "mcp: server '{}' is type '{}' — remote servers are not supported in this minimal build, use type \"local\"",
            name, cfg.r#type
        ));
    }
    let command = cfg.command.as_deref().unwrap_or(&[]).to_vec();
    if command.is_empty() {
        return Err(format!("mcp: server '{}' has no command", name));
    }
    let cwd = resolve_cwd(cfg, root)?;
    let env = cfg.environment.clone().unwrap_or_default();
    let timeout = Duration::from_millis(clamp_timeout(cfg.timeout));
    let mut send = handshake_lines();
    send.push(jsonrpc_request(
        "tools/list",
        Some(2),
        serde_json::json!({}),
    ));
    let (lines, stderr) = run_stdio_once(&command, &cwd, &env, &send, timeout)?;
    let resp = find_response(&lines, 2).ok_or_else(|| {
        if stderr.trim().is_empty() {
            format!(
                "mcp: server '{}' gave no tools/list response (timeout {}ms)",
                name,
                timeout.as_millis()
            )
        } else {
            format!("mcp: server '{}' failed: {}", name, stderr.trim())
        }
    })?;
    if let Some(err) = rpc_error_to_string(&resp) {
        return Err(err);
    }
    let tools = resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .ok_or_else(|| format!("mcp: server '{}' returned malformed tools/list", name))?;
    let mut out = Vec::new();
    for t in tools.iter().take(100) {
        let tname = t
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if tname.is_empty() {
            continue;
        }
        let q = match qualified_tool_name(name, &tname) {
            Some(q) => q,
            None => continue,
        };
        out.push(McpToolInfo {
            server: name.to_string(),
            name: tname,
            qualified_name: q,
            description: t
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .chars()
                .take(500)
                .collect(),
            input_schema: t
                .get("inputSchema")
                .cloned()
                .unwrap_or(serde_json::json!({})),
        });
    }
    Ok(out)
}

pub(crate) fn call_tool_for_server(
    server: &str,
    cfg: &McpServerConfig,
    root: &std::path::Path,
    tool: &str,
    args: serde_json::Value,
) -> Result<String, String> {
    if cfg.r#type != "local" {
        return Err(format!(
            "mcp: server '{}' is remote — not supported in this minimal build",
            server
        ));
    }
    if tool.is_empty() || tool.len() > 128 {
        return Err("mcp: invalid tool name".to_string());
    }
    let arg_str = serde_json::to_string(&args).unwrap_or_default();
    if arg_str.len() > MCP_MAX_ARGS_BYTES {
        return Err("mcp: args too large (64KB max)".to_string());
    }
    let command = cfg.command.as_deref().unwrap_or(&[]).to_vec();
    if command.is_empty() {
        return Err(format!("mcp: server '{}' has no command", server));
    }
    let cwd = resolve_cwd(cfg, root)?;
    let env = cfg.environment.clone().unwrap_or_default();
    let timeout = Duration::from_millis(clamp_timeout(cfg.timeout));
    let mut send = handshake_lines();
    send.push(jsonrpc_request(
        "tools/call",
        Some(2),
        serde_json::json!({"name": tool, "arguments": args}),
    ));
    let (lines, stderr) = run_stdio_once(&command, &cwd, &env, &send, timeout)?;
    let resp = find_response(&lines, 2).ok_or_else(|| {
        if stderr.trim().is_empty() {
            format!(
                "mcp: server '{}' gave no tools/call response (timeout {}ms)",
                server,
                timeout.as_millis()
            )
        } else {
            format!("mcp: server '{}' failed: {}", server, stderr.trim())
        }
    })?;
    if let Some(err) = rpc_error_to_string(&resp) {
        return Err(err);
    }
    let result = resp
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    // Flatten MCP content blocks to text when possible.
    let text = flatten_tool_result(&result);
    Ok(truncate_output(text))
}

fn flatten_tool_result(v: &serde_json::Value) -> String {
    if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
        let mut parts = Vec::new();
        for block in content {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                parts.push(t.to_string());
            } else {
                parts.push(
                    serde_json::to_string(block)
                        .unwrap_or_default()
                        .chars()
                        .take(4000)
                        .collect(),
                );
            }
        }
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".to_string())
}

// ---- Tauri commands ----

#[tauri::command]
pub(crate) fn mcp_list_servers(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
) -> Result<Vec<McpServerStatus>, String> {
    let root = crate::root_snapshot(&state, window.label());
    let merged = load_merged_mcp_config(&root)?;
    let mut out: Vec<McpServerStatus> = merged
        .iter()
        .map(|(k, v)| McpServerStatus {
            name: k.clone(),
            kind: v.r#type.clone(),
            enabled: v.enabled,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub(crate) fn mcp_list_tools(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
) -> Result<Vec<McpToolInfo>, String> {
    let root = crate::root_snapshot(&state, window.label());
    let merged = load_merged_mcp_config(&root)?;
    let mut names: Vec<String> = merged.keys().cloned().collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let cfg = &merged[&name];
        if !cfg.enabled {
            continue;
        }
        // One failing server must not hide the others.
        match list_tools_for_server(&name, cfg, &root) {
            Ok(mut tools) => out.append(&mut tools),
            Err(e) => {
                out.push(McpToolInfo {
                    server: name.clone(),
                    name: "__error__".to_string(),
                    qualified_name: format!("mcp_{}_error", sanitize_fragment(&name)),
                    description: e.chars().take(300).collect(),
                    input_schema: serde_json::json!({}),
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub(crate) fn mcp_call_tool(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    server: String,
    tool: String,
    args: serde_json::Value,
) -> Result<String, String> {
    if !valid_server_name(&server) {
        return Err("mcp: invalid server name".to_string());
    }
    let root = crate::root_snapshot(&state, window.label());
    let merged = load_merged_mcp_config(&root)?;
    let cfg = merged
        .get(&server)
        .ok_or_else(|| format!("mcp: unknown server '{}'", server))?;
    if !cfg.enabled {
        return Err(format!("mcp: server '{}' is disabled", server));
    }
    call_tool_for_server(&server, cfg, &root, &tool, args)
}

#[tauri::command]
pub(crate) fn mcp_config_get(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
) -> Result<serde_json::Value, String> {
    // Redacted: names + kind + enabled only. Secrets never leave the backend.
    let root = crate::root_snapshot(&state, window.label());
    let merged = load_merged_mcp_config(&root)?;
    let mut servers = serde_json::Map::new();
    for (k, v) in &merged {
        servers.insert(
            k.clone(),
            serde_json::json!({"type": v.r#type, "enabled": v.enabled}),
        );
    }
    Ok(serde_json::json!({"servers": servers}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_names_are_validated() {
        assert!(valid_server_name("sentry"));
        assert!(valid_server_name("my-mcp_1"));
        assert!(!valid_server_name(""));
        assert!(!valid_server_name("has space"));
        assert!(!valid_server_name("a/b"));
        assert!(!valid_server_name(&"x".repeat(65)));
    }

    #[test]
    fn qualified_names_are_sanitized() {
        assert_eq!(
            qualified_tool_name("sentry", "list_issues").as_deref(),
            Some("mcp_sentry_list_issues")
        );
        assert_eq!(
            qualified_tool_name("my-mcp", "get.Issue!").as_deref(),
            Some("mcp_my_mcp_get_issue")
        );
        assert!(qualified_tool_name("bad name!", "x").is_none());
        assert!(qualified_tool_name("ok", "").is_none());
    }

    #[test]
    fn timeouts_are_clamped() {
        assert_eq!(clamp_timeout(100), 1000);
        assert_eq!(clamp_timeout(5000), 5000);
        assert_eq!(clamp_timeout(120_000), MCP_MAX_TIMEOUT_MS);
    }

    #[test]
    fn jsonrpc_request_has_id_and_method() {
        let s = jsonrpc_request("tools/list", Some(2), serde_json::json!({}));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 2);
        assert_eq!(v["method"], "tools/list");
        // notification: no id
        let n = jsonrpc_request("notifications/initialized", None, serde_json::json!({}));
        let nv: serde_json::Value = serde_json::from_str(&n).unwrap();
        assert!(nv.get("id").is_none());
    }

    #[test]
    fn finds_matching_response_and_skips_logs() {
        let lines = vec![
            "starting server on stdio".to_string(),
            r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#.to_string(),
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#.to_string(),
        ];
        let r = find_response(&lines, 2).unwrap();
        assert_eq!(r["result"]["tools"].as_array().unwrap().len(), 0);
        assert!(find_response(&lines, 99).is_none());
    }

    #[test]
    fn rpc_errors_surface() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":2,"error":{"message":"nope"}}"#).unwrap();
        assert!(rpc_error_to_string(&v).unwrap().contains("nope"));
    }

    #[test]
    fn comments_do_not_break_config() {
        let v: VtnexaConfigFile = serde_json::from_str(&strip_json_comments(
            r#"{"mcp": {"s": {"type": "local", /* x */ "command": ["a"] // y
            }}}"#,
        ))
        .unwrap();
        assert!(v.mcp.contains_key("s"));
    }

    #[test]
    fn remote_servers_are_rejected_clearly() {
        let cfg = McpServerConfig {
            r#type: "remote".to_string(),
            url: Some("https://example.com/mcp".to_string()),
            ..Default::default()
        };
        let err = list_tools_for_server("r", &cfg, std::path::Path::new("/tmp")).unwrap_err();
        assert!(err.contains("remote"), "got: {}", err);
    }

    #[test]
    fn missing_command_is_a_clear_error() {
        let cfg = McpServerConfig::default();
        let err = list_tools_for_server("s", &cfg, std::path::Path::new("/tmp")).unwrap_err();
        assert!(err.contains("no command"), "got: {}", err);
    }
}
