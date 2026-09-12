//! Browser Use sidecar manager + HTTP proxy.
//! Spawns `sidecar/browser/server.js` (playwright-core + system Chrome,
//! persistent profile) and proxies agent/UI calls to it.

use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

pub struct BrowserInner {
    pub base_url: String,
    pub token: String,
    pub child: Option<Child>,
}

impl Default for BrowserInner {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:39317".to_string(),
            token: String::new(),
            child: None,
        }
    }
}

pub struct BrowserState(pub Mutex<BrowserInner>);

impl Default for BrowserState {
    fn default() -> Self {
        Self(Mutex::new(BrowserInner::default()))
    }
}

fn gen_token() -> String {
    // 32 random bytes hex; /dev/urandom on Linux, time+pid fallback.
    // NOTE: std::fs::read on /dev/urandom reads until EOF and a char device
    // never signals EOF - this must stay a bounded read_exact or the whole
    // app hangs (and OOMs) the first time the browser tab is opened.
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let mut bytes = [0u8; 32];
        if std::io::Read::read_exact(&mut f, &mut bytes).is_ok() {
            return bytes.iter().map(|b| format!("{:02x}", b)).collect();
        }
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{}-{}", nanos, std::process::id(), rand_fallback())
}

fn rand_fallback() -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::thread::current().id().hash(&mut h);
    // pointer entropy
    (&h as *const _ as usize).hash(&mut h);
    h.finish()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

async fn sidecar_running(base: &str, token: &str) -> bool {
    let Ok(c) = client() else { return false };
    let Ok(r) = c
        .get(format!("{}/status", base))
        .header("x-vtai-token", token)
        .timeout(Duration::from_secs(2))
        .send()
        .await
    else {
        return false;
    };
    let Ok(v) = r.json::<Value>().await else {
        return false;
    };
    v.get("running").and_then(|x| x.as_bool()).unwrap_or(false)
}

/// Unauthenticated probe: is *anything* listening (foreign instance / stale)?
async fn port_busy(base: &str) -> bool {
    let Ok(c) = client() else { return false };
    c.get(format!("{}/status", base))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok()
}

fn resolve_server_js(app: &tauri::AppHandle) -> Option<String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // 1. bundled resource (prod): <res>/sidecar-stage/browser/server.js
    //    (staged via `pnpm stage-sidecar`, which dereferences pnpm's
    //    node_modules symlinks - Tauri's resource copier drops symlinks,
    //    which would leave the sidecar unable to require playwright-core).
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(
            res.join("sidecar-stage")
                .join("browser")
                .join("server.js"),
        );
        // Legacy layouts from before staging, kept as fallbacks.
        candidates.push(
            res.join("_up_")
                .join("sidecar")
                .join("browser")
                .join("server.js"),
        );
        candidates.push(res.join("sidecar").join("browser").join("server.js"));
    }
    // 2. relative to cwd (dev: cwd == src-tauri -> ../sidecar; or app root -> sidecar)
    candidates.push(std::path::PathBuf::from("../sidecar/browser/server.js"));
    candidates.push(std::path::PathBuf::from("sidecar/browser/server.js"));
    // 3. relative to current exe (target/debug/vtaitool -> ../../sidecar/...)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("../../sidecar/browser/server.js"));
            candidates.push(dir.join("../sidecar/browser/server.js"));
        }
    }

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

#[tauri::command]
pub async fn browser_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    port: Option<u16>,
    headless: Option<bool>,
) -> Result<Value, String> {
    let port = port.unwrap_or(39317);
    let base = format!("http://127.0.0.1:{}", port);

    // Ensure we have a token for this app run.
    let token = {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        if inner.token.is_empty() {
            inner.token = gen_token();
        }
        inner.token.clone()
    };

    // reuse if our sidecar is already healthy
    if sidecar_running(&base, &token).await {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        inner.base_url = base.clone();
        return Ok(json!({ "ok": true, "reused": true, "baseUrl": base }));
    }
    // Refuse to fight a foreign listener on the same port.
    if port_busy(&base).await {
        return Err(
            "browser port busy (foreign instance?). Stop it or pick another port".to_string(),
        );
    }

    let script = resolve_server_js(&app)
        .ok_or_else(|| "browser sidecar server.js not found (looked in resources + sidecar/)".to_string())?;

    let mut cmd = Command::new("node");
    // No orphaned sidecars: on Unix the kernel kills the child if WE die for
    // any reason (crash included). Normal window-close is handled explicitly
    // in run()'s on_window_event.
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.arg(&script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--headless")
        .arg(if headless.unwrap_or(false) { "1" } else { "0" })
        .env("VTAI_BROWSER_TOKEN", &token)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    // inherit profile/chrome overrides if the user exported them
    for key in ["VTAI_BROWSER_PROFILE", "VTAI_BROWSER_CHROME"] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }

    let child: Child = cmd.spawn().map_err(|e| format!("spawn node sidecar failed: {}", e))?;

    {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = inner.child.take() {
            let _ = old.kill();
        }
        inner.child = Some(child);
        inner.base_url = base.clone();
    }

    // poll for readiness (browser launch takes a few seconds)
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if sidecar_running(&base, &token).await {
            return Ok(json!({ "ok": true, "reused": false, "baseUrl": base }));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    Ok(json!({ "ok": false, "error": "sidecar did not become ready in 20s", "baseUrl": base }))
}

#[tauri::command]
pub fn browser_stop(state: tauri::State<'_, BrowserState>) -> Result<Value, String> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(json!({ "ok": true }))
}

async fn get_path(state: &tauri::State<'_, BrowserState>, path: &str) -> Result<Value, String> {
    let (base, token) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        (inner.base_url.clone(), inner.token.clone())
    };
    let r = client()?
        .get(format!("{}{}", base, path))
        .header("x-vtai-token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    r.json::<Value>().await.map_err(|e| e.to_string())
}

async fn post_path(
    state: &tauri::State<'_, BrowserState>,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    let (base, token) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        (inner.base_url.clone(), inner.token.clone())
    };
    let r = client()?
        .post(format!("{}{}", base, path))
        .header("x-vtai-token", token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    r.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_status(state: tauri::State<'_, BrowserState>) -> Result<Value, String> {
    let (base, token) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        (inner.base_url.clone(), inner.token.clone())
    };
    if token.is_empty() {
        return Ok(json!({ "ok": true, "running": false }));
    }
    match client()?
        .get(format!("{}/status", base))
        .header("x-vtai-token", token)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        Ok(r) => r.json::<Value>().await.map_err(|e| e.to_string()),
        Err(_) => Ok(json!({ "ok": true, "running": false })),
    }
}

#[tauri::command]
pub async fn browser_navigate(
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<Value, String> {
    if url.len() > 4096 || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("browser_navigate: http(s) URL required".to_string());
    }
    post_path(&state, "/navigate", json!({ "url": url })).await
}

#[tauri::command]
pub async fn browser_snapshot(state: tauri::State<'_, BrowserState>) -> Result<Value, String> {
    get_path(&state, "/snapshot").await
}

#[tauri::command]
pub async fn browser_click(
    state: tauri::State<'_, BrowserState>,
    target_ref: u32,
) -> Result<Value, String> {
    post_path(&state, "/click", json!({ "ref": target_ref })).await
}

#[tauri::command]
pub async fn browser_type(
    state: tauri::State<'_, BrowserState>,
    target_ref: u32,
    text: String,
    submit: Option<bool>,
) -> Result<Value, String> {
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
pub async fn browser_back(state: tauri::State<'_, BrowserState>) -> Result<Value, String> {
    post_path(&state, "/back", json!({})).await
}
