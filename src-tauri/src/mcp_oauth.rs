// OAuth 2.1 login for remote MCP servers (OpenCode-pattern port).
//
// Flow: RFC 9728 protected-resource discovery -> RFC 8414 authorization
// metadata -> RFC 7591 dynamic registration (unless pre-registered via
// `oauth.clientId`) -> PKCE code flow (RFC 7636) through a loopback
// redirect opened in the system browser -> tokens in the OS keychain.
// Refresh tokens rotate silently; a dead refresh surfaces as "sign in
// again" instead of a raw 401.
//
// Secrets live ONLY in the keychain (account `mcp-oauth:<server>`). Config
// carries ids and endpoints, never tokens. Error strings never include
// tokens, codes, verifiers or secrets.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;

use crate::mcp::{url_host_display, valid_server_name, validate_remote_url, McpServerConfig};

const KEY_ACCOUNT_PREFIX: &str = "mcp-oauth:";
const LOGIN_WAIT_SECS: u64 = 300;
const CLOCK_SKEW_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OAuthClientState {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_secret: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OAuthTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Unix seconds when the access token dies; 0 = server didn't say.
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredBlob {
    client: OAuthClientState,
    tokens: OAuthTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OAuthMode {
    Disabled,
    Auto,
    PreRegistered,
}

pub(crate) fn oauth_mode(cfg: &McpServerConfig) -> OAuthMode {
    match &cfg.oauth {
        None => OAuthMode::Auto,
        Some(v) if v == &serde_json::Value::Bool(false) => OAuthMode::Disabled,
        _ => OAuthMode::PreRegistered,
    }
}

fn oauth_account(server: &str) -> Result<String, String> {
    if !valid_server_name(server) {
        return Err("mcp: invalid server name".to_string());
    }
    Ok(format!("{}{}", KEY_ACCOUNT_PREFIX, server))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn tokens_live(tokens: &OAuthTokens) -> bool {
    if tokens.access_token.is_empty() {
        return false;
    }
    tokens.expires_at == 0 || now_unix() < tokens.expires_at - CLOCK_SKEW_SECS
}

fn load_blob(server: &str) -> Result<Option<StoredBlob>, String> {
    let account = oauth_account(server)?;
    let entry = keyring::Entry::new(crate::KEY_SERVICE, &account)
        .map_err(|e| format!("keyring unavailable: {}", e))?;
    match entry.get_password() {
        Ok(raw) => {
            let blob: StoredBlob = serde_json::from_str(&raw).map_err(|_| {
                format!(
                    "mcp: stored credentials for '{}' are corrupt — sign in again",
                    server
                )
            })?;
            Ok(Some(blob))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring unavailable: {}", e)),
    }
}

fn store_blob(server: &str, blob: &StoredBlob) -> Result<(), String> {
    let account = oauth_account(server)?;
    let raw = serde_json::to_string(blob).map_err(|e| e.to_string())?;
    if raw.len() > 16384 {
        return Err("mcp: credential blob too large".to_string());
    }
    keyring::Entry::new(crate::KEY_SERVICE, &account)
        .map_err(|e| format!("keyring unavailable: {}", e))?
        .set_password(&raw)
        .map_err(|e| {
            format!(
                "mcp: cannot store tokens in OS keychain ({}). Without a keychain daemon OAuth login cannot persist — start one (e.g. gnome-keyring) and retry",
                e
            )
        })
}

fn delete_blob(server: &str) -> Result<(), String> {
    let account = oauth_account(server)?;
    match keyring::Entry::new(crate::KEY_SERVICE, &account)
        .map_err(|e| format!("keyring unavailable: {}", e))?
        .delete_credential()
    {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring unavailable: {}", e)),
    }
}

// ---- Pure helpers (unit tested) ----

/// RFC 9728: insert `/.well-known/oauth-protected-resource` before the path.
pub(crate) fn protected_resource_url(mcp_url: &str) -> String {
    let (origin, path) = match mcp_url.split_once("://") {
        Some((scheme, rest)) => {
            let host = rest.split('/').next().unwrap_or(rest);
            let path = rest.get(host.len()..).unwrap_or("");
            (format!("{}://{}", scheme, host), path.to_string())
        }
        None => (mcp_url.to_string(), String::new()),
    };
    let path = if path.is_empty() { "/" } else { path.as_str() };
    format!("{}/.well-known/oauth-protected-resource{}", origin, path)
}

pub(crate) fn auth_server_wellknown(origin: &str) -> String {
    format!(
        "{}/.well-known/oauth-authorization-server",
        origin.trim_end_matches('/')
    )
}

pub(crate) fn mcp_origin(mcp_url: &str) -> String {
    match mcp_url.split_once("://") {
        Some((scheme, rest)) => format!("{}://{}", scheme, rest.split('/').next().unwrap_or(rest)),
        None => mcp_url.to_string(),
    }
}

fn rand_b64url(nbytes: usize) -> String {
    let mut bytes = vec![0u8; nbytes];
    // Bounded read: /dev/urandom never EOFs, so read_exact (browser.rs pattern).
    let filled = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| {
            use std::io::Read;
            f.read_exact(&mut bytes).map(|_| true)
        })
        .unwrap_or(false);
    if !filled {
        // Fallback entropy: time + pid + stack address, hashed.
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        std::time::SystemTime::now().hash(&mut h);
        std::process::id().hash(&mut h);
        (&bytes as *const _ as usize).hash(&mut h);
        let mut seed = h.finish();
        for b in bytes.iter_mut() {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *b = (seed >> 33) as u8;
        }
    }
    URL_SAFE_NO_PAD.encode(&bytes)
}

/// S256 code challenge. The RFC 7636 Appendix B vector is a unit test.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

pub(crate) fn authorize_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    state: &str,
    challenge: &str,
) -> String {
    // Endpoints come from server metadata; encode only our parameters.
    // (Simple encoder: unreserved marks pass through, everything else %XX.)
    let enc = |s: &str| {
        let mut o = String::new();
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                o.push(b as char);
            } else {
                o.push_str(&format!("%{:02X}", b));
            }
        }
        o
    };
    let mut url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        authorization_endpoint,
        enc(client_id),
        enc(redirect_uri),
        enc(state),
        enc(challenge)
    );
    if !scope.trim().is_empty() {
        url.push_str(&format!("&scope={}", enc(scope)));
    }
    url
}

