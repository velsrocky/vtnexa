// MCP host (OpenCode-pattern port): local stdio + remote Streamable HTTP.
//
// Scope: read `mcp` section from vtnexa.json (global + workspace merge),
// speak newline-delimited JSON-RPC over stdio to `type: "local"` servers and
// Streamable HTTP POST to `type: "remote"` servers, expose tools/list +
// tools/call. Remote auth is static headers with `{env:VAR}` substitution —
// OAuth (RFC 7591 + browser code flow) is rejected clearly until it lands.
//
// Security: servers are arbitrary code. Cwd is confined to the workspace,
// stderr is captured (capped) for errors, outputs are truncated, and secrets
// (header values, env, URL query strings) are never echoed back in errors or
// logs. All `mcp_*` calls from the agent go through the approval popup
// (see frontend GATED_TOOLS).

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
pub(crate) struct McpServerConfig {
    /// "local" (stdio) or "remote" (Streamable HTTP).
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
    /// Reserved: any non-false value is rejected until the OAuth flow lands.
    #[serde(default)]
    pub oauth: Option<serde_json::Value>,
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
            oauth: None,
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

// ---- Remote transport (Streamable HTTP) ----

/// Reject anything but http(s). Returns the trimmed URL.
pub(crate) fn validate_remote_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().to_string();
    if url.is_empty() {
        return Err("mcp: remote server has no url".to_string());
    }
    if url.len() > 2048 {
        return Err("mcp: remote url too long".to_string());
    }
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("mcp: remote url must start with http:// or https://".to_string());
    }
    if url.contains([' ', '\n', '\r', '\t']) {
        return Err("mcp: remote url contains whitespace".to_string());
    }
    Ok(url)
}

/// scheme://host for errors — query strings may carry secrets.
pub(crate) fn url_host_display(url: &str) -> String {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    let scheme = if url.to_lowercase().starts_with("https://") {
        "https"
    } else {
        "http"
    };
    format!(
        "{}://{}",
        scheme,
        host.chars().take(253).collect::<String>()
    )
}

