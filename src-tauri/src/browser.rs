use crate::process::{run_bounded, ProcessLimits, ProcessOptions};
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(20);
const SIDECAR_IPC_MAX_LINE_BYTES: usize = 4096;
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
const PREFLIGHT_MAX_STDOUT_BYTES: usize = 256 * 1024;
const PREFLIGHT_MAX_STDERR_BYTES: usize = 64 * 1024;
const PREFLIGHT_MAX_COMBINED_BYTES: usize = 320 * 1024;
const BROWSER_DIAGNOSTIC_MAX_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub struct BrowserInner {
    pub base_url: String,
    pub port: u16,
    token: String,
    pub child: Option<Child>,
    ipc: Option<ChildStdin>,
    #[cfg(windows)]
    pub job: Option<crate::windows_job::JobHandle>,
    pub node_path: Option<String>,
    pub node_source: Option<String>,
    pub node_version: Option<String>,
    pub profile_path: Option<String>,
    pub browser: Option<Value>,
    pub headless: bool,
}

pub struct BrowserState(pub Mutex<BrowserInner>);

impl Default for BrowserState {
    fn default() -> Self {
        Self(Mutex::new(BrowserInner::default()))
    }
}

fn base_url_for_port(port: u16) -> String {
    if port == 0 {
        String::new()
    } else {
        format!("http://127.0.0.1:{}", port)
    }
}

#[derive(Default)]
struct BoundedDiagnostic {
    bytes: Vec<u8>,
    truncated: bool,
}

impl BoundedDiagnostic {
    fn push(&mut self, bytes: &[u8]) {
        let remaining = BROWSER_DIAGNOSTIC_MAX_BYTES.saturating_sub(self.bytes.len());
        let accepted = bytes.len().min(remaining);
        self.bytes.extend_from_slice(&bytes[..accepted]);
        self.truncated |= accepted < bytes.len();
    }
}

fn start_stderr_drain(stderr: std::process::ChildStderr) -> Arc<Mutex<BoundedDiagnostic>> {
    let state = Arc::new(Mutex::new(BoundedDiagnostic::default()));
    let writer = state.clone();
    std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut buffer = [0u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if let Ok(mut diagnostic) = writer.lock() {
                        diagnostic.push(&buffer[..count]);
                    }
                }
            }
        }
    });
    state
}

struct SidecarHandshake {
    port: u16,
    token: String,
}

fn parse_sidecar_handshake(line: &[u8]) -> Result<SidecarHandshake, String> {
    if line.len() > SIDECAR_IPC_MAX_LINE_BYTES {
        return Err("browser sidecar IPC frame exceeded its size limit".to_string());
    }
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let value: Value = serde_json::from_slice(line)
        .map_err(|_| "browser sidecar IPC frame was not valid JSON".to_string())?;
    if value.get("type").and_then(Value::as_str) != Some("ready") {
        return Err("browser sidecar IPC frame had an invalid type".to_string());
    }
    let port = value
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| *port > 0 && *port <= u16::MAX as u64)
        .ok_or_else(|| "browser sidecar IPC frame had an invalid port".to_string())?
        as u16;
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "browser sidecar IPC frame had invalid credentials".to_string())?;
    Ok(SidecarHandshake {
        port,
        token: token.to_string(),
    })
}

fn read_bounded_line<R: BufRead>(reader: &mut R, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let (take, complete) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                return Ok(if line.is_empty() { None } else { Some(line) });
            }
            if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
                let take = index + 1;
                if line.len().saturating_add(take) > limit {
                    return Err(io::Error::other("IPC line exceeded its limit"));
                }
                line.extend_from_slice(&available[..take]);
                (take, true)
            } else {
                let take = available.len();
                if line.len().saturating_add(take) > limit {
                    return Err(io::Error::other("IPC line exceeded its limit"));
                }
                line.extend_from_slice(available);
                (take, false)
            }
        };
        reader.consume(take);
        if complete {
            return Ok(Some(line));
        }
    }
}