#[derive(Debug, PartialEq)]
pub(crate) enum CallbackAuth {
    Code { code: String, state: String },
    ProviderError(String),
}

/// Parse the loopback GET target (`/callback?code=..&state=..`).
pub(crate) fn parse_callback_target(target: &str) -> Result<CallbackAuth, String> {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut params: HashMap<&str, &str> = HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            params.entry(k).or_insert(v);
        }
    }
    if let Some(err) = params.get("error") {
        let desc = params.get("error_description").unwrap_or(&"");
        return Ok(CallbackAuth::ProviderError(
            format!("{} {}", err, percent_decode(desc))
                .trim()
                .to_string(),
        ));
    }
    match (params.get("code"), params.get("state")) {
        (Some(code), Some(state)) if !code.is_empty() && !state.is_empty() => {
            Ok(CallbackAuth::Code {
                code: percent_decode(code),
                state: percent_decode(state),
            })
        }
        _ => Err("mcp: login redirect carried no code (access denied?)".to_string()),
    }
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4 | l) as char);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' {
            ' '
        } else {
            bytes[i] as char
        });
        i += 1;
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ---- HTTP helpers ----

fn http_client(timeout_ms: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(1000, 30_000)))
        .build()
        .map_err(|e| format!("mcp: http client failed: {}", e))
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    host: &str,
) -> Result<serde_json::Value, String> {
    let res = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("mcp: {} timed out during login", host)
            } else {
                format!("mcp: cannot reach {} during login ({})", host, e)
            }
        })?;
    if !res.status().is_success() {
        return Err(format!(
            "mcp: {} answered HTTP {} during login",
            host,
            res.status()
        ));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|_| format!("mcp: {} returned non-JSON during login", host))
}

async fn post_form(
    client: &reqwest::Client,
    url: &str,
    host: &str,
    form: &HashMap<&str, String>,
) -> Result<serde_json::Value, String> {
    let res = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(encode_form(form))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("mcp: {} timed out", host)
            } else {
                format!("mcp: {} request failed: {}", host, e)
            }
        })?;
    // Status only on failure: bodies may echo secrets back.
    if !res.status().is_success() {
        return Err(format!(
            "mcp: {} answered HTTP {} during login",
            host,
            res.status()
        ));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|_| format!("mcp: {} returned non-JSON during login", host))
}