/// `{env:NAME}` substitution for header values. Missing vars become "" (the
/// server then 401s with a clear error — never leak which var was missing
/// beyond its name, which is already in the user's own config).
pub(crate) fn subst_env_placeholders(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("{env:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 5..];
        match after.find('}') {
            Some(end) => {
                let name = &after[..end];
                if !name.is_empty()
                    && name.len() <= 128
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    out.push_str(&std::env::var(name).unwrap_or_default());
                } else {
                    // Not a valid placeholder: leave it literally.
                    out.push_str("{env:");
                    out.push_str(name);
                    out.push('}');
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// `data:` payloads of an SSE body, in order.
pub(crate) fn extract_sse_data(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in body.lines() {
        let t = line.trim();
        if let Some(payload) = t.strip_prefix("data:") {
            let payload = payload.trim();
            if !payload.is_empty() && payload != "[DONE]" {
                out.push(payload.to_string());
            }
        }
    }
    out
}

struct RemoteSession {
    client: reqwest::Client,
    url: String,
    headers: Vec<(String, String)>,
    session_id: Option<String>,
    host_display: String,
}

/// Marker prefix for 401s: callers refresh once and retry before surfacing.
pub(crate) const AUTH_RETRY_MARKER: &str = "mcp-auth-required";

async fn remote_session(
    name: &str,
    cfg: &McpServerConfig,
    force_refresh: bool,
) -> Result<RemoteSession, String> {
    let url = validate_remote_url(cfg.url.as_deref().unwrap_or(""))?;
    let host_display = url_host_display(&url);
    let mut headers = Vec::new();
    for (k, v) in cfg.headers.clone().unwrap_or_default() {
        if k.trim().is_empty() || k.len() > 256 {
            return Err(format!("mcp: server '{}' has an invalid header name", name));
        }
        let value = subst_env_placeholders(&v);
        if value.len() > 8192 {
            return Err(format!("mcp: server '{}' header value too long", name));
        }
        headers.push((k, value));
    }
    // OAuth bearer when credentials exist. Unsigned servers still proceed —
    // static headers may be all they need; a 401 then guides to sign-in.
    match crate::mcp_oauth::bearer_for(name, cfg, force_refresh).await? {
        crate::mcp_oauth::Bearer::Token(token) => {
            headers.push(("Authorization".to_string(), format!("Bearer {}", token)));
        }
        crate::mcp_oauth::Bearer::Disabled | crate::mcp_oauth::Bearer::Unsigned => {}
    }
    let timeout = Duration::from_millis(clamp_timeout(cfg.timeout));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("mcp: http client failed: {}", e))?;
    Ok(RemoteSession {
        client,
        url,
        headers,
        session_id: None,
        host_display,
    })
}

impl RemoteSession {
    /// POST one JSON-RPC message. Notifications (no id) accept any 2xx.
    /// Returns the matching response object for calls with an id.
    async fn post_rpc(
        &mut self,
        body: String,
        expect_id: Option<u64>,
    ) -> Result<Option<serde_json::Value>, String> {
        let mut req = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(body);
        if let Some(sid) = &self.session_id {
            req = req.header("Mcp-Session-Id", sid);
        }
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let res = req.send().await.map_err(|e| {
            if e.is_timeout() {
                format!("mcp: {} timed out", self.host_display)
            } else if e.is_connect() {
                format!("mcp: cannot reach {} ({})", self.host_display, e)
            } else {
                format!("mcp: {} request failed: {}", self.host_display, e)
            }
        })?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            // Marker, not prose: callers refresh once and retry before the
            // user ever sees it. Never include bodies (may echo tokens).
            return Err(format!(
                "{}: {} rejected the token",
                AUTH_RETRY_MARKER, self.host_display
            ));
        }
        if let Some(sid) = res.headers().get("mcp-session-id") {
            if let Ok(s) = sid.to_str() {
                if !s.is_empty() {
                    self.session_id = Some(s.to_string());
                }
            }
        }
        if !res.status().is_success() {
            // Status only: bodies may echo tokens back.
            return Err(format!(
                "mcp: {} answered HTTP {}",
                self.host_display,
                res.status()
            ));
        }
        let id = match expect_id {
            Some(id) => id,
            None => return Ok(None),
        };
        let ctype = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if ctype.contains("text/event-stream") {
            let text = res.text().await.unwrap_or_default();
            return find_response(&extract_sse_data(&text), id)
                .map(Some)
                .ok_or_else(|| {
                    format!(
                        "mcp: {} gave no JSON-RPC response (id {})",
                        self.host_display, id
                    )
                });
        }
        let text = res.text().await.unwrap_or_default();
        if text.trim().is_empty() {
            return Err(format!(
                "mcp: {} returned an empty body for id {}",
                self.host_display, id
            ));
        }
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| format!("mcp: {} returned non-JSON", self.host_display))?;
        if v.get("id").and_then(|i| i.as_u64()) != Some(id) {
            return Err(format!(
                "mcp: {} response id mismatch (wanted {})",
                self.host_display, id
            ));
        }
        Ok(Some(v))
    }

    async fn initialize(&mut self) -> Result<(), String> {
        let init = jsonrpc_request(
            "initialize",
            Some(1),
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "vtnexa", "version": env!("CARGO_PKG_VERSION")}
            }),
        );
        let resp = self
            .post_rpc(init, Some(1))
            .await?
            .ok_or_else(|| "mcp: unreachable".to_string())?;
        if let Some(err) = rpc_error_to_string(&resp) {
            return Err(err);
        }
        let note = jsonrpc_request("notifications/initialized", None, serde_json::json!({}));
        self.post_rpc(note, None).await?;
        Ok(())
    }
}