fn start_sidecar_ipc_reader(
    stdout: ChildStdout,
    sender: mpsc::SyncSender<Result<SidecarHandshake, String>>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut sent = false;
        loop {
            match read_bounded_line(&mut reader, SIDECAR_IPC_MAX_LINE_BYTES) {
                Ok(Some(line)) if !sent => {
                    let _ = sender.send(parse_sidecar_handshake(&line));
                    sent = true;
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    if !sent {
                        let _ = sender.send(Err(
                            "browser sidecar IPC closed before readiness".to_string()
                        ));
                    }
                    break;
                }
                Err(_) => {
                    if !sent {
                        let _ = sender.send(Err(
                            "browser sidecar IPC frame exceeded its limit".to_string()
                        ));
                    }
                    break;
                }
            }
        }
    });
}

#[cfg(unix)]
fn configure_browser_child(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            #[cfg(target_os = "linux")]
            if libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGTERM as libc::c_ulong,
                0,
                0,
                0,
            ) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: i32) {
    if pid == 0 || pid > i32::MAX as u32 {
        return;
    }
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(unix)]
fn wait_for_child_until(child: &mut Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return true,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn stop_child_bounded(mut child: Child) {
    let process_group = child.id();
    let mut tree = crate::process::UnixTree::capture(process_group, None).ok();
    signal_process_group(process_group, libc::SIGTERM);
    let _ = wait_for_child_until(&mut child, Instant::now() + Duration::from_millis(250));
    signal_process_group(process_group, libc::SIGKILL);
    let _ = child.kill();
    let reaped = wait_for_child_until(&mut child, Instant::now() + Duration::from_millis(750));
    if let Some(tree) = tree.as_mut() {
        let _ = tree.terminate();
        let _ = tree.reap_collected();
    }
    if !reaped {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

#[cfg(windows)]
fn stop_child_bounded(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(any(unix, windows)))]
fn stop_child_bounded(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn child_is_running(state: &BrowserState) -> bool {
    let Ok(mut inner) = state.0.lock() else {
        return false;
    };
    inner
        .child
        .as_mut()
        .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
}

fn wait_for_handshake(
    state: &BrowserState,
    receiver: &mpsc::Receiver<Result<SidecarHandshake, String>>,
    deadline: Instant,
) -> Result<SidecarHandshake, String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("browser sidecar IPC readiness timed out".to_string());
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !child_is_running(state) {
                    return Err("browser sidecar exited before IPC readiness".to_string());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("browser sidecar IPC reader disconnected".to_string())
            }
        }
    }
}

fn clear_session_locked(inner: &mut BrowserInner) {
    inner.base_url.clear();
    inner.port = 0;
    inner.token.clear();
    inner.ipc = None;
}

fn ready_session(state: &BrowserState) -> Result<(String, String), String> {
    let mut inner = state.0.lock().map_err(|error| error.to_string())?;
    if inner.token.is_empty()
        || inner.port == 0
        || inner.base_url.is_empty()
        || inner.base_url != base_url_for_port(inner.port)
        || !is_loopback_base(&inner.base_url)
    {
        return Err(
            "browser is not ready; choose Recheck before using browser controls".to_string(),
        );
    }
    let running = inner
        .child
        .as_mut()
        .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
    if !running {
        clear_session_locked(&mut inner);
        return Err(
            "browser is not ready; choose Recheck before using browser controls".to_string(),
        );
    }
    Ok((inner.base_url.clone(), inner.token.clone()))
}

fn is_loopback_base(base: &str) -> bool {
    let Some(port) = base.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    !port.is_empty()
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().map(|value| value > 0).unwrap_or(false)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
}

fn resource_browser_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("sidecar-stage").join("browser"));
        dirs.push(resource_dir.join("browser"));
    }
    dirs
}

#[cfg(debug_assertions)]
fn debug_browser_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("src-tauri").join("sidecar-stage").join("browser"));
        dirs.push(cwd.join("sidecar-stage").join("browser"));
        dirs.push(cwd.join("sidecar").join("browser"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("sidecar-stage").join("browser"));
            dirs.push(parent.join("sidecar").join("browser"));
        }
    }
    dirs
}

fn node_names() -> [&'static str; 2] {
    if cfg!(windows) {
        ["node.exe", "node"]
    } else {
        ["node", "node.exe"]
    }
}