/// application/x-www-form-urlencoded (pure, tested).
pub(crate) fn encode_form(form: &HashMap<&str, String>) -> String {
    let mut keys: Vec<&&str> = form.keys().collect();
    keys.sort();
    keys.iter()
        .map(|k| format!("{}={}", form_encode(k), form_encode(&form[**k])))
        .collect::<Vec<_>>()
        .join("&")
}

fn form_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            o.push(b as char);
        } else if b == b' ' {
            o.push('+');
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

// ---- Discovery + registration ----

struct Discovered {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
}

async fn discover(
    client: &reqwest::Client,
    mcp_url: &str,
    host: &str,
) -> Result<Discovered, String> {
    // 1. Protected-resource metadata may name the authorization server(s).
    let prm_url = protected_resource_url(mcp_url);
    let mut auth_server: Option<String> = None;
    if let Ok(meta) = get_json(client, &prm_url, host).await {
        if meta.get("error").is_none() {
            auth_server = meta
                .get("authorization_servers")
                .and_then(|s| s.as_array())
                .and_then(|a| a.first())
                .and_then(|s| s.as_str())
                .map(str::to_string);
        }
    }
    // 2. Authorization-server metadata: named server, else same-origin guess.
    let candidates = match auth_server {
        Some(s) => vec![auth_server_wellknown(&s)],
        None => vec![auth_server_wellknown(&mcp_origin(mcp_url))],
    };
    for url in candidates {
        if let Ok(meta) = get_json(client, &url, host).await {
            if meta.get("error").is_some() {
                continue;
            }
            let auth_ep = meta.get("authorization_endpoint").and_then(|v| v.as_str());
            let token_ep = meta.get("token_endpoint").and_then(|v| v.as_str());
            if let (Some(a), Some(t)) = (auth_ep, token_ep) {
                return Ok(Discovered {
                    authorization_endpoint: a.to_string(),
                    token_endpoint: t.to_string(),
                    registration_endpoint: meta
                        .get("registration_endpoint")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                });
            }
        }
    }
    Err(format!(
        "mcp: {} exposes no OAuth metadata (tried {}) — pre-register a client (oauth.clientId) or use header auth",
        host, prm_url
    ))
}

fn preregistered_client(
    name: &str,
    cfg: &McpServerConfig,
    token_ep: &str,
    auth_ep: &str,
) -> Result<OAuthClientState, String> {
    let obj = cfg.oauth.as_ref();
    let get = |k: &str| {
        obj.and_then(|o| o.get(k))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let client_id = get("clientId").ok_or_else(|| {
        format!(
            "mcp: server '{}' needs OAuth but oauth.clientId is missing (and no registration endpoint was advertised)",
            name
        )
    })?;
    Ok(OAuthClientState {
        client_id,
        client_secret: get("clientSecret").unwrap_or_default(),
        authorization_endpoint: auth_ep.to_string(),
        token_endpoint: token_ep.to_string(),
        scope: get("scope").unwrap_or_default(),
    })
}

async fn dynamic_register(
    client: &reqwest::Client,
    host: &str,
    registration_endpoint: &str,
    redirect_uri: &str,
    scope: &str,
    auth_ep: &str,
    token_ep: &str,
) -> Result<OAuthClientState, String> {
    let mut body = serde_json::Map::new();
    body.insert("client_name".to_string(), "VTNexa".into());
    body.insert("redirect_uris".to_string(), vec![redirect_uri].into());
    body.insert(
        "grant_types".to_string(),
        vec!["authorization_code", "refresh_token"].into(),
    );
    body.insert("response_types".to_string(), vec!["code"].into());
    body.insert("token_endpoint_auth_method".to_string(), "none".into());
    if !scope.trim().is_empty() {
        body.insert("scope".to_string(), scope.into());
    }
    let res = client
        .post(registration_endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("mcp: {} client registration failed: {}", host, e))?;
    if !res.status().is_success() {
        return Err(format!(
            "mcp: {} refused client registration (HTTP {}) — pre-register a client (oauth.clientId) instead",
            host,
            res.status()
        ));
    }
    let v: serde_json::Value = res
        .json()
        .await
        .map_err(|_| format!("mcp: {} registration returned non-JSON", host))?;
    let client_id = v
        .get("client_id")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("mcp: {} registration response had no client_id", host))?;
    Ok(OAuthClientState {
        client_id: client_id.to_string(),
        client_secret: v
            .get("client_secret")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        authorization_endpoint: auth_ep.to_string(),
        token_endpoint: token_ep.to_string(),
        scope: scope.to_string(),
    })
}

// ---- Loopback wait (blocking socket on a std thread) ----

/// Bind loopback first (port known before DCR), wait for one
/// `/callback?code=..&state=..` GET. Returns (code, state).
fn wait_for_callback(port: u16, timeout: Duration) -> Result<(String, String), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(String, String), String>>();
    std::thread::spawn(move || {
        let res = wait_for_callback_inner(port, timeout);
        let _ = tx.send(res);
    });
    // Poll so the async caller stays cancellable via its own timeout.
    let deadline = std::time::Instant::now() + timeout + Duration::from_secs(5);
    loop {
        match rx.try_recv() {
            Ok(r) => return r,
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                if std::time::Instant::now() >= deadline {
                    return Err("mcp: login timed out waiting for the browser (5 min) — retry from the ⛁ panel".to_string());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err("mcp: login listener died".to_string());
            }
        }
    }
}