/// Map a 401 marker: header-only servers get credential guidance, OAuth
/// servers get one silent refresh + retry, then sign-in guidance.
async fn retry_remote<T, F, Fut>(name: &str, cfg: &McpServerConfig, once: F) -> Result<T, String>
where
    F: Fn(bool) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match once(false).await {
        Err(e) if e.starts_with(AUTH_RETRY_MARKER) => {
            if crate::mcp_oauth::oauth_mode(cfg) == crate::mcp_oauth::OAuthMode::Disabled {
                let host = e
                    .strip_prefix(AUTH_RETRY_MARKER)
                    .unwrap_or("")
                    .trim()
                    .trim_start_matches(':')
                    .trim();
                return Err(format!(
                    "mcp: {} rejected the credentials (HTTP 401) — check header values / {{env:}} vars",
                    host
                ));
            }
            once(true).await.map_err(|_| {
                format!(
                    "mcp: '{}' rejected the session — sign in again from the ⛁ panel",
                    name
                )
            })
        }
        other => other,
    }
}

async fn remote_list_tools(name: &str, cfg: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
    retry_remote(name, cfg, |force| remote_list_tools_once(name, cfg, force)).await
}

async fn remote_list_tools_once(
    name: &str,
    cfg: &McpServerConfig,
    force_refresh: bool,
) -> Result<Vec<McpToolInfo>, String> {
    let mut sess = remote_session(name, cfg, force_refresh).await?;
    sess.initialize().await?;
    let resp = sess
        .post_rpc(
            jsonrpc_request("tools/list", Some(2), serde_json::json!({})),
            Some(2),
        )
        .await?
        .ok_or_else(|| format!("mcp: {} gave no tools/list response", sess.host_display))?;
    if let Some(err) = rpc_error_to_string(&resp) {
        return Err(err);
    }
    tools_from_list_response(name, &resp)
}

async fn remote_call_tool(
    server: &str,
    cfg: &McpServerConfig,
    tool: &str,
    args: serde_json::Value,
) -> Result<String, String> {
    if tool.is_empty() || tool.len() > 128 {
        return Err("mcp: invalid tool name".to_string());
    }
    let arg_str = serde_json::to_string(&args).unwrap_or_default();
    if arg_str.len() > MCP_MAX_ARGS_BYTES {
        return Err("mcp: args too large (64KB max)".to_string());
    }
    match retry_remote(server, cfg, |force| {
        remote_call_tool_once(server, cfg, tool, args.clone(), force)
    })
    .await
    {
        other => other,
    }
}

async fn remote_call_tool_once(
    server: &str,
    cfg: &McpServerConfig,
    tool: &str,
    args: serde_json::Value,
    force_refresh: bool,
) -> Result<String, String> {
    let mut sess = remote_session(server, cfg, force_refresh).await?;
    sess.initialize().await?;
    let resp = sess
        .post_rpc(
            jsonrpc_request(
                "tools/call",
                Some(2),
                serde_json::json!({"name": tool, "arguments": args}),
            ),
            Some(2),
        )
        .await?
        .ok_or_else(|| format!("mcp: {} gave no tools/call response", sess.host_display))?;
    if let Some(err) = rpc_error_to_string(&resp) {
        return Err(err);
    }
    let result = resp
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(truncate_output(flatten_tool_result(&result)))
}