fn resolve_node_executable(app: &tauri::AppHandle) -> Result<(String, String), String> {
    let mut dirs = resource_browser_dirs(app);
    #[cfg(debug_assertions)]
    dirs.extend(debug_browser_dirs());
    for dir in dirs {
        for name in node_names() {
            let candidate = dir.join(name);
            if candidate.is_absolute() && candidate.is_file() {
                return Ok((
                    candidate.to_string_lossy().to_string(),
                    "bundled".to_string(),
                ));
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        Ok(("node".to_string(), "PATH".to_string()))
    }
    #[cfg(not(debug_assertions))]
    {
        Err(format!(
            "browser runtime is missing: bundled Node {} was not found in Tauri resources; run pnpm run provision-node and rebuild",
            "24.18.0"
        ))
    }
}

fn resolve_server_js(app: &tauri::AppHandle) -> Result<String, String> {
    let mut candidates = Vec::new();
    for dir in resource_browser_dirs(app) {
        candidates.push(dir.join("server.js"));
    }
    #[cfg(debug_assertions)]
    {
        for dir in debug_browser_dirs() {
            candidates.push(dir.join("server.js"));
        }
    }
    for candidate in candidates {
        if candidate.is_absolute() && candidate.is_file() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err("browser sidecar server.js was not found in the staged Tauri resources; run pnpm run stage-sidecar".to_string())
}

fn native_profile_path() -> PathBuf {
    if let Ok(custom) = std::env::var("VTAI_BROWSER_PROFILE") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("APPDATA")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            })
            .or_else(|| {
                std::env::var("USERPROFILE").ok().map(|home| {
                    PathBuf::from(home)
                        .join("AppData")
                        .join("Local")
                        .to_string_lossy()
                        .to_string()
                })
            })
            .unwrap_or_else(|| {
                PathBuf::from(".")
                    .join("AppData")
                    .join("Local")
                    .to_string_lossy()
                    .to_string()
            });
        PathBuf::from(base).join("VTNexa").join("browser-profile")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("VTNexa")
            .join("browser-profile")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .to_string_lossy()
                    .to_string()
            });
        PathBuf::from(base).join("VTNexa").join("browser-profile")
    }
    #[cfg(not(any(windows, target_os = "macos", unix)))]
    {
        PathBuf::from(".").join("VTNexa").join("browser-profile")
    }
}

fn runtime_json(
    node_path: Option<&str>,
    node_source: Option<&str>,
    version: Option<&str>,
    ready: bool,
) -> Value {
    json!({
        "ready": ready,
        "source": node_source,
        "path": node_path,
        "version": version,
    })
}

fn node_version(path: &str) -> Option<String> {
    Path::new(path)
        .parent()
        .and_then(|parent| std::fs::read_to_string(parent.join("node-version.txt")).ok())
        .map(|value| value.trim().trim_start_matches('v').to_string())
        .filter(|value| !value.is_empty())
}

fn remediation_for(error: &str) -> String {
    if error.contains("VTAI_BROWSER_CHROME") {
        "Set VTAI_BROWSER_CHROME to an existing Chrome, Edge, or Chromium executable.".to_string()
    } else if error.contains("Node") || error.contains("node") {
        "Run pnpm run stage-sidecar and rebuild so the verified Node runtime is bundled."
            .to_string()
    } else if error.contains("browser engine") {
        "Install Google Chrome, Microsoft Edge, or Chromium, then choose Recheck.".to_string()
    } else {
        "Resolve the reported prerequisite, then choose Recheck.".to_string()
    }
}

fn missing_preflight(
    error: String,
    _port: u16,
    profile: &Path,
    node: Option<(String, String)>,
) -> Value {
    let (node_path, node_source) = node
        .map(|(path, source)| (Some(path), Some(source)))
        .unwrap_or((None, None));
    let version = node_path.as_deref().and_then(node_version);
    json!({
        "ok": true,
        "ready": false,
        "running": false,
        "baseUrl": Value::Null,
        "port": Value::Null,
        "pageUrl": Value::Null,
        "blockedTarget": Value::Null,
        "profilePath": profile.to_string_lossy(),
        "runtime": runtime_json(node_path.as_deref(), node_source.as_deref(), version.as_deref(), node_path.is_some()),
        "node": runtime_json(node_path.as_deref(), node_source.as_deref(), version.as_deref(), node_path.is_some()),
        "browser": {
            "ready": false,
            "engine": "chromium",
            "channel": Value::Null,
            "path": Value::Null,
            "error": error.clone(),
        },
        "missing": [error.clone()],
        "remediation": [remediation_for(&error)],
    })
}