fn wait_for_callback_inner(port: u16, timeout: Duration) -> Result<(String, String), String> {
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).map_err(|e| {
        format!(
            "mcp: cannot listen on loopback ({}). Another login in progress?",
            e
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("mcp: loopback setup failed: {}", e))?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(
                "mcp: login timed out waiting for the browser (5 min) — retry from the ⛁ panel"
                    .to_string(),
            );
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; 8192];
                use std::io::Read;
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let target = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let outcome = parse_callback_target(target);
                let page: &[u8] = match &outcome {
                    Ok(_) => b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<h1>Signed in to VTNexa.</h1><p>You can close this tab.</p>",
                    Err(_) => b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<h1>Sign-in failed.</h1><p>Return to VTNexa and retry.</p>",
                };
                use std::io::Write;
                let _ = stream.write_all(page);
                return match outcome {
                    Ok(CallbackAuth::Code { code, state }) => Ok((code, state)),
                    Ok(CallbackAuth::ProviderError(e)) => {
                        Err(format!("mcp: provider refused login ({})", e))
                    }
                    Err(e) => Err(e),
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("mcp: loopback accept failed: {}", e)),
        }
    }
}

fn free_loopback_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("mcp: no loopback available: {}", e))?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    drop(l);
    Ok(port)
}

// ---- Token exchange / refresh ----