/// Shared tools/list parsing for stdio + HTTP paths.
fn tools_from_list_response(
    name: &str,
    resp: &serde_json::Value,
) -> Result<Vec<McpToolInfo>, String> {
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

pub(crate) async fn list_tools_for_server(
    name: &str,
    cfg: &McpServerConfig,
    root: &std::path::Path,
) -> Result<Vec<McpToolInfo>, String> {
    if cfg.r#type == "remote" {
        return remote_list_tools(name, cfg).await;
    }
    if cfg.r#type != "local" {
        return Err(format!(
            "mcp: server '{}' has unknown type '{}' (want \"local\" or \"remote\")",
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
    tools_from_list_response(name, &resp)
}

pub(crate) async fn call_tool_for_server(
    server: &str,
    cfg: &McpServerConfig,
    root: &std::path::Path,
    tool: &str,
    args: serde_json::Value,
) -> Result<String, String> {
    if cfg.r#type == "remote" {
        return remote_call_tool(server, cfg, tool, args).await;
    }
    if cfg.r#type != "local" {
        return Err(format!(
            "mcp: server '{}' has unknown type '{}' (want \"local\" or \"remote\")",
            server, cfg.r#type
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

/// Gate shared by list/call paths: unknown and disabled servers never spawn.
/// Remote is reported (not spawned) — transport lands separately.
pub(crate) fn check_server_usable<'a>(
    merged: &'a HashMap<String, McpServerConfig>,
    server: &str,
) -> Result<&'a McpServerConfig, String> {
    let cfg = merged
        .get(server)
        .ok_or_else(|| format!("mcp: unknown server '{}'", server))?;
    if !cfg.enabled {
        return Err(format!("mcp: server '{}' is disabled", server));
    }
    Ok(cfg)
}

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
pub(crate) async fn mcp_list_tools(
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
        match list_tools_for_server(&name, cfg, &root).await {
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
pub(crate) async fn mcp_call_tool(
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
    let cfg = check_server_usable(&merged, &server)?;
    call_tool_for_server(&server, cfg, &root, &tool, args).await
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

/// Value-level patch: set `.mcp[name].enabled` in the workspace file,
/// preserving every other key byte-for-byte-ish (re-serialized pretty).
/// Creates the minimal nesting when missing. Unknown top-level keys survive.
pub(crate) fn apply_enabled_patch(
    raw: &str,
    server: &str,
    enabled: bool,
) -> Result<String, String> {
    let mut doc: serde_json::Value = if raw.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&strip_json_comments(raw))
            .map_err(|e| format!("mcp config: invalid JSON: {}", e))?
    };
    if !doc.is_object() {
        return Err("mcp config: top level must be an object".to_string());
    }
    let mcp = doc
        .as_object_mut()
        .unwrap()
        .entry("mcp")
        .or_insert_with(|| serde_json::json!({}));
    if !mcp.is_object() {
        return Err("mcp config: \"mcp\" must be an object".to_string());
    }
    let entry = mcp
        .as_object_mut()
        .unwrap()
        .entry(server)
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        return Err(format!(
            "mcp config: server '{}' entry must be an object",
            server
        ));
    }
    entry
        .as_object_mut()
        .unwrap()
        .insert("enabled".to_string(), serde_json::Value::Bool(enabled));
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn mcp_set_server_enabled(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    server: String,
    enabled: bool,
) -> Result<(), String> {
    if !valid_server_name(&server) {
        return Err("mcp: invalid server name".to_string());
    }
    let root = crate::root_snapshot(&state, window.label());
    // Must be a known server (global or workspace) — no typos creating junk.
    let merged = load_merged_mcp_config(&root)?;
    if !merged.contains_key(&server) {
        return Err(format!("mcp: unknown server '{}'", server));
    }
    let dir = root.join(".vtnexa");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("vtnexa.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let next = apply_enabled_patch(&raw, &server, enabled)?;
    crate::write_atomic(&path, next.as_bytes())
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
    fn remote_config_fails_fast_without_network() {
        // OAuth objects are supported now: without a url, validation (not
        // discovery) fails — no network touched either way.
        for oauth in [
            None,
            Some(serde_json::json!(false)),
            Some(serde_json::json!({"clientId": "x"})),
        ] {
            let mut cfg = McpServerConfig {
                r#type: "remote".to_string(),
                ..Default::default()
            };
            cfg.oauth = oauth;
            let err = tauri::async_runtime::block_on(list_tools_for_server(
                "r",
                &cfg,
                std::path::Path::new("/tmp"),
            ))
            .unwrap_err();
            assert!(err.contains("no url"), "got: {}", err);
        }
    }

    #[test]
    fn missing_command_is_a_clear_error() {
        let cfg = McpServerConfig::default();
        let err = tauri::async_runtime::block_on(list_tools_for_server(
            "s",
            &cfg,
            std::path::Path::new("/tmp"),
        ))
        .unwrap_err();
        assert!(err.contains("no command"), "got: {}", err);
    }

    #[test]
    fn remote_urls_are_validated() {
        assert!(validate_remote_url("https://mcp.example.com/mcp").is_ok());
        assert!(validate_remote_url("http://127.0.0.1:3000/mcp").is_ok());
        assert!(validate_remote_url("").unwrap_err().contains("no url"));
        assert!(validate_remote_url("ws://example.com")
            .unwrap_err()
            .contains("http"));
        assert!(validate_remote_url("https://example.com/a b")
            .unwrap_err()
            .contains("whitespace"));
    }

    #[test]
    fn host_display_strips_secrets() {
        assert_eq!(
            url_host_display("https://mcp.example.com/mcp?key=SECRET"),
            "https://mcp.example.com"
        );
        assert_eq!(
            url_host_display("http://127.0.0.1:3000/x"),
            "http://127.0.0.1:3000"
        );
    }

    #[test]
    fn env_placeholders_substitute() {
        std::env::set_var("VTNEXA_TEST_SUBST", "s3cret");
        assert_eq!(
            subst_env_placeholders("Bearer {env:VTNEXA_TEST_SUBST}"),
            "Bearer s3cret"
        );
        assert_eq!(
            subst_env_placeholders("Bearer {env:VTNEXA_TEST_MISSING_XYZ}"),
            "Bearer "
        );
        // Invalid placeholder shape is left literally.
        assert_eq!(subst_env_placeholders("{env:bad-name!}"), "{env:bad-name!}");
        assert_eq!(subst_env_placeholders("plain"), "plain");
        std::env::remove_var("VTNEXA_TEST_SUBST");
    }

    #[test]
    fn sse_data_lines_extract() {
        let body = ": ping\n\ndata: {\"a\":1}\n\ndata: [DONE]\n\ndata: {\"b\":2}\n\n";
        assert_eq!(
            extract_sse_data(body),
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
        // SSE envelope + id matching reuses the stdio matcher.
        let lines =
            extract_sse_data("data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n");
        let r = find_response(&lines, 2).unwrap();
        assert_eq!(r["result"]["tools"].as_array().unwrap().len(), 0);
    }

    fn usable_map() -> HashMap<String, McpServerConfig> {
        let mut m = HashMap::new();
        m.insert("on".to_string(), McpServerConfig::default());
        m.insert(
            "off".to_string(),
            McpServerConfig {
                enabled: false,
                ..Default::default()
            },
        );
        m
    }

    #[test]
    fn gate_blocks_unknown_and_disabled_before_spawn() {
        let m = usable_map();
        assert!(check_server_usable(&m, "on").is_ok());
        assert!(check_server_usable(&m, "off")
            .unwrap_err()
            .contains("disabled"));
        assert!(check_server_usable(&m, "nope")
            .unwrap_err()
            .contains("unknown"));
    }

    #[test]
    fn enabled_patch_preserves_other_keys() {
        let out = apply_enabled_patch(
            r#"{"model": "x", "mcp": {"s": {"type": "local", "command": ["a"]}}}"#,
            "s",
            false,
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "x");
        assert_eq!(v["mcp"]["s"]["enabled"], false);
        assert_eq!(v["mcp"]["s"]["command"][0], "a");
    }

    #[test]
    fn enabled_patch_creates_nesting_from_empty() {
        let out = apply_enabled_patch("", "s", true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcp"]["s"]["enabled"], true);
    }

    #[test]
    fn enabled_patch_rejects_non_objects() {
        assert!(apply_enabled_patch(r#"{"mcp": []}"#, "s", true).is_err());
        assert!(apply_enabled_patch(r#"{"mcp": {"s": 1}}"#, "s", true).is_err());
    }
}

#[cfg(test)]
mod remote_roundtrip_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};

    /// Minimal Streamable-HTTP mock: initialize (with session id), 202 for
    /// notifications, canned tools/list + tools/call. Records whether the
    /// session header was threaded on post-handshake requests.
    fn spawn_mock() -> (String, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_srv = seen.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/mcp",
            listener.local_addr().unwrap().port()
        );
        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let seen_srv = seen_srv.clone();
                std::thread::spawn(move || {
                    let mut buf = vec![0u8; 65536];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let has_session = req.to_lowercase().contains("mcp-session-id: test123");
                    seen_srv
                        .lock()
                        .unwrap()
                        .push(format!("session={}", has_session));
                    let body = req.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                    let method = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("method").and_then(|m| m.as_str()).map(str::to_string))
                        .unwrap_or_default();
                    let id = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("id").cloned())
                        .unwrap_or(serde_json::Value::Null);
                    let (status, extra_headers, resp_body) = match method.as_str() {
                        "initialize" => (
                            "200 OK",
                            "Mcp-Session-Id: test123\r\nContent-Type: application/json\r\n",
                            serde_json::json!({
                                "jsonrpc": "2.0", "id": id,
                                "result": {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "mock"}}
                            })
                            .to_string(),
                        ),
                        "notifications/initialized" => ("202 Accepted", "", String::new()),
                        "tools/list" => (
                            "200 OK",
                            "Content-Type: application/json\r\n",
                            serde_json::json!({
                                "jsonrpc": "2.0", "id": id,
                                "result": {"tools": [{"name": "add", "description": "add numbers", "inputSchema": {"type": "object"}}]}
                            })
                            .to_string(),
                        ),
                        "tools/call" => (
                            "200 OK",
                            "Content-Type: application/json\r\n",
                            serde_json::json!({
                                "jsonrpc": "2.0", "id": id,
                                "result": {"content": [{"type": "text", "text": "7"}]}
                            })
                            .to_string(),
                        ),
                        _ => (
                            "200 OK",
                            "Content-Type: application/json\r\n",
                            serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"message": "unknown"}}).to_string(),
                        ),
                    };
                    let reply = format!(
                        "HTTP/1.1 {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                        status,
                        extra_headers,
                        resp_body.len(),
                        resp_body
                    );
                    let _ = stream.write_all(reply.as_bytes());
                });
            }
        });
        (url, seen)
    }

    fn remote_cfg(url: String) -> McpServerConfig {
        McpServerConfig {
            r#type: "remote".to_string(),
            url: Some(url),
            ..Default::default()
        }
    }

    #[test]
    fn remote_list_and_call_thread_the_session() {
        let (url, seen) = spawn_mock();
        let cfg = remote_cfg(url);
        let tools = tauri::async_runtime::block_on(list_tools_for_server(
            "mock",
            &cfg,
            std::path::Path::new("/tmp"),
        ))
        .expect("list failed");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].qualified_name, "mcp_mock_add");
        let out = tauri::async_runtime::block_on(call_tool_for_server(
            "mock",
            &cfg,
            std::path::Path::new("/tmp"),
            "add",
            serde_json::json!({"a": 3, "b": 4}),
        ))
        .expect("call failed");
        assert!(out.contains('7'), "got: {}", out);
        // Each operation re-handshakes: initialize carries no session yet;
        // every later request in that operation must thread it.
        let seen = seen.lock().unwrap();
        assert_eq!(
            *seen,
            vec![
                "session=false", // list: initialize
                "session=true",  // list: notifications/initialized
                "session=true",  // list: tools/list
                "session=false", // call: initialize
                "session=true",  // call: notifications/initialized
                "session=true",  // call: tools/call
            ],
            "seen: {:?}",
            *seen
        );
    }
}