fn preflight_error(value: &Value) -> String {
    value
        .get("missing")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/browser/error").and_then(Value::as_str))
        .unwrap_or("browser prerequisites are unavailable; choose Recheck for details")
        .to_string()
}

fn preflight_for_blocking(app: &tauri::AppHandle, port: u16) -> Value {
    let profile = native_profile_path();
    let node = match resolve_node_executable(app) {
        Ok(node) => Some(node),
        Err(error) => return missing_preflight(error, port, &profile, None),
    };
    let (node_path, node_source) = match node.as_ref() {
        Some((path, source)) => (path, source),
        None => {
            return missing_preflight(
                "browser runtime is unavailable".to_string(),
                port,
                &profile,
                None,
            )
        }
    };
    let script = match resolve_server_js(app) {
        Ok(script) => script,
        Err(error) => return missing_preflight(error, port, &profile, node),
    };
    let mut command = Command::new(node_path);
    command
        .arg(&script)
        .arg("--preflight")
        .arg("--port")
        .arg("0")
        .arg("--profile")
        .arg(&profile)
        .env("VTAI_BROWSER_NODE_SOURCE", node_source)
        .env("VTAI_BROWSER_NODE_PATH", node_path)
        .env_remove("VTAI_BROWSER_TOKEN")
        .env_remove("VTAI_BROWSER_TOKEN_FILE");
    let output = match run_bounded(
        command,
        ProcessOptions::new(
            PREFLIGHT_TIMEOUT,
            ProcessLimits::new(
                PREFLIGHT_MAX_STDOUT_BYTES,
                PREFLIGHT_MAX_STDERR_BYTES,
                PREFLIGHT_MAX_COMBINED_BYTES,
            ),
        ),
    ) {
        Ok(output) => output,
        Err(error) => {
            let detail = crate::truncate_chars(error.to_string(), 1000);
            return missing_preflight(
                format!("browser preflight failed: {}", detail),
                port,
                &profile,
                node,
            );
        }
    };
    let mut value: Value = match serde_json::from_slice::<Value>(&output.stdout_bytes()) {
        Ok(value) if value.is_object() => value,
        _ => {
            let mut detail = output.stderr().trim().to_string();
            if detail.is_empty() && output.code() != 0 {
                detail = format!("preflight exited with status {}", output.code());
            }
            let error = if detail.is_empty() {
                "browser preflight returned no structured status".to_string()
            } else {
                format!(
                    "browser preflight failed: {}",
                    crate::truncate_chars(detail, 1000)
                )
            };
            return missing_preflight(error, port, &profile, node);
        }
    };
    let version = node.as_ref().and_then(|item| node_version(&item.0));
    let runtime = runtime_json(
        node.as_ref().map(|item| item.0.as_str()),
        node.as_ref().map(|item| item.1.as_str()),
        version.as_deref(),
        true,
    );
    value["runtime"] = runtime.clone();
    value["node"] = runtime;
    value["profilePath"] = json!(profile.to_string_lossy().to_string());
    value["baseUrl"] = Value::Null;
    value["port"] = Value::Null;
    value["pageUrl"] = Value::Null;
    value["blockedTarget"] = Value::Null;
    if value.get("ready").and_then(Value::as_bool) != Some(true) {
        if !value
            .get("missing")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
        {
            value["missing"] = json!([preflight_error(&value)]);
        }
        if !value
            .get("remediation")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
        {
            value["remediation"] = json!([value
                .pointer("/browser/remediation")
                .and_then(Value::as_str)
                .unwrap_or("Install a supported browser and choose Recheck.")]);
        }
    }
    value
}