fn tokens_from_response(v: &serde_json::Value) -> Result<OAuthTokens, String> {
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let desc = v
            .get("error_description")
            .and_then(|d| d.as_str())
            .unwrap_or("");
        return Err(format!("mcp: token request refused ({} {})", err, desc)
            .trim()
            .to_string());
    }
    let access = v.get("access_token").and_then(|t| t.as_str()).unwrap_or("");
    if access.is_empty() {
        return Err("mcp: token response had no access_token".to_string());
    }
    let expires_at = v
        .get("expires_in")
        .and_then(|e| e.as_i64().or_else(|| e.as_u64().map(|u| u as i64)))
        .map(|secs| now_unix() + secs.max(0) - 30)
        .unwrap_or(0);
    Ok(OAuthTokens {
        access_token: access.to_string(),
        refresh_token: v
            .get("refresh_token")
            .and_then(|r| r.as_str())
            .unwrap_or("")
            .to_string(),
        expires_at,
        scope: v
            .get("scope")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

async fn exchange_code(
    client: &reqwest::Client,
    host: &str,
    client_state: &OAuthClientState,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<OAuthTokens, String> {
    let mut form: HashMap<&str, String> = HashMap::new();
    form.insert("grant_type", "authorization_code".to_string());
    form.insert("code", code.to_string());
    form.insert("redirect_uri", redirect_uri.to_string());
    form.insert("client_id", client_state.client_id.clone());
    if !client_state.client_secret.is_empty() {
        form.insert("client_secret", client_state.client_secret.clone());
    }
    form.insert("code_verifier", verifier.to_string());
    tokens_from_response(&post_form(client, &client_state.token_endpoint, host, &form).await?)
}

async fn refresh_tokens(
    client: &reqwest::Client,
    host: &str,
    client_state: &OAuthClientState,
    refresh_token: &str,
) -> Result<OAuthTokens, String> {
    let mut form: HashMap<&str, String> = HashMap::new();
    form.insert("grant_type", "refresh_token".to_string());
    form.insert("refresh_token", refresh_token.to_string());
    form.insert("client_id", client_state.client_id.clone());
    if !client_state.client_secret.is_empty() {
        form.insert("client_secret", client_state.client_secret.clone());
    }
    if !client_state.scope.trim().is_empty() {
        form.insert("scope", client_state.scope.clone());
    }
    let mut tokens =
        tokens_from_response(&post_form(client, &client_state.token_endpoint, host, &form).await?)?;
    // Some servers don't rotate: keep the old refresh token then.
    if tokens.refresh_token.is_empty() {
        tokens.refresh_token = refresh_token.to_string();
    }
    Ok(tokens)
}

// ---- Public surface (used by mcp.rs transport + Tauri commands) ----

/// Bearer resolution: Disabled = header-only auth, Token = use it,
/// Unsigned = no stored credentials (headers may still apply).
pub(crate) enum Bearer {
    Disabled,
    Token(String),
    Unsigned,
}

pub(crate) async fn bearer_for(
    name: &str,
    cfg: &McpServerConfig,
    force: bool,
) -> Result<Bearer, String> {
    if oauth_mode(cfg) == OAuthMode::Disabled {
        return Ok(Bearer::Disabled);
    }
    if force {
        return force_refresh(name, cfg).await.map(Bearer::Token);
    }
    match load_blob(name)? {
        None => Ok(Bearer::Unsigned),
        Some(blob) => {
            if tokens_live(&blob.tokens) {
                return Ok(Bearer::Token(blob.tokens.access_token.clone()));
            }
            if blob.tokens.refresh_token.is_empty() {
                return Err(format!(
                    "mcp: '{}' session expired with no refresh token — sign in again from the ⛁ panel",
                    name
                ));
            }
            let host = url_host_display(cfg.url.as_deref().unwrap_or(""));
            let client = http_client(crate::mcp::clamp_timeout(cfg.timeout))?;
            match refresh_tokens(&client, &host, &blob.client, &blob.tokens.refresh_token).await {
                Ok(tokens) => {
                    let access = tokens.access_token.clone();
                    let _ = store_blob(
                        name,
                        &StoredBlob {
                            client: blob.client,
                            tokens,
                        },
                    );
                    Ok(Bearer::Token(access))
                }
                Err(_) => Err(format!(
                    "mcp: '{}' session expired and refresh failed — sign in again from the ⛁ panel",
                    name
                )),
            }
        }
    }
}

/// Valid access token, refreshing silently when possible.
/// Ok(None) = OAuth disabled for this server (header/static path applies).
/// Err = not signed in / expired / keychain broken (message says what to do).
pub(crate) async fn get_valid_token(
    name: &str,
    cfg: &McpServerConfig,
) -> Result<Option<String>, String> {
    match bearer_for(name, cfg, false).await? {
        Bearer::Disabled => Ok(None),
        Bearer::Token(t) => Ok(Some(t)),
        Bearer::Unsigned => Err(format!(
            "mcp: '{}' is not signed in — open the ⛁ panel and Sign in",
            name
        )),
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct OAuthStatus {
    pub signed_in: bool,
    /// Seconds until expiry, when known. Absent = unknown or signed out.
    pub expires_in: Option<i64>,
    pub has_refresh: bool,
}

pub(crate) fn oauth_status(name: &str) -> Result<OAuthStatus, String> {
    match load_blob(name)? {
        None => Ok(OAuthStatus {
            signed_in: false,
            expires_in: None,
            has_refresh: false,
        }),
        Some(blob) => Ok(OAuthStatus {
            signed_in: !blob.tokens.access_token.is_empty(),
            expires_in: if blob.tokens.expires_at > 0 {
                Some((blob.tokens.expires_at - now_unix()).max(0))
            } else {
                None
            },
            has_refresh: !blob.tokens.refresh_token.is_empty(),
        }),
    }
}

pub(crate) fn oauth_logout(name: &str) -> Result<(), String> {
    delete_blob(name)
}

/// Refresh unconditionally (401 path): the stored access token was rejected
/// even though it looked live. Returns the new access token.
pub(crate) async fn force_refresh(name: &str, cfg: &McpServerConfig) -> Result<String, String> {
    let Some(blob) = load_blob(name)? else {
        return Err(format!(
            "mcp: '{}' is not signed in — open the ⛁ panel and Sign in",
            name
        ));
    };
    if blob.tokens.refresh_token.is_empty() {
        return Err(format!(
            "mcp: '{}' session was rejected with no refresh token — sign in again from the ⛁ panel",
            name
        ));
    }
    let host = url_host_display(cfg.url.as_deref().unwrap_or(""));
    let client = http_client(crate::mcp::clamp_timeout(cfg.timeout))?;
    match refresh_tokens(&client, &host, &blob.client, &blob.tokens.refresh_token).await {
        Ok(tokens) => {
            let access = tokens.access_token.clone();
            store_blob(
                name,
                &StoredBlob {
                    client: blob.client,
                    tokens,
                },
            )?;
            Ok(access)
        }
        Err(_) => Err(format!(
            "mcp: '{}' session was rejected and refresh failed — sign in again from the ⛁ panel",
            name
        )),
    }
}

/// Full interactive login: metadata -> register (unless pre-registered) ->
/// browser -> loopback -> exchange -> keychain. Opens the system browser and
/// blocks (up to 5 min) waiting for the redirect.
pub(crate) async fn oauth_login(
    open_url: impl Fn(&str) -> Result<(), String>,
    name: &str,
    cfg: &McpServerConfig,
) -> Result<String, String> {
    if oauth_mode(cfg) == OAuthMode::Disabled {
        return Err(format!(
            "mcp: '{}' has oauth disabled — enable it or use header auth",
            name
        ));
    }
    let url = validate_remote_url(cfg.url.as_deref().unwrap_or(""))?;
    let host = url_host_display(&url);
    let client = http_client(crate::mcp::clamp_timeout(cfg.timeout))?;
    let discovered = discover(&client, &url, &host).await?;

    // Bind loopback BEFORE registering: the redirect_uri must be exact.
    let port = free_loopback_port()?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let client_state = match oauth_mode(cfg) {
        OAuthMode::PreRegistered => preregistered_client(
            name,
            cfg,
            &discovered.token_endpoint,
            &discovered.authorization_endpoint,
        )?,
        _ => {
            let reg_ep = discovered.registration_endpoint.as_deref().ok_or_else(|| {
                format!(
                    "mcp: {} advertises no registration endpoint — pre-register a client (oauth.clientId) or use header auth",
                    host
                )
            })?;
            let scope = cfg
                .oauth
                .as_ref()
                .and_then(|o| o.get("scope"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            dynamic_register(
                &client,
                &host,
                reg_ep,
                &redirect_uri,
                &scope,
                &discovered.authorization_endpoint,
                &discovered.token_endpoint,
            )
            .await?
        }
    };

    let verifier = rand_b64url(32);
    let state = rand_b64url(16);
    let auth_url = authorize_url(
        &client_state.authorization_endpoint,
        &client_state.client_id,
        &redirect_uri,
        &client_state.scope,
        &state,
        &pkce_challenge(&verifier),
    );
    open_url(&auth_url)?;
    let (code, returned_state) = wait_for_callback(port, Duration::from_secs(LOGIN_WAIT_SECS))?;
    if returned_state != state {
        return Err(
            "mcp: login state mismatch — retry (a stale tab may have answered)".to_string(),
        );
    }
    let tokens = exchange_code(
        &client,
        &host,
        &client_state,
        &code,
        &redirect_uri,
        &verifier,
    )
    .await?;
    store_blob(
        name,
        &StoredBlob {
            client: client_state,
            tokens,
        },
    )?;
    Ok(format!("signed in to '{}'", name))
}

// ---- Tauri commands ----

#[tauri::command]
pub(crate) async fn mcp_oauth_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    server: String,
) -> Result<OAuthStatus, String> {
    // Config load validates the server exists (no silent per-name probing).
    let root = crate::root_snapshot(&state, window.label());
    let merged = crate::mcp::load_merged_mcp_config(&root)?;
    if !merged.contains_key(&server) {
        return Err(format!("mcp: unknown server '{}'", server));
    }
    oauth_status(&server)
}

#[tauri::command]
pub(crate) async fn mcp_oauth_login(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::WorkspaceRoots>,
    server: String,
) -> Result<String, String> {
    let root = crate::root_snapshot(&state, window.label());
    let merged = crate::mcp::load_merged_mcp_config(&root)?;
    let cfg = merged
        .get(&server)
        .ok_or_else(|| format!("mcp: unknown server '{}'", server))?;
    if cfg.r#type != "remote" {
        return Err(format!("mcp: '{}' is not a remote server", server));
    }
    let win = window.clone();
    oauth_login(
        move |url| {
            use tauri_plugin_opener::OpenerExt;
            win.opener()
                .open_url(url, None::<String>)
                .map(|_| ())
                .map_err(|e| {
                    format!(
                        "mcp: cannot open browser ({}). Copy this URL manually: {}",
                        e, url
                    )
                })
        },
        &server,
        cfg,
    )
    .await
}

#[tauri::command]
pub(crate) fn mcp_oauth_logout(server: String) -> Result<(), String> {
    oauth_logout(&server)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_vector() {
        // RFC 7636 Appendix B verifier; expected challenge cross-checked
        // against Python hashlib (two implementations agree byte-for-byte).
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn protected_resource_url_inserts_wellknown() {
        assert_eq!(
            protected_resource_url("https://mcp.example.com/mcp"),
            "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
        );
        assert_eq!(
            protected_resource_url("https://mcp.example.com"),
            "https://mcp.example.com/.well-known/oauth-protected-resource/"
        );
        assert_eq!(
            auth_server_wellknown("https://auth.example.com/"),
            "https://auth.example.com/.well-known/oauth-authorization-server"
        );
        assert_eq!(
            mcp_origin("https://mcp.example.com/a/b"),
            "https://mcp.example.com"
        );
    }

    #[test]
    fn callback_targets_parse() {
        assert_eq!(
            parse_callback_target("/callback?code=abc123&state=xyz").unwrap(),
            CallbackAuth::Code {
                code: "abc123".to_string(),
                state: "xyz".to_string()
            }
        );
        assert_eq!(
            parse_callback_target("/callback?code=a%20b&state=s").unwrap(),
            CallbackAuth::Code {
                code: "a b".to_string(),
                state: "s".to_string()
            }
        );
        assert!(matches!(
            parse_callback_target("/callback?error=access_denied&error_description=nope").unwrap(),
            CallbackAuth::ProviderError(_)
        ));
        assert!(parse_callback_target("/callback?state=s").is_err());
        assert!(parse_callback_target("/callback").is_err());
    }

    #[test]
    fn token_liveness_respects_skew() {
        let live = OAuthTokens {
            access_token: "a".into(),
            refresh_token: "".into(),
            expires_at: 0,
            scope: "".into(),
        };
        assert!(tokens_live(&live));
        let fresh = OAuthTokens {
            expires_at: now_unix() + 3600,
            ..live.clone()
        };
        assert!(tokens_live(&fresh));
        let stale = OAuthTokens {
            expires_at: now_unix() - 10,
            ..live.clone()
        };
        assert!(!tokens_live(&stale));
        let empty = OAuthTokens {
            access_token: "".into(),
            ..live
        };
        assert!(!tokens_live(&empty));
    }

    #[test]
    fn oauth_modes() {
        let mut cfg = McpServerConfig::default();
        assert_eq!(oauth_mode(&cfg), OAuthMode::Auto);
        cfg.oauth = Some(serde_json::json!(false));
        assert_eq!(oauth_mode(&cfg), OAuthMode::Disabled);
        cfg.oauth = Some(serde_json::json!({"clientId": "x"}));
        assert_eq!(oauth_mode(&cfg), OAuthMode::PreRegistered);
    }

    #[test]
    fn token_responses_reject_errors_without_leak() {
        let err = tokens_from_response(
            &serde_json::json!({"error": "invalid_grant", "error_description": "bad code"}),
        )
        .unwrap_err();
        assert!(err.contains("invalid_grant"));
        assert!(tokens_from_response(&serde_json::json!({"result": {}}))
            .unwrap_err()
            .contains("no access_token"));
        let toks =
            tokens_from_response(&serde_json::json!({"access_token": "a", "expires_in": 100}))
                .unwrap();
        assert!(toks.expires_at > now_unix());
    }

    #[test]
    fn form_encoding_is_sorted_and_escaped() {
        let mut form = HashMap::new();
        form.insert("scope", "read write".to_string());
        form.insert("code", "a/b+c".to_string());
        assert_eq!(encode_form(&form), "code=a%2Fb%2Bc&scope=read+write");
    }
}
