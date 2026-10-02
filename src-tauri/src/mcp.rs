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
// logs. All `mcp_call_tool` from the agent requires a backend approval token
// (see approvals::ApprovalStore) in addition to the frontend modal.

use crate::process::{self, LineDecision, LineObserver, ProcessLimits, ProcessOptions};
use crate::workspace::{
    checked_internal_path, create_internal_directory, ensure_within_root, is_internal_path,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const MCP_DEFAULT_TIMEOUT_MS: u64 = 5000;
pub(crate) const MCP_MAX_TIMEOUT_MS: u64 = 30_000;
pub(crate) const MCP_MAX_OUTPUT_CHARS: usize = 30_000;
const MCP_MAX_ARGS_BYTES: usize = 64 * 1024;
const MCP_CONFIG_MAX_BYTES: usize = 1024 * 1024;
const MCP_MAX_STDOUT_LINE_BYTES: usize = 1024 * 1024;
const MCP_MAX_STDERR_BYTES: usize = 1024 * 1024;
const MCP_MAX_COMBINED_BYTES: usize = 2 * 1024 * 1024;
const MCP_MAX_LINES: usize = 500;
const MCP_MAX_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;
const MCP_QUALIFIED_MAX_LEN: usize = 128;
const MCP_QUALIFIED_HASH_LEN: usize = 8;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum McpConfigSource {
    Global,
    Workspace,
}

#[derive(Debug, Clone)]
pub(crate) struct McpServerEntry {
    pub config: McpServerConfig,
    pub source: McpConfigSource,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub(crate) struct McpTrustKey {
    pub root: String,
    pub server: String,
    pub fingerprint: String,
}

struct McpObservedConfig {
    fingerprint: String,
    workspace_controlled: bool,
}

#[derive(Default)]
struct McpTrustInner {
    grants: HashSet<McpTrustKey>,
    observed: HashMap<(String, String), McpObservedConfig>,
}

#[derive(Default)]
pub(crate) struct McpTrustStore {
    inner: Mutex<McpTrustInner>,
}

pub(crate) fn canonical_workspace_key(root: &Path) -> String {
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(root)
    };
    let canonical = absolute.canonicalize().unwrap_or(absolute);
    let mut value = canonical.to_string_lossy().replace('\\', "/");
    while value.len() > 1 && value.ends_with('/') {
        value.pop();
    }
    #[cfg(windows)]
    {
        value = value.to_lowercase();
    }
    value
}

pub(crate) fn mcp_trust_key(root: &Path, server: &str, fingerprint: &str) -> McpTrustKey {
    McpTrustKey {
        root: canonical_workspace_key(root),
        server: server.to_string(),
        fingerprint: fingerprint.to_string(),
    }
}

impl McpTrustStore {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, McpTrustInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "mcp trust store is unavailable".to_string())
    }

    pub(crate) fn observe(
        &self,
        root: &Path,
        server: &str,
        fingerprint: &str,
        workspace_controlled: bool,
        enabled: bool,
    ) -> Result<bool, String> {
        let root_key = canonical_workspace_key(root);
        let identity = (root_key.clone(), server.to_string());
        let mut inner = self.lock()?;
        if !workspace_controlled || !enabled {
            inner
                .grants
                .retain(|key| key.root != root_key || key.server != server);
            inner.observed.remove(&identity);
            return Ok(false);
        }
        if let Some(previous) = inner.observed.get(&identity) {
            if previous.fingerprint != fingerprint
                || previous.workspace_controlled != workspace_controlled
            {
                inner
                    .grants
                    .retain(|key| key.root != root_key || key.server != server);
            }
        }
        inner.observed.insert(
            identity,
            McpObservedConfig {
                fingerprint: fingerprint.to_string(),
                workspace_controlled,
            },
        );
        Ok(inner
            .grants
            .contains(&mcp_trust_key(root, server, fingerprint)))
    }

    pub(crate) fn grant(&self, root: &Path, server: &str, fingerprint: &str) -> Result<(), String> {
        let root_key = canonical_workspace_key(root);
        let identity = (root_key.clone(), server.to_string());
        let mut inner = self.lock()?;
        if let Some(previous) = inner.observed.get(&identity) {
            if previous.fingerprint != fingerprint || !previous.workspace_controlled {
                inner
                    .grants
                    .retain(|key| key.root != root_key || key.server != server);
            }
        }
        inner.observed.insert(
            identity,
            McpObservedConfig {
                fingerprint: fingerprint.to_string(),
                workspace_controlled: true,
            },
        );
        inner
            .grants
            .insert(mcp_trust_key(root, server, fingerprint));
        Ok(())
    }

    pub(crate) fn revoke(&self, root: &Path, server: &str) -> Result<(), String> {
        let root_key = canonical_workspace_key(root);
        let mut inner = self.lock()?;
        inner
            .grants
            .retain(|key| key.root != root_key || key.server != server);
        inner.observed.remove(&(root_key, server.to_string()));
        Ok(())
    }

    pub(crate) fn sync(
        &self,
        root: &Path,
        workspace_names: &HashSet<String>,
        global_names: &HashSet<String>,
    ) -> Result<(), String> {
        let root_key = canonical_workspace_key(root);
        let known: HashSet<String> = workspace_names.union(global_names).cloned().collect();
        let mut inner = self.lock()?;
        inner
            .grants
            .retain(|key| key.root != root_key || known.contains(&key.server));
        inner.observed.retain(|identity, _| {
            let (observed_root, server) = identity;
            observed_root != &root_key || known.contains(server)
        });
        for server in global_names {
            inner
                .grants
                .retain(|key| key.root != root_key || key.server != *server);
            inner.observed.remove(&(root_key.clone(), server.clone()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct McpServerStatus {
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub configured: bool,
    pub configured_enabled: bool,
    pub trusted: bool,
    pub consent_required: bool,
    pub workspace_controlled: bool,
    pub fingerprint: String,
    #[serde(default)]
    pub untrusted: bool,
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

fn non_empty_path(value: Option<PathBuf>) -> Option<PathBuf> {
    value.filter(|path| !path.as_os_str().is_empty())
}

pub(crate) fn global_config_path_for<F>(platform: &str, get: F) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<PathBuf>,
{
    let base = if platform.eq_ignore_ascii_case("windows") {
        non_empty_path(get("APPDATA")).or_else(|| {
            non_empty_path(get("USERPROFILE")).map(|home| home.join("AppData").join("Roaming"))
        })
    } else {
        non_empty_path(get("XDG_CONFIG_HOME"))
            .or_else(|| non_empty_path(get("HOME")).map(|home| home.join(".config")))
    };
    let directory = if platform.eq_ignore_ascii_case("windows") {
        "VTNexa"
    } else {
        "vtnexa"
    };
    base.map(|base| base.join(directory).join("vtnexa.json"))
}

pub(crate) fn global_config_path() -> Option<PathBuf> {
    global_config_path_for(std::env::consts::OS, |name| {
        std::env::var_os(name).map(PathBuf::from)
    })
}

#[allow(dead_code)]
pub(crate) fn project_config_path(root: &Path) -> PathBuf {
    root.join(".vtnexa").join("vtnexa.json")
}

fn checked_project_config_path(root: &Path) -> Result<PathBuf, String> {
    checked_internal_path(root, Path::new(".vtnexa/vtnexa.json"), "mcp config")
}

fn read_bounded_text(
    path: &Path,
    max: usize,
    what: &str,
) -> Result<String, (std::io::ErrorKind, String)> {
    let file = std::fs::File::open(path).map_err(|error| {
        (
            error.kind(),
            format!("{}: cannot read {}: {}", what, path.display(), error),
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        (
            error.kind(),
            format!("{}: cannot inspect {}: {}", what, path.display(), error),
        )
    })?;
    if !metadata.is_file() {
        return Err((
            std::io::ErrorKind::InvalidData,
            format!("{}: {} is not a regular file", what, path.display()),
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
    let capacity = usize::try_from(metadata.len()).unwrap_or(0).min(max);
    let mut bytes = Vec::with_capacity(capacity);
    let limit = max as u64 + 1;
    file.take(limit).read_to_end(&mut bytes).map_err(|error| {
        (
            error.kind(),
            format!("{}: cannot read {}: {}", what, path.display(), error),
        )
    })?;
    if bytes.len() > max {
        return Err((
            std::io::ErrorKind::InvalidData,
            format!("{}: file too large (more than {} bytes)", what, max),
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        (
            std::io::ErrorKind::InvalidData,
            format!("{}: file is not valid UTF-8", what),
        )
    })
}

fn parse_config_file(path: &std::path::Path) -> Result<VtnexaConfigFile, String> {
    let raw = match read_bounded_text(path, MCP_CONFIG_MAX_BYTES, "mcp config") {
        Ok(s) => s,
        Err((std::io::ErrorKind::NotFound, _)) => return Ok(VtnexaConfigFile::default()),
        Err((_, error)) => return Err(error),
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

fn sorted_btree_map(values: Option<&HashMap<String, String>>) -> BTreeMap<String, String> {
    values
        .map(|items| {
            items
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn canonical_json_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for key in keys {
                sorted.insert(key.clone(), canonical_json_value(&map[key]));
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(canonical_json_value).collect())
        }
        other => other.clone(),
    }
}

pub(crate) fn canonical_json(value: &serde_json::Value) -> String {
    serde_json::to_string(&canonical_json_value(value)).unwrap_or_default()
}

pub(crate) fn config_fingerprint(cfg: &McpServerConfig) -> String {
    let value = serde_json::json!({
        "type": cfg.r#type,
        "command": cfg.command.clone().unwrap_or_default(),
        "url": cfg.url.clone().unwrap_or_default(),
        "headers": sorted_btree_map(cfg.headers.as_ref()),
        "environment": sorted_btree_map(cfg.environment.as_ref()),
        "cwd": cfg.cwd.clone().unwrap_or_default(),
        "timeout": cfg.timeout,
        "oauth": cfg.oauth.clone().unwrap_or(serde_json::Value::Null),
    });
    let digest = Sha256::digest(canonical_json(&value).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn config_fingerprint_for(root: &Path, cfg: &McpServerConfig) -> String {
    let base = config_fingerprint(cfg);
    let resolved = if cfg.r#type == "local" {
        let cwd = resolve_cwd(cfg, root).unwrap_or_else(|_| root.to_path_buf());
        cfg.command
            .as_deref()
            .and_then(|command| resolve_local_command(command, &cwd).ok())
            .and_then(|command| command.first().cloned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let digest = Sha256::digest(format!("{base}\0{resolved}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn mcp_approval_detail(server: &str, tool: &str, args: &serde_json::Value) -> String {
    canonical_json(&serde_json::json!({
        "server": server,
        "tool": tool,
        "args": args,
    }))
}

fn load_merged_mcp_entries_from_paths(
    global: Option<&Path>,
    project: &Path,
) -> Result<HashMap<String, McpServerEntry>, String> {
    let mut merged = HashMap::new();
    if let Some(path) = global {
        for (name, config) in parse_config_file(path)?.mcp {
            if valid_server_name(&name) {
                merged.insert(
                    name,
                    McpServerEntry {
                        config,
                        source: McpConfigSource::Global,
                    },
                );
            }
        }
    }
    for (name, config) in parse_config_file(project)?.mcp {
        if valid_server_name(&name) {
            merged.insert(
                name,
                McpServerEntry {
                    config,
                    source: McpConfigSource::Workspace,
                },
            );
        }
    }
    Ok(merged)
}

pub(crate) fn load_merged_mcp_entries(
    root: &Path,
) -> Result<HashMap<String, McpServerEntry>, String> {
    let project = checked_project_config_path(root)?;
    load_merged_mcp_entries_from_paths(global_config_path().as_deref(), &project)
}

pub(crate) fn load_merged_mcp_config(
    root: &Path,
) -> Result<HashMap<String, McpServerConfig>, String> {
    Ok(load_merged_mcp_entries(root)?
        .into_iter()
        .map(|(name, entry)| (name, entry.config))
        .collect())
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

fn command_path_is_absolute(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute()
        || value.starts_with('/')
        || value.starts_with("\\\\")
        || value.starts_with('\\')
        || (value.len() >= 3
            && value.as_bytes().get(1) == Some(&b':')
            && matches!(value.as_bytes().get(2), Some(b'/' | b'\\')))
}

fn path_is_same_or_below(path: &Path, root: &Path) -> bool {
    let path = path.components().collect::<Vec<_>>();
    let root = root.components().collect::<Vec<_>>();
    if path.len() < root.len() {
        return false;
    }
    path.iter()
        .zip(&root)
        .all(|(left, right)| left.as_os_str().eq_ignore_ascii_case(right.as_os_str()))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn controlled_path_from(raw: &std::ffi::OsStr, cwd: &Path) -> Result<Vec<PathBuf>, String> {
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut out = Vec::new();
    for directory in std::env::split_paths(raw) {
        if directory.as_os_str().is_empty() || !directory.is_absolute() {
            continue;
        }
        let directory = directory.canonicalize().unwrap_or(directory);
        if path_is_same_or_below(&directory, &cwd) {
            continue;
        }
        if !out.contains(&directory) {
            out.push(directory);
        }
    }
    if out.is_empty() {
        return Err("mcp: no safe executable directories are available in PATH".to_string());
    }
    Ok(out)
}

fn resolve_local_command_with_path(
    command: &[String],
    cwd: &Path,
    raw_path: &std::ffi::OsStr,
) -> Result<Vec<String>, String> {
    validate_local_command(command)?;
    let raw = command[0].trim();
    let mut resolved = command.to_vec();
    if command_path_is_absolute(raw) {
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err("mcp: absolute server command is not valid on this platform".to_string());
        }
        let canonical = path.canonicalize().map_err(|error| {
            format!(
                "mcp: server command '{}' cannot be resolved: {}",
                raw, error
            )
        })?;
        if !executable_file(&canonical) {
            return Err(format!(
                "mcp: server command '{}' is not an executable file",
                canonical.display()
            ));
        }
        resolved[0] = canonical.to_string_lossy().to_string();
        return Ok(resolved);
    }
    let directories = controlled_path_from(raw_path, cwd)?;
    let names = if cfg!(windows) {
        let mut names = vec![raw.to_string()];
        if !raw.to_ascii_lowercase().ends_with(".exe") {
            names.push(format!("{raw}.exe"));
        }
        names
    } else {
        vec![raw.to_string()]
    };
    for directory in directories {
        for name in &names {
            let candidate = directory.join(name);
            if !executable_file(&candidate) {
                continue;
            }
            let canonical = candidate.canonicalize().map_err(|error| {
                format!(
                    "mcp: server command '{}' cannot be resolved: {}",
                    name, error
                )
            })?;
            if path_is_same_or_below(&canonical, cwd) {
                continue;
            }
            resolved[0] = canonical.to_string_lossy().to_string();
            return Ok(resolved);
        }
    }
    Err(format!(
        "mcp: server command '{}' was not found in a safe PATH",
        raw
    ))
}

pub(crate) fn resolve_local_command(command: &[String], cwd: &Path) -> Result<Vec<String>, String> {
    let raw = std::env::var_os("PATH").ok_or_else(|| {
        "mcp: cannot resolve server command because PATH is unavailable".to_string()
    })?;
    resolve_local_command_with_path(command, cwd, &raw)
}

/// Local MCP servers spawn OS processes. A workspace-cloned repo can plant
/// `.vtnexa/vtnexa.json`, so the binary itself is allowlisted: known runtime
/// launchers only. `sh/bash/curl/wget` as the direct command is refused —
/// use npx/node/python entrypoints instead.
pub(crate) fn validate_local_command(command: &[String]) -> Result<(), String> {
    let first = command
        .first()
        .map(|s| s.trim())
        .unwrap_or_default()
        .to_string();
    if first.is_empty() {
        return Err("mcp: server command is empty".to_string());
    }
    if first.len() > 512 || first.contains('\0') {
        return Err("mcp: server command invalid".to_string());
    }
    let has_separator = first.contains('/') || first.contains('\\');
    let absolute = command_path_is_absolute(&first);
    if has_separator && !absolute {
        return Err(
            "mcp: relative executable paths are not allowed; use a bare command or an absolute path"
                .to_string(),
        );
    }
    let base = first
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&first)
        .to_lowercase();
    // Block shells / downloaders / privilege tools as the direct spawn.
    const BLOCKED: &[&str] = &[
        "sh",
        "bash",
        "zsh",
        "fish",
        "dash",
        "cmd",
        "cmd.exe",
        "powershell",
        "pwsh",
        "curl",
        "wget",
        "sudo",
        "doas",
        "su",
    ];
    if BLOCKED.contains(&base.as_str()) {
        return Err(format!(
            "mcp: server command '{}' is blocked (shells/downloaders cannot be MCP servers — use npx/node/python)",
            base
        ));
    }
    const ALLOWED: &[&str] = &[
        "npx", "node", "nodejs", "python", "python3", "uv", "uvx", "bun", "bunx", "deno", "go",
        "cargo", "java", "ruby", "dotnet",
    ];
    // NOTE: `cargo`/`go` run workspace code at startup (build.rs, go:generate)
    // — that is why workspace-only servers stay UNTRUSTED until the user
    // enables them in the ⛁ panel, and why every mcp_call_tool needs an
    // approval token. The allowlist keeps out shells/downloaders; the trust
    // signal + approval gate cover what the allowlist cannot.
    // Allow absolute paths whose basename is allowlisted, plus bare names above.
    // Anything else (e.g. /tmp/evil) is refused.
    if !ALLOWED.contains(&base.as_str()) {
        return Err(format!(
            "mcp: server command '{}' is not allowlisted (want one of: npx, node, python3, uvx, bunx, deno, go, ...)",
            base
        ));
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn workspace_only_servers(root: &Path) -> Vec<String> {
    load_merged_mcp_entries(root)
        .map(|entries| {
            entries
                .into_iter()
                .filter_map(|(name, entry)| {
                    (entry.source == McpConfigSource::Workspace).then_some(name)
                })
                .collect()
        })
        .unwrap_or_default()
}
pub(crate) fn subst_headers_for_server(
    headers: &HashMap<String, String>,
    workspace_controlled: bool,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (k, v) in headers {
        let value = if workspace_controlled {
            strip_env_placeholders(v)
        } else {
            subst_env_placeholders(v)
        };
        out.push((k.clone(), value));
    }
    out
}

fn strip_env_placeholders(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("{env:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 5..];
        match after.find('}') {
            Some(end) => {
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
    if !valid_server_name(server)
        || tool.is_empty()
        || tool.len() > 128
        || tool.chars().any(char::is_control)
    {
        return None;
    }
    let digest = Sha256::digest(format!("{server}\0{tool}").as_bytes());
    let suffix = digest
        .iter()
        .take(MCP_QUALIFIED_HASH_LEN)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let prefix = format!(
        "mcp_{}_{}",
        sanitize_fragment(server),
        sanitize_fragment(tool)
    );
    let max_prefix = MCP_QUALIFIED_MAX_LEN
        .checked_sub(suffix.len() + 1)
        .unwrap_or(1);
    let prefix = prefix.chars().take(max_prefix).collect::<String>();
    Some(format!("{}_{}", prefix.trim_end_matches('_'), suffix))
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
    let root_canon = root
        .canonicalize()
        .map_err(|error| format!("mcp: cannot canonicalize workspace: {}", error))?;
    if is_internal_path(&root_canon, &p) {
        return Err("mcp: cwd is an app-private path".to_string());
    }
    if let Ok(canon) = p.canonicalize() {
        ensure_within_root(&canon, &root_canon, "mcp: cwd")?;
        return Ok(canon);
    }
    ensure_within_root(&p, &root_canon, "mcp: cwd")?;
    Ok(root_canon)
}

/// Spawn `command`, feed `send_lines` (each + "\n"), collect stdout lines until
/// `expect_ids` are all seen, EOF, or timeout. Always reaps the child.
#[derive(Debug)]
struct StdioOutput {
    response: Option<serde_json::Value>,
    stderr: String,
    truncated: bool,
}

fn run_stdio_once(
    command: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    send_lines: &[String],
    expected_id: u64,
    timeout: Duration,
    clear_environment: bool,
) -> Result<StdioOutput, String> {
    if command.is_empty() || command[0].trim().is_empty() {
        return Err("mcp: server command is empty".to_string());
    }
    let command = resolve_local_command(command, cwd)?;
    let command = command.as_slice();
    let mut input = String::new();
    for line in send_lines {
        input.push_str(line);
        input.push('\n');
    }
    if input.len() > MCP_MAX_COMBINED_BYTES {
        return Err("mcp: stdin request exceeded limit".to_string());
    }
    let mut command_builder = std::process::Command::new(&command[0]);
    if command.len() > 1 {
        command_builder.args(&command[1..]);
    }
    command_builder.current_dir(cwd);
    if clear_environment {
        command_builder.env_clear();
    }
    for (key, value) in env {
        if key.is_empty() || key.contains('\0') || value.contains('\0') {
            continue;
        }
        command_builder.env(key, value);
    }
    let response = Arc::new(Mutex::new(None));
    let response_slot = response.clone();
    let line_count = Arc::new(AtomicUsize::new(0));
    let line_count_slot = line_count.clone();
    let observer: LineObserver = Arc::new(move |line| {
        let count = line_count_slot.fetch_add(1, Ordering::Relaxed) + 1;
        if count > MCP_MAX_LINES {
            return LineDecision::Fail(format!(
                "mcp: server sent more than {} lines",
                MCP_MAX_LINES
            ));
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            return LineDecision::Continue;
        };
        if value.get("id").and_then(|id| id.as_u64()) != Some(expected_id) {
            return LineDecision::Continue;
        }
        if let Ok(mut slot) = response_slot.lock() {
            *slot = Some(value);
        }
        LineDecision::Response
    });
    let limits = ProcessLimits::new(
        MCP_MAX_STDOUT_LINE_BYTES,
        MCP_MAX_STDERR_BYTES,
        MCP_MAX_COMBINED_BYTES,
    );
    let output = process::run_bounded(
        command_builder,
        ProcessOptions::new(timeout, limits)
            .with_max_stdout_line(MCP_MAX_STDOUT_LINE_BYTES)
            .with_max_stderr_line(MCP_MAX_STDERR_BYTES)
            .with_line_observer(observer)
            .with_initial_stdin(input.into_bytes()),
    )
    .map_err(|error| match error {
        process::ProcessError::Timeout(_) => {
            format!("mcp: server timed out after {}ms", timeout.as_millis())
        }
        process::ProcessError::LineTooLong(limit) => {
            format!("mcp: stdout line exceeded {} bytes", limit)
        }
        other => format!("mcp: stdio process failed: {}", other),
    })?;
    let response = response
        .lock()
        .map_err(|_| "mcp: response lock failed".to_string())?
        .clone();
    Ok(StdioOutput {
        response,
        stderr: output.stderr().to_string(),
        truncated: output.stdout_truncated() || output.stderr_truncated(),
    })
}

async fn run_stdio_blocking(
    command: Vec<String>,
    cwd: PathBuf,
    env: HashMap<String, String>,
    send: Vec<String>,
    expected_id: u64,
    timeout: Duration,
    clear_environment: bool,
) -> Result<StdioOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_stdio_once(
            &command,
            &cwd,
            &env,
            &send,
            expected_id,
            timeout,
            clear_environment,
        )
    })
    .await
    .map_err(|error| format!("mcp: stdio worker failed: {}", error))?
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

/// Reject anything but http(s). Returns the canonical URL.
pub(crate) fn validate_remote_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
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
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| format!("mcp: remote url is invalid ({})", error))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("mcp: remote url must include an HTTP(S) host".to_string());
    }
    Ok(parsed.into())
}

/// scheme://host for errors — query strings may carry secrets.
pub(crate) fn url_host_display(url: &str) -> String {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    let host = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
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

pub(crate) async fn read_bounded_response_until<F>(
    mut response: reqwest::Response,
    label: &str,
    mut ready: F,
) -> Result<Vec<u8>, String>
where
    F: FnMut(&[u8]) -> bool,
{
    if let Some(length) = response.content_length() {
        if length > MCP_MAX_HTTP_BODY_BYTES as u64 {
            return Err(format!(
                "{} response Content-Length exceeds {} bytes",
                label, MCP_MAX_HTTP_BODY_BYTES
            ));
        }
    }
    let mut body = Vec::with_capacity(MCP_MAX_HTTP_BODY_BYTES);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("{} response read failed: {}", label, error))?
    {
        if body.len().saturating_add(chunk.len()) > MCP_MAX_HTTP_BODY_BYTES {
            return Err(format!(
                "{} response exceeded {} bytes",
                label, MCP_MAX_HTTP_BODY_BYTES
            ));
        }
        body.extend_from_slice(&chunk);
        if ready(&body) {
            return Ok(body);
        }
    }
    Ok(body)
}

pub(crate) async fn read_bounded_response_body(
    response: reqwest::Response,
    label: &str,
) -> Result<Vec<u8>, String> {
    read_bounded_response_until(response, label, |_| false).await
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

#[allow(dead_code)]
pub(crate) fn is_workspace_controlled(root: &Path, name: &str) -> bool {
    load_merged_mcp_entries(root)
        .map(|entries| {
            entries
                .get(name)
                .map(|entry| entry.source == McpConfigSource::Workspace)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

#[allow(dead_code)]
pub(crate) fn is_untrusted_server(root: &Path, name: &str) -> bool {
    is_workspace_controlled(root, name)
}

async fn remote_session(
    name: &str,
    cfg: &McpServerConfig,
    force_refresh: bool,
    workspace_controlled: bool,
    trusted: bool,
) -> Result<RemoteSession, String> {
    let url = validate_remote_url(cfg.url.as_deref().unwrap_or(""))?;
    if workspace_controlled && !trusted && crate::browser::navigation_host_blocked(&url) {
        return Err(format!(
            "mcp: workspace server '{}' needs native trust before connecting to {}",
            name,
            url_host_display(&url)
        ));
    }
    let host_display = url_host_display(&url);
    let mut headers = Vec::new();
    for (k, v) in subst_headers_for_server(
        &cfg.headers.clone().unwrap_or_default(),
        workspace_controlled,
    ) {
        if k.trim().is_empty() || k.len() > 256 {
            return Err(format!("mcp: server '{}' has an invalid header name", name));
        }
        if v.len() > 8192 {
            return Err(format!("mcp: server '{}' header value too long", name));
        }
        headers.push((k, v));
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
        .redirect(reqwest::redirect::Policy::none())
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
            if e.is_redirect() {
                format!(
                    "mcp: {} returned a redirect; redirects are disabled",
                    self.host_display
                )
            } else if e.is_timeout() {
                format!("mcp: {} timed out", self.host_display)
            } else if e.is_connect() {
                format!("mcp: cannot reach {} ({})", self.host_display, e)
            } else {
                format!("mcp: {} request failed: {}", self.host_display, e)
            }
        })?;
        if res.status().is_redirection() {
            return Err(format!(
                "mcp: {} returned HTTP {}; redirects are disabled",
                self.host_display,
                res.status()
            ));
        }
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
            let body = read_bounded_response_until(
                res,
                &format!("{} response", self.host_display),
                |bytes| {
                    let text = String::from_utf8_lossy(bytes);
                    find_response(&extract_sse_data(&text), id).is_some()
                },
            )
            .await?;
            let text = String::from_utf8_lossy(&body);
            return find_response(&extract_sse_data(&text), id)
                .map(Some)
                .ok_or_else(|| {
                    format!(
                        "mcp: {} gave no JSON-RPC response (id {})",
                        self.host_display, id
                    )
                });
        }
        let body =
            read_bounded_response_until(res, &format!("{} response", self.host_display), |bytes| {
                serde_json::from_slice::<serde_json::Value>(bytes)
                    .ok()
                    .and_then(|value| value.get("id").and_then(|value| value.as_u64()))
                    == Some(id)
            })
            .await?;
        if body.iter().all(u8::is_ascii_whitespace) {
            return Err(format!(
                "mcp: {} returned an empty body for id {}",
                self.host_display, id
            ));
        }
        let v: serde_json::Value = serde_json::from_slice(&body)
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

async fn remote_list_tools(
    name: &str,
    cfg: &McpServerConfig,
    workspace_controlled: bool,
    trusted: bool,
) -> Result<Vec<McpToolInfo>, String> {
    retry_remote(name, cfg, |force| {
        remote_list_tools_once(name, cfg, force, workspace_controlled, trusted)
    })
    .await
}

async fn remote_list_tools_once(
    name: &str,
    cfg: &McpServerConfig,
    force_refresh: bool,
    workspace_controlled: bool,
    trusted: bool,
) -> Result<Vec<McpToolInfo>, String> {
    let mut sess = remote_session(name, cfg, force_refresh, workspace_controlled, trusted).await?;
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
    workspace_controlled: bool,
    trusted: bool,
) -> Result<String, String> {
    if tool.is_empty() || tool.len() > 128 {
        return Err("mcp: invalid tool name".to_string());
    }
    let arg_str = serde_json::to_string(&args).unwrap_or_default();
    if arg_str.len() > MCP_MAX_ARGS_BYTES {
        return Err("mcp: args too large (64KB max)".to_string());
    }
    let other = retry_remote(server, cfg, |force| {
        remote_call_tool_once(
            server,
            cfg,
            tool,
            args.clone(),
            force,
            workspace_controlled,
            trusted,
        )
    })
    .await;
    other
}

async fn remote_call_tool_once(
    server: &str,
    cfg: &McpServerConfig,
    tool: &str,
    args: serde_json::Value,
    force_refresh: bool,
    workspace_controlled: bool,
    trusted: bool,
) -> Result<String, String> {
    let mut sess =
        remote_session(server, cfg, force_refresh, workspace_controlled, trusted).await?;
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
    let mut qualified_names = HashSet::new();
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
        if !qualified_names.insert(q.clone()) {
            return Err(format!(
                "mcp: server '{}' returned duplicate qualified tool name '{}'",
                name, q
            ));
        }
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

pub(crate) async fn list_tools_for_server_checked(
    name: &str,
    cfg: &McpServerConfig,
    root: &Path,
    workspace_controlled: bool,
    trusted: bool,
) -> Result<Vec<McpToolInfo>, String> {
    if !valid_server_name(name) {
        return Err("mcp: invalid server name".to_string());
    }
    if !cfg.enabled {
        return Err(format!("mcp: server '{}' is disabled", name));
    }
    if workspace_controlled && !trusted {
        return Err(format!(
            "mcp: server '{}' requires native trust consent before discovery",
            name
        ));
    }
    if cfg.r#type == "remote" {
        return remote_list_tools(name, cfg, workspace_controlled, trusted).await;
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
    validate_local_command(&command)?;
    let cwd = resolve_cwd(cfg, root)?;
    let env = cfg.environment.clone().unwrap_or_default();
    let timeout = Duration::from_millis(clamp_timeout(cfg.timeout));
    let mut send = handshake_lines();
    send.push(jsonrpc_request(
        "tools/list",
        Some(2),
        serde_json::json!({}),
    ));
    let output =
        run_stdio_blocking(command, cwd, env, send, 2, timeout, workspace_controlled).await?;
    let truncated = if output.truncated {
        " (output truncated)"
    } else {
        ""
    };
    let resp = output.response.ok_or_else(|| {
        if output.stderr.trim().is_empty() {
            format!(
                "mcp: server '{}' gave no tools/list response (timeout {}ms){}",
                name,
                timeout.as_millis(),
                truncated
            )
        } else {
            format!(
                "mcp: server '{}' failed: {}{}",
                name,
                output.stderr.trim(),
                truncated
            )
        }
    })?;
    if let Some(err) = rpc_error_to_string(&resp) {
        return Err(err);
    }
    tools_from_list_response(name, &resp)
}

#[allow(dead_code)]
pub(crate) async fn list_tools_for_server(
    name: &str,
    cfg: &McpServerConfig,
    root: &Path,
) -> Result<Vec<McpToolInfo>, String> {
    let workspace_controlled = is_workspace_controlled(root, name);
    list_tools_for_server_checked(name, cfg, root, workspace_controlled, !workspace_controlled)
        .await
}

pub(crate) async fn call_tool_for_server_checked(
    server: &str,
    cfg: &McpServerConfig,
    root: &Path,
    tool: &str,
    args: serde_json::Value,
    workspace_controlled: bool,
    trusted: bool,
) -> Result<String, String> {
    if !valid_server_name(server) {
        return Err("mcp: invalid server name".to_string());
    }
    if !cfg.enabled {
        return Err(format!("mcp: server '{}' is disabled", server));
    }
    if workspace_controlled && !trusted {
        return Err(format!(
            "mcp: server '{}' requires native trust consent before tool calls",
            server
        ));
    }
    if cfg.r#type == "remote" {
        return remote_call_tool(server, cfg, tool, args, workspace_controlled, trusted).await;
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
    validate_local_command(&command)?;
    let cwd = resolve_cwd(cfg, root)?;
    let env = cfg.environment.clone().unwrap_or_default();
    let timeout = Duration::from_millis(clamp_timeout(cfg.timeout));
    let mut send = handshake_lines();
    send.push(jsonrpc_request(
        "tools/call",
        Some(2),
        serde_json::json!({"name": tool, "arguments": args}),
    ));
    let output =
        run_stdio_blocking(command, cwd, env, send, 2, timeout, workspace_controlled).await?;
    let truncated = if output.truncated {
        " (output truncated)"
    } else {
        ""
    };
    let resp = output.response.ok_or_else(|| {
        if output.stderr.trim().is_empty() {
            format!(
                "mcp: server '{}' gave no tools/call response (timeout {}ms){}",
                server,
                timeout.as_millis(),
                truncated
            )
        } else {
            format!(
                "mcp: server '{}' failed: {}{}",
                server,
                output.stderr.trim(),
                truncated
            )
        }
    })?;
    if let Some(err) = rpc_error_to_string(&resp) {
        return Err(err);
    }
    let result = resp
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let text = flatten_tool_result(&result);
    Ok(truncate_output(text))
}

#[allow(dead_code)]
pub(crate) async fn call_tool_for_server(
    server: &str,
    cfg: &McpServerConfig,
    root: &Path,
    tool: &str,
    args: serde_json::Value,
) -> Result<String, String> {
    let workspace_controlled = is_workspace_controlled(root, server);
    call_tool_for_server_checked(
        server,
        cfg,
        root,
        tool,
        args,
        workspace_controlled,
        !workspace_controlled,
    )
    .await
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

#[allow(dead_code)]
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

fn entry_workspace_controlled(entry: &McpServerEntry) -> bool {
    entry.source == McpConfigSource::Workspace
}

fn entry_trust_status(
    trust: &McpTrustStore,
    root: &Path,
    name: &str,
    entry: &McpServerEntry,
) -> Result<(String, bool), String> {
    let fingerprint = config_fingerprint_for(root, &entry.config);
    let workspace_controlled = entry_workspace_controlled(entry);
    let trusted = if workspace_controlled {
        trust.observe(root, name, &fingerprint, true, entry.config.enabled)?
    } else {
        trust.observe(root, name, &fingerprint, false, true)?;
        true
    };
    Ok((fingerprint, trusted))
}

fn server_status(
    trust: &McpTrustStore,
    root: &Path,
    name: &str,
    entry: &McpServerEntry,
) -> Result<McpServerStatus, String> {
    let (fingerprint, trusted) = entry_trust_status(trust, root, name, entry)?;
    let workspace_controlled = entry_workspace_controlled(entry);
    Ok(McpServerStatus {
        name: name.to_string(),
        kind: entry.config.r#type.clone(),
        enabled: entry.config.enabled && trusted,
        configured: true,
        configured_enabled: entry.config.enabled,
        trusted,
        consent_required: workspace_controlled && !trusted,
        workspace_controlled,
        fingerprint,
        untrusted: !trusted,
    })
}

fn sync_trust_store(
    trust: &McpTrustStore,
    root: &Path,
    entries: &HashMap<String, McpServerEntry>,
) -> Result<(), String> {
    let workspace_names: HashSet<String> = entries
        .iter()
        .filter_map(|(name, entry)| entry_workspace_controlled(entry).then_some(name.clone()))
        .collect();
    let global_names: HashSet<String> = entries
        .iter()
        .filter_map(|(name, entry)| (!entry_workspace_controlled(entry)).then_some(name.clone()))
        .collect();
    trust.sync(root, &workspace_names, &global_names)
}

fn check_entry_usable<'a>(
    trust: &McpTrustStore,
    root: &Path,
    name: &str,
    entry: &'a McpServerEntry,
) -> Result<(&'a McpServerConfig, bool), String> {
    let workspace_controlled = entry_workspace_controlled(entry);
    let (_, trusted) = entry_trust_status(trust, root, name, entry)?;
    if !entry.config.enabled {
        return Err(format!("mcp: server '{}' is disabled", name));
    }
    if workspace_controlled && !trusted {
        return Err(format!(
            "mcp: server '{}' requires native trust consent",
            name
        ));
    }
    Ok((&entry.config, workspace_controlled))
}

fn sanitize_consent_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| {
            if ch.is_control() {
                ch.to_string().escape_default().collect::<Vec<_>>()
            } else {
                vec![ch]
            }
        })
        .collect()
}

fn consent_names(values: Option<&HashMap<String, String>>) -> String {
    let mut names: Vec<String> = values
        .map(|items| items.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    let names: Vec<String> = names
        .into_iter()
        .map(|name| sanitize_consent_text(&name))
        .collect();
    if names.is_empty() {
        "none".to_string()
    } else {
        names.join(", ")
    }
}

fn consent_command(root: &Path, cfg: &McpServerConfig) -> String {
    let Some(command) = cfg.command.as_deref() else {
        return String::new();
    };
    let cwd = resolve_cwd(cfg, root).unwrap_or_else(|_| root.to_path_buf());
    match resolve_local_command(command, &cwd) {
        Ok(resolved) => resolved.first().cloned().unwrap_or_default(),
        Err(error) => format!("unresolved ({error})"),
    }
}

pub(crate) fn mcp_consent_text(
    root: &Path,
    name: &str,
    cfg: &McpServerConfig,
    fingerprint: &str,
) -> String {
    let mut lines = vec![
        format!("Trust workspace MCP server '{}'?", name),
        format!("Workspace: {}", canonical_workspace_key(root)),
        "Source: workspace configuration".to_string(),
        format!("Type: {}", sanitize_consent_text(&cfg.r#type)),
    ];
    if cfg.r#type == "remote" {
        lines.push(format!(
            "Remote host: {}",
            cfg.url
                .as_deref()
                .map(url_host_display)
                .unwrap_or_else(|| "not configured".to_string())
        ));
    } else {
        let command = cfg
            .command
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .enumerate()
            .map(|(index, arg)| {
                if index == 0 {
                    consent_command(root, cfg)
                } else {
                    sanitize_consent_text(arg)
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!(
            "Local command: {}",
            if command.is_empty() {
                "not configured".to_string()
            } else {
                command
            }
        ));
    }
    lines.push(format!(
        "Working directory: {}",
        cfg.cwd
            .as_deref()
            .map(sanitize_consent_text)
            .unwrap_or_else(|| "workspace root".to_string())
    ));
    lines.push(format!("Timeout: {}ms", cfg.timeout));
    lines.push(format!(
        "Configured enabled: {}",
        if cfg.enabled { "yes" } else { "no" }
    ));
    lines.push(format!(
        "Environment keys: {}",
        consent_names(cfg.environment.as_ref())
    ));
    lines.push(format!(
        "Header names: {}",
        consent_names(cfg.headers.as_ref())
    ));
    lines.push(format!(
        "OAuth: {}",
        if cfg.oauth.is_some() {
            "configured"
        } else {
            "automatic"
        }
    ));
    lines.push(format!("Configuration fingerprint: {}", fingerprint));
    lines.push("Only approve if you inspected the full command or remote host.".to_string());
    lines.join("\n")
}

async fn native_mcp_consent<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    text: String,
) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    window
        .dialog()
        .message(text)
        .title("VTNexa — trust workspace MCP server?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Trust & enable".to_string(),
            "Reject".to_string(),
        ))
        .kind(MessageDialogKind::Warning)
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
        .await
        .map_err(|e| format!("mcp trust dialog failed: {}", e))
}

pub(crate) fn grant_mcp_trust_after_confirmation(
    trust: &McpTrustStore,
    root: &Path,
    name: &str,
    fingerprint: &str,
    confirmed: bool,
) -> Result<(), String> {
    if !confirmed {
        return Err(format!(
            "mcp: native trust consent rejected for server '{}'",
            name
        ));
    }
    trust.grant(root, name, fingerprint)
}

#[tauri::command]
pub(crate) fn mcp_list_servers<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    trust: tauri::State<'_, McpTrustStore>,
) -> Result<Vec<McpServerStatus>, String> {
    let root = crate::root_snapshot(&state, window.label());
    let entries = load_merged_mcp_entries(&root)?;
    sync_trust_store(&trust, &root, &entries)?;
    let mut out = Vec::with_capacity(entries.len());
    for (name, entry) in entries {
        out.push(server_status(&trust, &root, &name, &entry)?);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub(crate) fn mcp_workspace_trust<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    trust: tauri::State<'_, McpTrustStore>,
) -> Result<serde_json::Value, String> {
    let root = crate::root_snapshot(&state, window.label());
    let entries = load_merged_mcp_entries(&root)?;
    sync_trust_store(&trust, &root, &entries)?;
    let mut list = Vec::new();
    for (name, entry) in entries {
        if entry_workspace_controlled(&entry) {
            let _ = server_status(&trust, &root, &name, &entry)?;
            list.push(name);
        }
    }
    Ok(serde_json::json!({ "workspace_servers": list }))
}

#[tauri::command]
pub(crate) async fn mcp_list_tools<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    trust: tauri::State<'_, McpTrustStore>,
) -> Result<Vec<McpToolInfo>, String> {
    let root = crate::root_snapshot(&state, window.label());
    let entries = load_merged_mcp_entries(&root)?;
    sync_trust_store(&trust, &root, &entries)?;
    let mut names: Vec<String> = entries.keys().cloned().collect();
    names.sort();
    let mut out = Vec::new();
    let mut qualified_names = HashSet::new();
    for name in names {
        let current_entries = load_merged_mcp_entries(&root)?;
        sync_trust_store(&trust, &root, &current_entries)?;
        let entry = match current_entries.get(&name) {
            Some(entry) => entry,
            None => continue,
        };
        let (cfg, workspace_controlled) = match check_entry_usable(&trust, &root, &name, entry) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let trusted = if workspace_controlled {
            entry_trust_status(&trust, &root, &name, entry)?.1
        } else {
            true
        };
        match list_tools_for_server_checked(&name, cfg, &root, workspace_controlled, trusted).await
        {
            Ok(mut tools) => {
                for tool in &tools {
                    if !qualified_names.insert(tool.qualified_name.clone()) {
                        return Err(format!(
                            "mcp: duplicate qualified tool name '{}'",
                            tool.qualified_name
                        ));
                    }
                }
                out.append(&mut tools);
            }
            Err(e) => {
                let qualified_name = qualified_tool_name(&name, "__error__").ok_or_else(|| {
                    format!(
                        "mcp: could not create an error tool identity for '{}'",
                        name
                    )
                })?;
                if !qualified_names.insert(qualified_name.clone()) {
                    return Err(format!(
                        "mcp: duplicate qualified tool name '{}'",
                        qualified_name
                    ));
                }
                out.push(McpToolInfo {
                    server: name.clone(),
                    name: "__error__".to_string(),
                    qualified_name,
                    description: e.chars().take(300).collect(),
                    input_schema: serde_json::json!({}),
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn mcp_call_tool<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    rate_limiter: tauri::State<'_, crate::rate_limiter::RateLimiter>,
    trust: tauri::State<'_, McpTrustStore>,
    server: String,
    tool: String,
    args: serde_json::Value,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<String, String> {
    if !valid_server_name(&server) {
        return Err("mcp: invalid server name".to_string());
    }
    if tool.is_empty() || tool.len() > 128 {
        return Err("mcp: invalid tool name".to_string());
    }
    let root = crate::root_snapshot(&state, window.label());
    let entries = load_merged_mcp_entries(&root)?;
    let entry = entries
        .get(&server)
        .ok_or_else(|| format!("mcp: unknown server '{}'", server))?;
    sync_trust_store(&trust, &root, &entries)?;
    let _ = check_entry_usable(&trust, &root, &server, entry)?;
    let arg_size = serde_json::to_string(&args).unwrap_or_default().len();
    if arg_size > MCP_MAX_ARGS_BYTES {
        return Err("mcp: args too large (64KB max)".to_string());
    }
    let expected_detail = mcp_approval_detail(&server, &tool, &args);
    if expected_detail.len() > 20_000 {
        return Err("mcp: approval detail too large".to_string());
    }
    if approval_detail.as_deref() != Some(expected_detail.as_str()) {
        return Err("mcp: approval detail does not match server, tool, and arguments".to_string());
    }
    rate_limiter.check_turn(window.label())?;
    crate::approvals::approval_consume(
        &approvals,
        window.label(),
        "mcp_call_tool",
        &Some(expected_detail),
        &approval_token,
    )?;
    let current_entries = load_merged_mcp_entries(&root)?;
    sync_trust_store(&trust, &root, &current_entries)?;
    let current_entry = current_entries
        .get(&server)
        .ok_or_else(|| format!("mcp: unknown server '{}'", server))?;
    let (current_cfg, current_workspace_controlled) =
        check_entry_usable(&trust, &root, &server, current_entry)?;
    let current_trusted = if current_workspace_controlled {
        entry_trust_status(&trust, &root, &server, current_entry)?.1
    } else {
        true
    };
    call_tool_for_server_checked(
        &server,
        current_cfg,
        &root,
        &tool,
        args,
        current_workspace_controlled,
        current_trusted,
    )
    .await
}

#[tauri::command]
pub(crate) fn mcp_config_get<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    trust: tauri::State<'_, McpTrustStore>,
) -> Result<serde_json::Value, String> {
    let root = crate::root_snapshot(&state, window.label());
    let entries = load_merged_mcp_entries(&root)?;
    sync_trust_store(&trust, &root, &entries)?;
    let mut servers = serde_json::Map::new();
    for (name, entry) in &entries {
        let mut status = serde_json::to_value(server_status(&trust, &root, name, entry)?)
            .unwrap_or(serde_json::Value::Null);
        if let Some(object) = status.as_object_mut() {
            object.insert("type".to_string(), serde_json::json!(entry.config.r#type));
            object.insert(
                "enabled".to_string(),
                serde_json::json!(entry.config.enabled),
            );
        }
        servers.insert(name.clone(), status);
    }
    Ok(serde_json::json!({"servers": servers}))
}

fn raw_server_entry_exists(raw: &str, server: &str) -> Result<bool, String> {
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let doc: serde_json::Value = serde_json::from_str(&strip_json_comments(raw))
        .map_err(|e| format!("mcp config: invalid JSON: {}", e))?;
    Ok(doc
        .get("mcp")
        .and_then(|mcp| mcp.get(server))
        .map(|entry| entry.is_object())
        .unwrap_or(false))
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
pub(crate) async fn mcp_set_server_enabled<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    trust: tauri::State<'_, McpTrustStore>,
    server: String,
    enabled: bool,
) -> Result<(), String> {
    if !valid_server_name(&server) {
        return Err("mcp: invalid server name".to_string());
    }
    let root = crate::root_snapshot(&state, window.label());
    let entries = load_merged_mcp_entries(&root)?;
    sync_trust_store(&trust, &root, &entries)?;
    let entry = entries
        .get(&server)
        .ok_or_else(|| format!("mcp: unknown server '{}'", server))?;
    if !entry_workspace_controlled(entry) {
        if entry.config.enabled == enabled {
            return Ok(());
        }
        return Err(format!(
            "mcp: server '{}' is global-only; edit the global config instead of creating a workspace shadow",
            server
        ));
    }
    let fingerprint = if enabled {
        if entry.config.r#type == "local" {
            let cwd = resolve_cwd(&entry.config, &root)?;
            resolve_local_command(entry.config.command.as_deref().unwrap_or(&[]), &cwd)?;
        }
        config_fingerprint_for(&root, &entry.config)
    } else {
        config_fingerprint(&entry.config)
    };
    if enabled {
        let trusted = trust.observe(&root, &server, &fingerprint, true, entry.config.enabled)?;
        if !trusted {
            let text = mcp_consent_text(&root, &server, &entry.config, &fingerprint);
            let confirmed = native_mcp_consent(&window, text).await?;
            if !confirmed {
                return Err(format!(
                    "mcp: native trust consent rejected for server '{}'",
                    server
                ));
            }
        }
    }
    let latest = load_merged_mcp_entries(&root)?;
    let latest_entry = latest
        .get(&server)
        .ok_or_else(|| format!("mcp: unknown server '{}' while enabling", server))?;
    let latest_fingerprint = if enabled {
        config_fingerprint_for(&root, &latest_entry.config)
    } else {
        config_fingerprint(&latest_entry.config)
    };
    if !entry_workspace_controlled(latest_entry) || latest_fingerprint != fingerprint {
        return Err(format!(
            "mcp: server '{}' configuration changed; review it again before trusting",
            server
        ));
    }
    create_internal_directory(&root, Path::new(".vtnexa"), "mcp config")?;
    let relative = Path::new(".vtnexa/vtnexa.json");
    checked_internal_path(&root, relative, "mcp config")?;
    let path = checked_internal_path(&root, relative, "mcp config")?;
    let raw = match read_bounded_text(&path, MCP_CONFIG_MAX_BYTES, "mcp config") {
        Ok(value) => value,
        Err((std::io::ErrorKind::NotFound, _)) => {
            return Err(format!(
                "mcp: workspace server '{}' was removed before its setting could be saved",
                server
            ));
        }
        Err((_, error)) => return Err(error),
    };
    if !raw_server_entry_exists(&raw, &server)? {
        return Err(format!(
            "mcp: workspace server '{}' was removed before its setting could be saved",
            server
        ));
    }
    let next = apply_enabled_patch(&raw, &server, enabled)?;
    let path = checked_internal_path(&root, relative, "mcp config")?;
    crate::write_atomic(&path, next.as_bytes())?;
    checked_internal_path(&root, relative, "mcp config")?;
    if enabled {
        let refreshed = load_merged_mcp_entries(&root)?;
        if let Some(current) = refreshed.get(&server) {
            let current_fingerprint = if enabled {
                config_fingerprint_for(&root, &current.config)
            } else {
                config_fingerprint(&current.config)
            };
            if !entry_workspace_controlled(current) || current_fingerprint != fingerprint {
                trust.revoke(&root, &server)?;
                return Err(format!(
                    "mcp: server '{}' configuration changed while enabling; trust was not granted",
                    server
                ));
            }
            grant_mcp_trust_after_confirmation(&trust, &root, &server, &current_fingerprint, true)?;
        } else {
            trust.revoke(&root, &server)?;
            return Err(format!(
                "mcp: server '{}' was removed while enabling; trust was not granted",
                server
            ));
        }
    } else {
        trust.revoke(&root, &server)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn global_config_path_uses_windows_roaming_data() {
        let get = |name: &str| match name {
            "APPDATA" => Some(PathBuf::from("C:/Users/test/AppData/Roaming")),
            "USERPROFILE" => Some(PathBuf::from("C:/Users/test")),
            "HOME" => Some(PathBuf::from("C:/wrong/home")),
            _ => None,
        };
        assert_eq!(
            global_config_path_for("windows", get),
            Some(
                PathBuf::from("C:/Users/test/AppData/Roaming")
                    .join("VTNexa")
                    .join("vtnexa.json")
            )
        );
    }

    #[test]
    fn global_config_path_does_not_use_home_on_windows() {
        let get = |name: &str| match name {
            "HOME" => Some(PathBuf::from("C:/wrong/home")),
            _ => None,
        };
        assert_eq!(global_config_path_for("windows", get), None);
        let get = |name: &str| match name {
            "USERPROFILE" => Some(PathBuf::from("C:/Users/test")),
            _ => None,
        };
        assert_eq!(
            global_config_path_for("windows", get),
            Some(
                PathBuf::from("C:/Users/test")
                    .join("AppData")
                    .join("Roaming")
                    .join("VTNexa")
                    .join("vtnexa.json")
            )
        );
    }

    #[test]
    fn global_config_path_is_xdg_aware_on_unix() {
        let get = |name: &str| match name {
            "XDG_CONFIG_HOME" => Some(PathBuf::from("/xdg/config")),
            "HOME" => Some(PathBuf::from("/home/test")),
            _ => None,
        };
        assert_eq!(
            global_config_path_for("linux", get),
            Some(PathBuf::from("/xdg/config/vtnexa/vtnexa.json"))
        );
        let get = |name: &str| match name {
            "HOME" => Some(PathBuf::from("/home/test")),
            _ => None,
        };
        assert_eq!(
            global_config_path_for("macos", get),
            Some(PathBuf::from("/home/test/.config/vtnexa/vtnexa.json"))
        );
    }

    #[test]
    fn workspace_config_path_remains_vtnexa_local() {
        assert_eq!(
            project_config_path(Path::new("/workspace")),
            PathBuf::from("/workspace/.vtnexa/vtnexa.json")
        );
    }

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
    fn local_commands_are_allowlisted() {
        for good in [
            vec!["npx".to_string(), "-y".to_string(), "s".to_string()],
            vec!["node".to_string(), "server.js".to_string()],
            vec!["python3".to_string(), "-m".to_string(), "s".to_string()],
            vec!["/usr/bin/uvx".to_string(), "s".to_string()],
        ] {
            assert!(
                validate_local_command(&good).is_ok(),
                "should allow {:?}",
                good
            );
        }
        for bad in [
            vec!["sh".to_string(), "-c".to_string(), "evil".to_string()],
            vec!["bash".to_string()],
            vec!["curl".to_string(), "https://evil".to_string()],
            vec!["/tmp/evil".to_string()],
            vec!["sudo".to_string(), "npx".to_string()],
            vec![],
        ] {
            assert!(
                validate_local_command(&bad).is_err(),
                "should block {:?}",
                bad
            );
        }
    }

    #[test]
    fn local_command_validation_rejects_relative_executables() {
        assert!(validate_local_command(&["./node".to_string(), "server.js".to_string()]).is_err());
        assert!(validate_local_command(&["sub\\node.exe".to_string()]).is_err());
        assert!(validate_local_command(&["/usr/bin/node".to_string()]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn local_command_resolution_ignores_workspace_path_shadowing() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture_root("command-shadow");
        let safe = fixture_root("command-safe");
        let shadow = root.join("node");
        let real = safe.join("node");
        std::fs::write(&shadow, b"shadow").unwrap();
        std::fs::write(&real, b"real").unwrap();
        std::fs::set_permissions(&shadow, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", root.display(), safe.display());
        let resolved = resolve_local_command_with_path(
            &["node".to_string()],
            &root,
            std::ffi::OsStr::new(&path),
        )
        .unwrap();
        assert!(resolve_local_command_with_path(
            &["node".to_string()],
            &root,
            std::ffi::OsStr::new("")
        )
        .is_err());
        assert_eq!(resolved[0], real.canonicalize().unwrap().to_string_lossy());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(safe);
    }

    #[test]
    fn untrusted_headers_lose_env_placeholders() {
        use std::collections::HashMap;
        std::env::set_var("VTNEXA_TEST_UNTRUSTED", "s3cret");
        let mut h = HashMap::new();
        h.insert(
            "Authorization".to_string(),
            "Bearer {env:VTNEXA_TEST_UNTRUSTED}".to_string(),
        );
        let trusted = subst_headers_for_server(&h, false);
        assert!(trusted[0].1.contains("s3cret"), "trusted keeps env");
        let untrusted = subst_headers_for_server(&h, true);
        assert!(!untrusted[0].1.contains("s3cret"), "untrusted strips env");
        assert_eq!(untrusted[0].1, "Bearer ");
        std::env::remove_var("VTNEXA_TEST_UNTRUSTED");
    }

    #[test]
    fn qualified_names_are_sanitized_and_bound_to_exact_identity() {
        let first = qualified_tool_name("sentry", "list_issues").unwrap();
        let second = qualified_tool_name("sentry", "list_issues").unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("mcp_sentry_list_issues_"));
        assert!(first.len() <= MCP_QUALIFIED_MAX_LEN);
        assert_ne!(
            first,
            qualified_tool_name("sentry", "list_issues2").unwrap()
        );
        assert_ne!(first, qualified_tool_name("other", "list_issues").unwrap());
        let lossy = qualified_tool_name("my-mcp", "get.Issue!").unwrap();
        assert!(lossy.starts_with("mcp_my_mcp_get_issue_"));
        assert!(qualified_tool_name("bad name!", "x").is_none());
        assert!(qualified_tool_name("ok", "").is_none());
    }

    #[test]
    fn duplicate_qualified_tools_are_rejected() {
        let response = serde_json::json!({
            "result": {
                "tools": [
                    {"name": "same"},
                    {"name": "same"}
                ]
            }
        });
        let error = tools_from_list_response("srv", &response).unwrap_err();
        assert!(error.contains("duplicate qualified tool name"));
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
    fn oversized_project_config_is_rejected_before_json_parsing() {
        let root = fixture_root("oversized-config");
        let project = root.join(".vtnexa/vtnexa.json");
        std::fs::write(
            &project,
            br#"{"mcp":{"s":{"type":"remote","url":"https://mcp.example.test"}}"#,
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&project)
            .unwrap()
            .set_len((MCP_CONFIG_MAX_BYTES + 1) as u64)
            .unwrap();
        let error = load_merged_mcp_entries_from_paths(None, &project).unwrap_err();
        assert!(error.contains("file too large"), "got: {}", error);
        let _ = std::fs::remove_dir_all(root);
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
    fn untrusted_remote_hosts_hit_ssrf_guard() {
        // Same classifier as the browser gate: loopback / private / IMDS are
        // blocked for workspace-planted servers, open internet is allowed.
        assert!(crate::browser::navigation_host_blocked(
            "http://127.0.0.1:3000/mcp"
        ));
        assert!(crate::browser::navigation_host_blocked(
            "http://169.254.169.254/latest/meta-data/"
        ));
        assert!(crate::browser::navigation_host_blocked(
            "http://192.168.1.10/mcp"
        ));
        assert!(!crate::browser::navigation_host_blocked(
            "https://mcp.example.com/mcp"
        ));
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
        assert_eq!(
            url_host_display("https://user:password@example.test/mcp"),
            "https://example.test"
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

    fn fixture_root(label: &str) -> PathBuf {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("vtnexa-mcp-{label}-{id}"));
        std::fs::create_dir_all(root.join(".vtnexa")).unwrap();
        root
    }

    #[cfg(unix)]
    #[test]
    fn project_config_symlink_is_rejected() {
        let root = fixture_root("config-link");
        let outside = fixture_root("config-link-outside");
        std::fs::remove_dir_all(root.join(".vtnexa")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".vtnexa")).unwrap();
        assert!(load_merged_mcp_entries(&root).is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn omitted_enabled_workspace_server_cannot_discover_before_grant() {
        let root = fixture_root("omitted");
        let project = root.join(".vtnexa/vtnexa.json");
        std::fs::write(
            &project,
            r#"{"mcp":{"s":{"type":"local","command":["python3","-c","open('spawned','w').write('x')"]}}}"#,
        )
        .unwrap();
        let entries = load_merged_mcp_entries_from_paths(None, &project).unwrap();
        let entry = entries.get("s").unwrap();
        assert!(entry.config.enabled);
        let trust = McpTrustStore::default();
        let status = server_status(&trust, &root, "s", entry).unwrap();
        assert!(!status.enabled);
        assert!(status.consent_required);
        assert!(!status.trusted);
        let marker = root.join("spawned");
        let err = tauri::async_runtime::block_on(list_tools_for_server_checked(
            "s",
            &entry.config,
            &root,
            true,
            false,
        ))
        .unwrap_err();
        assert!(err.contains("native trust"));
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn trust_grant_is_bound_to_root_name_and_fingerprint() {
        let root = fixture_root("grant");
        let other = fixture_root("grant-other");
        let trust = McpTrustStore::default();
        let cfg = McpServerConfig {
            command: Some(vec!["node".to_string(), "server.js".to_string()]),
            ..Default::default()
        };
        let fingerprint = config_fingerprint(&cfg);
        assert!(!trust.observe(&root, "s", &fingerprint, true, true).unwrap());
        assert!(
            grant_mcp_trust_after_confirmation(&trust, &root, "s", &fingerprint, false).is_err()
        );
        assert!(!trust.observe(&root, "s", &fingerprint, true, true).unwrap());
        grant_mcp_trust_after_confirmation(&trust, &root, "s", &fingerprint, true).unwrap();
        assert!(trust.observe(&root, "s", &fingerprint, true, true).unwrap());
        assert!(!trust
            .observe(&other, "s", &fingerprint, true, true)
            .unwrap());
        assert!(!trust
            .observe(&root, "other", &fingerprint, true, true)
            .unwrap());
        assert!(!trust
            .observe(&root, "s", &fingerprint, false, true)
            .unwrap());
        assert!(!trust.observe(&root, "s", &fingerprint, true, true).unwrap());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(other);
    }

    #[test]
    fn configuration_mutation_revokes_previous_consent() {
        let root = fixture_root("mutation");
        let trust = McpTrustStore::default();
        let cfg = McpServerConfig {
            command: Some(vec!["node".to_string(), "one.js".to_string()]),
            ..Default::default()
        };
        let first = config_fingerprint(&cfg);
        let mut enabled_changed = cfg.clone();
        enabled_changed.enabled = !enabled_changed.enabled;
        assert_eq!(first, config_fingerprint(&enabled_changed));
        trust.grant(&root, "s", &first).unwrap();
        assert!(trust.observe(&root, "s", &first, true, true).unwrap());
        let mut changed = cfg;
        changed.timeout += 1;
        let second = config_fingerprint(&changed);
        assert!(!trust.observe(&root, "s", &second, true, true).unwrap());
        assert!(!trust.observe(&root, "s", &first, true, true).unwrap());
        assert!(!trust.observe(&root, "s", &first, true, false).unwrap());
        assert!(!trust.observe(&root, "s", &first, true, true).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_shadow_cannot_inherit_global_trust() {
        let root = fixture_root("shadow");
        let global = root.join("global.json");
        let project = root.join(".vtnexa/vtnexa.json");
        std::fs::write(
            &global,
            r#"{"mcp":{"s":{"type":"local","command":["node","global.js"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            &project,
            r#"{"mcp":{"s":{"type":"local","command":["node","project.js"]}}}"#,
        )
        .unwrap();
        let entries = load_merged_mcp_entries_from_paths(Some(&global), &project).unwrap();
        let entry = entries.get("s").unwrap();
        assert_eq!(entry.source, McpConfigSource::Workspace);
        let trust = McpTrustStore::default();
        let status = server_status(&trust, &root, "s", entry).unwrap();
        assert!(!status.trusted);
        assert!(status.consent_required);
        assert!(!status.enabled);
        let global_only = fixture_root("global-only");
        let global_path = global_only.join("global.json");
        std::fs::write(
            &global_path,
            r#"{"mcp":{"g":{"type":"local","command":["node","global.js"]}}}"#,
        )
        .unwrap();
        let global_entries = load_merged_mcp_entries_from_paths(
            Some(&global_path),
            &global_only.join(".vtnexa/vtnexa.json"),
        )
        .unwrap();
        let global_entry = global_entries.get("g").unwrap();
        let global_status = server_status(&trust, &global_only, "g", global_entry).unwrap();
        assert!(global_status.trusted);
        assert!(global_status.enabled);
        assert!(!global_status.consent_required);
        let _ = std::fs::remove_dir_all(global_only);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_stdio_child_receives_only_explicit_environment() {
        let root = fixture_root("environment");
        let script = r#"import json,os,sys
for line in sys.stdin:
    try:
        value=json.loads(line)
        if value.get("method") == "tools/list":
            print(json.dumps({"jsonrpc":"2.0","id":value["id"],"result":{"tools":[],"inherited":os.environ.get("VTNEXA_MCP_INHERITED_TEST"),"explicit":os.environ.get("VTNEXA_MCP_EXPLICIT_TEST")}}), flush=True)
    except Exception:
        pass"#;
        std::env::set_var("VTNEXA_MCP_INHERITED_TEST", "inherited-secret");
        let mut env = HashMap::new();
        env.insert(
            "VTNEXA_MCP_EXPLICIT_TEST".to_string(),
            "explicit-value".to_string(),
        );
        let mut request = handshake_lines();
        request.push(jsonrpc_request(
            "tools/list",
            Some(2),
            serde_json::json!({}),
        ));
        let result = run_stdio_once(
            &["python3".to_string(), "-c".to_string(), script.to_string()],
            &root,
            &env,
            &request,
            2,
            Duration::from_secs(5),
            true,
        );
        std::env::remove_var("VTNEXA_MCP_INHERITED_TEST");
        let response = result.unwrap().response.unwrap();
        assert!(response["result"]["inherited"].is_null());
        assert_eq!(response["result"]["explicit"], "explicit-value");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_consent_detail_shows_command_or_host_without_config_secrets() {
        let root = fixture_root("consent");
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer SECRET".to_string());
        let local = McpServerConfig {
            command: Some(vec![
                "node".to_string(),
                "server.js".to_string(),
                "--flag".to_string(),
            ]),
            headers: Some(headers),
            ..Default::default()
        };
        let text = mcp_consent_text(&root, "local", &local, "fingerprint");
        assert!(text.contains("node server.js --flag"));
        assert!(text.contains("Authorization"));
        assert!(!text.contains("SECRET"));
        let remote = McpServerConfig {
            r#type: "remote".to_string(),
            url: Some("https://mcp.example.test/path?token=SECRET".to_string()),
            ..Default::default()
        };
        let text = mcp_consent_text(&root, "remote", &remote, "fingerprint");
        assert!(text.contains("https://mcp.example.test"));
        assert!(!text.contains("SECRET"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mcp_approval_detail_binds_server_tool_and_arguments() {
        assert_eq!(
            mcp_approval_detail("one", "lookup", &serde_json::json!({"q":"x"})),
            r#"{"args":{"q":"x"},"server":"one","tool":"lookup"}"#
        );
        let first = mcp_approval_detail("one", "lookup", &serde_json::json!({"q":"x"}));
        assert_ne!(
            first,
            mcp_approval_detail("two", "lookup", &serde_json::json!({"q":"x"}))
        );
        assert_ne!(
            first,
            mcp_approval_detail("one", "other", &serde_json::json!({"q":"x"}))
        );
        assert_ne!(
            first,
            mcp_approval_detail("one", "lookup", &serde_json::json!({"q": "y"}))
        );
    }

    #[cfg(unix)]
    #[test]
    fn stdio_response_stops_before_eof() {
        let script = "import json,sys,time\nfor line in sys.stdin:\n try:\n  value=json.loads(line)\n  if value.get('method') == 'tools/list':\n   print(json.dumps({'jsonrpc':'2.0','id':value['id'],'result':{'tools':[]}}),flush=True)\n   break\n except Exception:\n  pass\ntime.sleep(30)";
        let mut request = handshake_lines();
        request.push(jsonrpc_request(
            "tools/list",
            Some(2),
            serde_json::json!({}),
        ));
        let started = std::time::Instant::now();
        let output = run_stdio_once(
            &["python3".to_string(), "-c".to_string(), script.to_string()],
            std::path::Path::new("/tmp"),
            &HashMap::new(),
            &request,
            2,
            Duration::from_secs(5),
            true,
        )
        .unwrap();
        assert!(output.response.is_some());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn oversized_mcp_message_fails_before_eof() {
        let script = "import sys,time; sys.stdout.write('x' * 1048577 + '\\n'); sys.stdout.flush(); time.sleep(30)";
        let result = run_stdio_once(
            &["python3".to_string(), "-c".to_string(), script.to_string()],
            std::path::Path::new("/tmp"),
            &HashMap::new(),
            &[],
            2,
            Duration::from_secs(3),
            true,
        );
        let error = result.unwrap_err();
        assert!(error.contains("stdout line exceeded"), "got: {}", error);
    }
}

#[cfg(test)]
mod remote_roundtrip_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

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

    fn remote_cfg_with_headers(url: String, headers: &[(&str, &str)]) -> McpServerConfig {
        let mut values = std::collections::HashMap::new();
        for (name, value) in headers {
            values.insert((*name).to_string(), (*value).to_string());
        }
        McpServerConfig {
            r#type: "remote".to_string(),
            url: Some(url),
            headers: Some(values),
            ..Default::default()
        }
    }

    fn http_response(status: &str, headers: &[(&str, &str)], body: &str) -> String {
        let mut response = format!("HTTP/1.1 {}\r\n", status);
        for (name, value) in headers {
            response.push_str(name);
            response.push_str(": ");
            response.push_str(value);
            response.push_str("\r\n");
        }
        response.push_str(&format!("Content-Length: {}\r\n", body.len()));
        response.push_str("Connection: close\r\n\r\n");
        response.push_str(body);
        response
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut request = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let count = stream.read(&mut buffer).unwrap_or_default();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let header_end = header_end + 4;
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end.saturating_add(content_length) {
                break;
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn spawn_responses(
        responses: Vec<String>,
        seen: Arc<Mutex<Vec<String>>>,
        wait: Duration,
    ) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            for response in responses {
                let deadline = Instant::now() + wait;
                let accepted = loop {
                    if Instant::now() >= deadline {
                        break None;
                    }
                    match listener.accept() {
                        Ok(pair) => break Some(pair),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break None,
                    }
                };
                let Some((mut stream, _)) = accepted else {
                    break;
                };
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let request = read_http_request(&mut stream);
                seen.lock().unwrap().push(request);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (url, handle)
    }

    #[test]
    fn remote_same_origin_requests_keep_auth_session_and_custom_headers() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let init = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "serverInfo": {"name": "same-origin"}
            }
        })
        .to_string();
        let list = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {"tools": [{"name": "ping", "inputSchema": {"type": "object"}}]}
        })
        .to_string();
        let (url, server) = spawn_responses(
            vec![
                http_response(
                    "200 OK",
                    &[
                        ("Content-Type", "application/json"),
                        ("Mcp-Session-Id", "same-origin-session"),
                    ],
                    &init,
                ),
                http_response("202 Accepted", &[], ""),
                http_response("200 OK", &[("Content-Type", "application/json")], &list),
            ],
            seen.clone(),
            Duration::from_secs(3),
        );
        let cfg = remote_cfg_with_headers(
            url,
            &[
                ("Authorization", "Bearer static-auth-secret"),
                ("Cookie", "session=static-cookie-secret"),
                ("X-Api-Key", "static-api-key-secret"),
                ("X-Custom-Header", "static-custom-secret"),
            ],
        );
        let tools =
            tauri::async_runtime::block_on(remote_list_tools("same-origin", &cfg, false, true))
                .expect("same-origin list failed");
        server.join().unwrap();
        assert_eq!(tools.len(), 1);
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 3, "requests: {:?}", requests);
        let expected_headers = [
            "authorization: bearer static-auth-secret",
            "cookie: session=static-cookie-secret",
            "x-api-key: static-api-key-secret",
            "x-custom-header: static-custom-secret",
        ];
        let first = requests[0].to_ascii_lowercase();
        for expected in expected_headers {
            assert!(first.contains(expected), "missing {expected}: {first}");
        }
        assert!(!first.contains("mcp-session-id:"));
        for request in &requests[1..] {
            let lower = request.to_ascii_lowercase();
            for expected in expected_headers {
                assert!(lower.contains(expected), "missing {expected}: {lower}");
            }
            assert!(lower.contains("mcp-session-id: same-origin-session"));
        }
    }

    #[test]
    fn remote_redirects_are_rejected_without_forwarding_headers() {
        for (status, server_name) in [
            ("307 Temporary Redirect", "redirect-307"),
            ("308 Permanent Redirect", "redirect-308"),
        ] {
            let target_seen = Arc::new(Mutex::new(Vec::new()));
            let (target_url, target_server) = spawn_responses(
                vec![http_response(
                    "200 OK",
                    &[("Content-Type", "application/json")],
                    "",
                )],
                target_seen.clone(),
                Duration::from_millis(500),
            );
            let first_seen = Arc::new(Mutex::new(Vec::new()));
            let init = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "serverInfo": {"name": "redirect"}
                }
            })
            .to_string();
            let (first_url, first_server) = spawn_responses(
                vec![
                    http_response(
                        "200 OK",
                        &[
                            ("Content-Type", "application/json"),
                            ("Mcp-Session-Id", "redirect-session"),
                        ],
                        &init,
                    ),
                    http_response(
                        status,
                        &[
                            ("Location", target_url.as_str()),
                            ("Content-Type", "text/plain"),
                        ],
                        "redirect-body-secret",
                    ),
                ],
                first_seen.clone(),
                Duration::from_secs(3),
            );
            let cfg = remote_cfg_with_headers(
                first_url,
                &[
                    ("Authorization", "Bearer redirect-auth-secret"),
                    ("Cookie", "session=redirect-cookie-secret"),
                    ("X-Api-Key", "redirect-api-key-secret"),
                    ("X-Custom-Header", "redirect-custom-secret"),
                ],
            );
            let result =
                tauri::async_runtime::block_on(remote_list_tools(server_name, &cfg, false, true));
            first_server.join().unwrap();
            target_server.join().unwrap();
            let error = result.unwrap_err();
            let target_requests = target_seen.lock().unwrap();
            assert_eq!(target_requests.len(), 0);
            drop(target_requests);
            let first_requests = first_seen.lock().unwrap().clone();
            assert_eq!(first_requests.len(), 2, "requests: {:?}", first_requests);
            let expected_headers = [
                "authorization: bearer redirect-auth-secret",
                "cookie: session=redirect-cookie-secret",
                "x-api-key: redirect-api-key-secret",
                "x-custom-header: redirect-custom-secret",
            ];
            let first = first_requests[0].to_ascii_lowercase();
            for expected in expected_headers {
                assert!(first.contains(expected), "missing {expected}: {first}");
            }
            assert!(!first.contains("mcp-session-id:"));
            let second = first_requests[1].to_ascii_lowercase();
            for expected in expected_headers {
                assert!(second.contains(expected), "missing {expected}: {second}");
            }
            assert!(second.contains("mcp-session-id: redirect-session"));
            assert!(error.contains("redirect"), "got: {}", error);
            assert!(!error.contains("redirect-body-secret"));
            assert!(!error.contains(&target_url));
        }
    }

    #[test]
    fn remote_response_body_limit_is_still_enforced() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let marker = "body-limit-secret";
        let body = format!(
            "{marker}{}",
            "x".repeat(MCP_MAX_HTTP_BODY_BYTES + 1 - marker.len())
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let (url, server) = spawn_responses(vec![response], seen, Duration::from_secs(3));
        let cfg = remote_cfg(url);
        let error =
            tauri::async_runtime::block_on(remote_list_tools("body-limit", &cfg, false, true))
                .unwrap_err();
        server.join().unwrap();
        assert!(error.contains("Content-Length exceeds"), "got: {}", error);
        assert!(!error.contains(marker));
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
        assert!(tools[0].qualified_name.starts_with("mcp_mock_add_"));
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