async fn preflight_for(app: &tauri::AppHandle, port: u16) -> Value {
    let app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || preflight_for_blocking(&app, port)).await {
        Ok(value) => value,
        Err(error) => missing_preflight(
            crate::truncate_chars(format!("browser preflight task failed: {}", error), 1000),
            port,
            &native_profile_path(),
            None,
        ),
    }
}

fn decorate_status(
    mut value: Value,
    inner: &BrowserInner,
    base: &str,
    port: u16,
    profile: &Path,
) -> Value {
    if !value.is_object() {
        value = json!({});
    }
    let object = value.as_object_mut().expect("status object");
    let legacy_page_url = object.remove("url");
    if !object.contains_key("pageUrl") {
        object.insert(
            "pageUrl".to_string(),
            legacy_page_url.unwrap_or(Value::Null),
        );
    }
    object.insert("baseUrl".to_string(), json!(base));
    object.insert("port".to_string(), json!(port));
    object.insert("ok".to_string(), json!(true));
    object.insert("profilePath".to_string(), json!(profile.to_string_lossy()));
    let running = object
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let runtime_ready = inner.node_source.as_deref() == Some("PATH")
        || inner
            .node_path
            .as_deref()
            .map(|path| Path::new(path).is_file())
            .unwrap_or(false);
    let runtime = runtime_json(
        inner.node_path.as_deref(),
        inner.node_source.as_deref(),
        inner.node_version.as_deref(),
        runtime_ready,
    );
    object.insert("runtime".to_string(), runtime.clone());
    object.insert("node".to_string(), runtime);
    let browser_ready = object
        .get("browser")
        .and_then(|browser| browser.get("ready"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    object.insert(
        "ready".to_string(),
        json!(running || (runtime_ready && browser_ready)),
    );
    value
}

pub(crate) fn navigation_host_blocked(url: &str) -> bool {
    let Some((_, rest)) = url.split_once("://") else {
        return true;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let host = if let Some(end) = authority
        .strip_prefix('[')
        .and_then(|value| value.find(']').map(|index| &value[..index]))
    {
        end
    } else {
        authority.split(':').next().unwrap_or("")
    }
    .to_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata.google.internal"
        || host == "0.0.0.0"
    {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_unspecified()
                    || ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.octets()[0] == 0
                    || ip.octets()[0] >= 224
                    || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                    || (ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19))
            }
            std::net::IpAddr::V6(ip) => {
                let segments = ip.segments();
                ip.is_loopback()
                    || ip.is_unspecified()
                    || (segments[0] & 0xfe00) == 0xfc00
                    || (segments[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

pub(crate) fn stop_process(state: &BrowserState) {
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    stop_locked(&mut inner);
}

fn stop_locked(inner: &mut BrowserInner) {
    #[cfg(windows)]
    if let Some(job) = inner.job.take() {
        job.terminate();
    }
    inner.ipc.take();
    if let Some(child) = inner.child.take() {
        stop_child_bounded(child);
    }
    clear_session_locked(inner);
}

fn request_shutdown(state: &BrowserState) {
    let ipc = state.0.lock().ok().and_then(|mut inner| inner.ipc.take());
    if let Some(mut ipc) = ipc {
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = ipc
                .write_all(b"{\"type\":\"shutdown\"}\n")
                .and_then(|_| ipc.flush());
            let _ = sender.send(result.is_ok());
        });
        let _ = receiver.recv_timeout(Duration::from_millis(250));
    }
    stop_process(state);
}

#[tauri::command]
pub async fn browser_preflight(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<Value, String> {
    let _ = state.0.lock().map_err(|error| error.to_string())?.port;
    Ok(preflight_for(&app, 0).await)
}

#[tauri::command]
pub async fn browser_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    port: Option<u16>,
    headless: Option<bool>,
) -> Result<Value, String> {
    let _ = port;
    if ready_session(&state).is_ok() {
        let inner = state.0.lock().map_err(|error| error.to_string())?;
        return Ok(json!({
            "ok": true,
            "running": true,
            "ready": true,
            "reused": true,
            "baseUrl": inner.base_url,
            "port": inner.port,
            "headless": inner.headless,
            "profilePath": inner.profile_path,
            "browser": inner.browser,
        }));
    }
    stop_process(&state);
    let preflight = preflight_for(&app, 0).await;
    if preflight.get("ready").and_then(Value::as_bool) != Some(true) {
        return Err(preflight_error(&preflight));
    }
    let (node_path, node_source) = resolve_node_executable(&app)?;
    let script = resolve_server_js(&app)?;
    let profile = native_profile_path();
    let headless = headless.unwrap_or(false);
    let mut command = Command::new(&node_path);
    #[cfg(unix)]
    configure_browser_child(&mut command);
    command
        .arg(&script)
        .arg("--port")
        .arg("0")
        .arg("--profile")
        .arg(&profile)
        .arg("--headless")
        .arg(if headless { "1" } else { "0" })
        .env("VTAI_BROWSER_PROFILE", &profile)
        .env("VTAI_BROWSER_NODE_PATH", &node_path)
        .env("VTAI_BROWSER_NODE_SOURCE", &node_source)
        .env_remove("VTAI_BROWSER_TOKEN")
        .env_remove("VTAI_BROWSER_TOKEN_FILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if std::env::var("VTAI_BROWSER_NO_SANDBOX").as_deref() == Ok("1") {
        command.env("VTAI_BROWSER_NO_SANDBOX", "1");
    }
    for key in ["VTAI_BROWSER_CHROME"] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    let job = match crate::windows_job::JobHandle::new() {
        Ok(job) => Some(job),
        Err(error) => return Err(error),
    };
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(format!("browser Node runtime could not start: {}", error)),
    };
    #[cfg(windows)]
    if let Some(job) = &job {
        if let Err(error) = job.assign(&child) {
            stop_child_bounded(child);
            return Err(error);
        }
    }
    let Some(stdout) = child.stdout.take() else {
        stop_child_bounded(child);
        return Err("browser sidecar IPC stdout was not available".to_string());
    };
    let stdin = child.stdin.take();
    let _diagnostic_state = child
        .stderr
        .take()
        .map(start_stderr_drain)
        .unwrap_or_else(|| Arc::new(Mutex::new(BoundedDiagnostic::default())));
    let (sender, receiver) = mpsc::sync_channel(1);
    start_sidecar_ipc_reader(stdout, sender);
    {
        let mut inner = match state.0.lock() {
            Ok(inner) => inner,
            Err(error) => {
                stop_child_bounded(child);
                return Err(error.to_string());
            }
        };
        stop_locked(&mut inner);
        inner.node_path = Some(node_path.clone());
        inner.node_source = Some(node_source.clone());
        inner.node_version = node_version(&node_path);
        inner.profile_path = Some(profile.to_string_lossy().to_string());
        inner.browser = preflight.get("browser").cloned();
        inner.headless = headless;
        inner.child = Some(child);
        inner.ipc = stdin;
        #[cfg(windows)]
        {
            inner.job = job;
        }
    }
    let handshake =
        match wait_for_handshake(&state, &receiver, Instant::now() + SIDECAR_READY_TIMEOUT) {
            Ok(handshake) => handshake,
            Err(error) => {
                stop_process(&state);
                return Err(format!("browser launch failed: {}", error));
            }
        };
    let base = base_url_for_port(handshake.port);
    {
        let mut inner = state.0.lock().map_err(|error| {
            stop_process(&state);
            error.to_string()
        })?;
        if inner.child.is_none() {
            return Err("browser sidecar exited before session initialization".to_string());
        }
        inner.base_url = base.clone();
        inner.port = handshake.port;
        inner.token = handshake.token.clone();
    }
    Ok(json!({
        "ok": true,
        "running": true,
        "ready": true,
        "reused": false,
        "baseUrl": base,
        "port": handshake.port,
        "headless": headless,
        "profilePath": profile.to_string_lossy(),
        "browser": preflight.get("browser").cloned().unwrap_or(Value::Null),
    }))
}

#[tauri::command]
pub async fn browser_stop(state: tauri::State<'_, BrowserState>) -> Result<Value, String> {
    let base = state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .base_url
        .clone();
    request_shutdown(&state);
    Ok(json!({ "ok": true, "running": false, "baseUrl": base }))
}

async fn get_path(state: &tauri::State<'_, BrowserState>, path: &str) -> Result<Value, String> {
    let (base, token) = ready_session(state)?;
    client()?
        .get(format!("{}{}", base, path))
        .header("x-vtai-token", token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())
}

async fn post_path(
    state: &tauri::State<'_, BrowserState>,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    let (base, token) = ready_session(state)?;
    client()?
        .post(format!("{}{}", base, path))
        .header("x-vtai-token", token)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())
}

async fn status_fallback(app: &tauri::AppHandle, base: &str, port: u16) -> Value {
    let mut value = preflight_for(app, port).await;
    if let Some(object) = value.as_object_mut() {
        object.insert("running".to_string(), json!(false));
        object.insert("baseUrl".to_string(), json!(base));
        object.insert("port".to_string(), json!(port));
        object.insert("pageUrl".to_string(), Value::Null);
    }
    value
}

#[tauri::command]
pub async fn browser_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<Value, String> {
    let (base, token) = match ready_session(&state) {
        Ok(session) => session,
        Err(_) => {
            return Ok(preflight_for(&app, 0).await);
        }
    };
    let port = state.0.lock().map_err(|error| error.to_string())?.port;
    match client()?
        .get(format!("{}/status", base))
        .header("x-vtai-token", token)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            let value = response
                .json::<Value>()
                .await
                .map_err(|error| error.to_string())?;
            let inner = state.0.lock().map_err(|error| error.to_string())?;
            Ok(decorate_status(
                value,
                &inner,
                &base,
                port,
                &native_profile_path(),
            ))
        }
        Ok(_) | Err(_) => Ok(status_fallback(&app, &base, port).await),
    }
}

#[tauri::command]
pub async fn browser_navigate(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    rate_limiter: tauri::State<'_, crate::rate_limiter::RateLimiter>,
    url: String,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<Value, String> {
    crate::approvals::approval_consume(
        &approvals,
        window.label(),
        "browser_navigate",
        &approval_detail,
        &approval_token,
    )?;
    rate_limiter.check_turn(window.label())?;
    if url.len() > 4096 || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("browser_navigate: http(s) URL required".to_string());
    }
    if navigation_host_blocked(&url) {
        return Err("browser_navigate: refused (loopback/private/link-local target — visit manually if you really need it)".to_string());
    }
    post_path(&state, "/navigate", json!({ "url": url })).await
}

#[tauri::command]
pub async fn browser_snapshot(state: tauri::State<'_, BrowserState>) -> Result<Value, String> {
    get_path(&state, "/snapshot").await
}

#[tauri::command]
pub async fn browser_click(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    rate_limiter: tauri::State<'_, crate::rate_limiter::RateLimiter>,
    target_ref: u32,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<Value, String> {
    crate::approvals::approval_consume(
        &approvals,
        window.label(),
        "browser_click",
        &approval_detail,
        &approval_token,
    )?;
    rate_limiter.check_turn(window.label())?;
    post_path(&state, "/click", json!({ "ref": target_ref })).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_type(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    rate_limiter: tauri::State<'_, crate::rate_limiter::RateLimiter>,
    target_ref: u32,
    text: String,
    submit: Option<bool>,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<Value, String> {
    crate::approvals::approval_consume(
        &approvals,
        window.label(),
        "browser_type",
        &approval_detail,
        &approval_token,
    )?;
    rate_limiter.check_turn(window.label())?;
    if text.len() > 20000 {
        return Err("browser_type: text too long".to_string());
    }
    post_path(
        &state,
        "/type",
        json!({ "ref": target_ref, "text": text, "submit": submit.unwrap_or(false) }),
    )
    .await
}

#[tauri::command]
pub async fn browser_screenshot(state: tauri::State<'_, BrowserState>) -> Result<Value, String> {
    get_path(&state, "/screenshot").await
}

#[tauri::command]
pub async fn browser_scroll(
    state: tauri::State<'_, BrowserState>,
    dx: Option<i32>,
    dy: Option<i32>,
) -> Result<Value, String> {
    let dx = dx.unwrap_or(0).clamp(-5000, 5000);
    let dy = dy.unwrap_or(600).clamp(-5000, 5000);
    post_path(&state, "/scroll", json!({ "dx": dx, "dy": dy })).await
}

#[tauri::command]
pub async fn browser_back(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    rate_limiter: tauri::State<'_, crate::rate_limiter::RateLimiter>,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<Value, String> {
    crate::approvals::approval_consume(
        &approvals,
        window.label(),
        "browser_back",
        &approval_detail,
        &approval_token,
    )?;
    rate_limiter.check_turn(window.label())?;
    post_path(&state, "/back", json!({})).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssrf_guard_blocks_private_targets() {
        for url in [
            "http://localhost:3000/",
            "http://127.0.0.1/",
            "http://10.0.0.5/",
            "http://172.16.4.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://0.0.0.0/",
            "http://myhost.local/",
            "http://[::1]/",
        ] {
            assert!(navigation_host_blocked(url), "should block {}", url);
        }
        for url in ["https://example.com/", "https://mcp.example.com/mcp"] {
            assert!(!navigation_host_blocked(url), "should allow {}", url);
        }
    }

    #[test]
    fn child_handshake_is_validated_without_echoing_credentials() {
        let token = "ab".repeat(32);
        let line = format!(r#"{{"type":"ready","port":43123,"token":"{token}"}}"#);
        let handshake = parse_sidecar_handshake(line.as_bytes()).unwrap();
        assert_eq!(handshake.port, 43123);
        assert_eq!(handshake.token, token);
        assert!(parse_sidecar_handshake(br#"{"type":"ready","port":0,"token":"bad"}"#).is_err());
        assert!(
            parse_sidecar_handshake(br#"{"type":"ready","port":43123,"token":"short"}"#).is_err()
        );
    }

    #[test]
    fn ipc_reader_rejects_unbounded_lines() {
        let data = vec![b'x'; SIDECAR_IPC_MAX_LINE_BYTES + 1];
        let mut reader = BufReader::new(std::io::Cursor::new(data));
        assert!(read_bounded_line(&mut reader, SIDECAR_IPC_MAX_LINE_BYTES).is_err());
    }

    #[test]
    fn sidecar_base_requires_a_real_loopback_port() {
        assert!(is_loopback_base("http://127.0.0.1:43123"));
        assert!(!is_loopback_base("http://127.0.0.1:0"));
        assert!(!is_loopback_base("http://localhost:43123"));
        assert!(!is_loopback_base("http://127.0.0.1:43123@foreign"));
        assert!(base_url_for_port(0).is_empty());
    }

    #[test]
    fn browser_diagnostics_are_bounded() {
        let mut diagnostic = BoundedDiagnostic::default();
        diagnostic.push(&vec![b'x'; BROWSER_DIAGNOSTIC_MAX_BYTES + 128]);
        assert!(diagnostic.truncated);
        assert_eq!(diagnostic.bytes.len(), BROWSER_DIAGNOSTIC_MAX_BYTES);
    }

    #[test]
    fn base_url_and_page_url_are_independent() {
        let inner = BrowserInner::default();
        let value = decorate_status(
            json!({ "running": true, "url": "https://example.test:8443/account" }),
            &inner,
            &base_url_for_port(40123),
            40123,
            Path::new("/tmp/profile"),
        );
        assert_eq!(value["baseUrl"], "http://127.0.0.1:40123");
        assert_eq!(value["port"], 40123);
        assert_eq!(value["pageUrl"], "https://example.test:8443/account");
        assert!(value.get("url").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unix_browser_cleanup_kills_the_descendant_group_within_a_bound() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_browser_child(&mut command);
        let mut child = command.spawn().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let descendant = line.trim().parse::<i32>().unwrap();
        let state = BrowserState(Mutex::new(BrowserInner {
            child: Some(child),
            ..BrowserInner::default()
        }));
        let started = Instant::now();
        request_shutdown(&state);
        assert!(started.elapsed() < Duration::from_secs(2));
        let deadline = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::kill(descendant, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "descendant process survived cleanup"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
