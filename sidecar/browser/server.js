const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const fs = require("node:fs");
const { Transform } = require("node:stream");
const { chromium } = require("playwright-core");
const runtime = require("./runtime");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const PROFILE = arg("--profile", process.env.VTAI_BROWSER_PROFILE || runtime.profileDirectory());
const HEADLESS = arg("--headless", process.env.VTAI_BROWSER_HEADLESS || "0") === "1";
const NO_SANDBOX = process.env.VTAI_BROWSER_NO_SANDBOX === "1";
const NETWORK_POLICY_FLAGS = Object.freeze([
  "--disable-features=WebTransport",
  "--disable-webrtc",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-quic",
]);

let context = null;
let page = null;
let browserSelection = null;
let blockedNavigation = null;
let queue = Promise.resolve();
let server = null;
let stopping = false;
let sessionToken = "";
let proxyToken = "";
let credentialsReady = false;
let activeProxyState = null;

function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  if (!context) throw new Error("browser not launched");
  const pages = context.pages();
  page = pages[0] || (await context.newPage());
  return page;
}

async function installNavigationPolicy(targetContext = context, options = {}) {
  if (
    !targetContext ||
    typeof targetContext.route !== "function" ||
    typeof targetContext.routeWebSocket !== "function"
  ) {
    throw new Error("browser network policy requires request and WebSocket interception");
  }
  const checkTarget = options.checkTarget || runtime.navigationBlocked;
  await targetContext.route("**/*", async (route) => {
    let target = "";
    try {
      target = route.request().url();
    } catch {
    }
    let allowed = runtime.nonNetworkUrl(target);
    if (!allowed) {
      try {
        allowed = !(await checkTarget(target));
      } catch {
        allowed = false;
      }
    }
    if (!target || !allowed) {
      blockedNavigation = runtime.redactNavigationTarget(target);
      try {
        await route.abort("blockedbyclient");
      } catch {
      }
      return;
    }
    try {
      await route.continue();
    } catch {
    }
  });
  await targetContext.routeWebSocket("**/*", async (webSocket) => {
    try {
      await webSocket.close({ code: 1008, reason: "disabled by browser network policy" });
    } catch {
    }
  });
}

function listeningPort() {
  const address = server && server.address();
  return address && typeof address !== "string" ? address.port : 0;
}

function proxyConfiguration(port = listeningPort()) {
  if (!credentialsReady || !sessionToken || !proxyToken || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("browser proxy is not ready");
  }
  return {
    server: `http://127.0.0.1:${port}`,
    username: runtime.PROXY_USERNAME,
    password: proxyToken,
    bypass: "<-loopback>",
  };
}

function buildLaunchArgs(proxyPort, baseArgs = []) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error("browser proxy port is invalid");
  }
  return [
    ...baseArgs,
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ...NETWORK_POLICY_FLAGS,
  ];
}

async function launch({ proxy = proxyConfiguration() } = {}) {
  browserSelection = runtime.resolveBrowser();
  if (!browserSelection.ready) throw new Error(browserSelection.error);
  fs.mkdirSync(PROFILE, { recursive: true });
  const proxyUrl = new URL(proxy.server);
  if (proxyUrl.hostname !== "127.0.0.1") throw new Error("browser proxy must be loopback");
  const args = buildLaunchArgs(Number(proxyUrl.port), [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-pings",
  ]);
  if (NO_SANDBOX) args.push("--no-sandbox");
  context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: browserSelection.path,
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: "block",
    proxy,
    args,
  });
  await installNavigationPolicy();
  page = context.pages()[0] || (await context.newPage());
  return { context, page, browserSelection };
}

function initializeCredentials() {
  if (credentialsReady) return sessionToken;
  sessionToken = runtime.generateSessionToken();
  do {
    proxyToken = runtime.generateSessionToken();
  } while (proxyToken === sessionToken);
  credentialsReady = true;
  return sessionToken;
}

function send(res, code, obj, extraHeaders = {}) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendUnauthorized(res) {
  send(res, 401, { ok: false, error: "unauthorized" });
}

function authorized(req) {
  return credentialsReady && runtime.requestAuthorized(req, sessionToken);
}

function isOriginFormPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

function isAbsoluteForm(value) {
  return typeof value === "string" && /^https?:/i.test(value);
}

function isProxyRequest(req) {
  return Boolean(req && isAbsoluteForm(req.url));
}

function isLoopbackApiRequest(req) {
  if (!isProxyRequest(req)) return false;
  try {
    const parsed = new URL(req.url);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

function proxyError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function proxyFailureStatus(error) {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  if (error && error.code === "PROXY_AUTH") return 407;
  if (error && error.code === "PROXY_CONCURRENCY") return 503;
  if (error && error.code === "PROXY_BODY") return 413;
  if (error && error.code === "PROXY_POLICY") return 403;
  if (error && error.code === "PROXY_REQUEST") return 400;
  return 502;
}

function sendProxyFailure(res, error) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return;
  const status = proxyFailureStatus(error);
  const messages = {
    400: "malformed proxy request",
    403: "proxy target blocked",
    407: "proxy authentication required",
    413: "proxy payload too large",
    503: "proxy capacity exhausted",
    504: "proxy request timed out",
  };
  send(res, status, { ok: false, error: messages[status] || "proxy request failed" }, status === 407 ? {
    "Proxy-Authenticate": 'Basic realm="vtai-browser"',
  } : {});
}

function writeProxyConnectFailure(socket, error) {
  if (!socket || socket.destroyed || socket.writableEnded) return;
  const status = proxyFailureStatus(error);
  const reason = status === 407
    ? "Proxy Authentication Required"
    : status === 503
      ? "Service Unavailable"
      : status === 413
        ? "Payload Too Large"
        : status === 400
          ? "Bad Request"
          : status === 504
            ? "Gateway Timeout"
            : status === 502
              ? "Bad Gateway"
              : "Forbidden";
  const headers = [
    `HTTP/1.1 ${status} ${reason}`,
    "Content-Length: 0",
    "Connection: close",
  ];
  if (status === 407) headers.push('Proxy-Authenticate: Basic realm="vtai-browser"');
  socket.end(`${headers.join("\r\n")}\r\n\r\n`);
}

function createProxyState(options = {}) {
  const requested = Number(options.maxConcurrent || runtime.PROXY_MAX_CONCURRENT);
  return {
    resolver: options.resolver || null,
    connect: options.connect || net.connect,
    request: options.request || ((requestOptions, callback) => {
      const factory = requestOptions.protocol === "https:" ? https.request : http.request;
      return factory(requestOptions, callback);
    }),
    maxConcurrent: Number.isInteger(requested) && requested > 0 ? requested : runtime.PROXY_MAX_CONCURRENT,
    active: 0,
    sockets: new Set(),
  };
}

function acquireProxy(state) {
  if (state.active >= state.maxConcurrent) {
    throw proxyError("PROXY_CONCURRENCY", "proxy capacity exhausted", 503);
  }
  state.active += 1;
}

function releaseProxy(state) {
  if (state.active > 0) state.active -= 1;
}

function headerValue(headers, name) {
  const value = headers && headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function contentLengthValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return Number.NaN;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return Number.NaN;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : Number.NaN;
}

function validateProxyHeaders(req) {
  if (!req || !["1.0", "1.1"].includes(req.httpVersion)) {
    throw proxyError("PROXY_REQUEST", "unsupported proxy request", 400);
  }
  if (req.headers && req.headers.upgrade) {
    throw proxyError("PROXY_REQUEST", "proxy upgrade is not allowed", 400);
  }
  const contentLengthHeader = req.headers && req.headers["content-length"];
  const contentLength = contentLengthValue(contentLengthHeader);
  const transferEncoding = headerValue(req.headers, "transfer-encoding");
  if (contentLengthHeader !== undefined && transferEncoding !== undefined) {
    throw proxyError("PROXY_REQUEST", "ambiguous proxy request body", 400);
  }
  if (contentLengthHeader !== undefined) {
    if (!Number.isSafeInteger(contentLength)) {
      throw proxyError("PROXY_REQUEST", "invalid proxy request length", 400);
    }
    if (contentLength > runtime.PROXY_MAX_BODY_BYTES) {
      throw proxyError("PROXY_BODY", "proxy request body is too large", 413);
    }
  }
}

async function pinnedProxyTarget(req, kind, state) {
  let target;
  try {
    target = kind === "connect" ? runtime.parseConnectTarget(req.url) : runtime.parseProxyTarget(req.url);
  } catch {
    throw proxyError("PROXY_REQUEST", "malformed proxy target", 400);
  }
  let hostHeader;
  try {
    hostHeader = runtime.parseHostHeader(req.headers && req.headers.host);
  } catch {
    throw proxyError("PROXY_REQUEST", "malformed Host header", 400);
  }
  if (!runtime.hostHeaderMatches(target, hostHeader)) {
    throw proxyError("PROXY_POLICY", "proxy target and Host do not match", 403);
  }
  try {
    return await runtime.resolvePinnedTarget(target, { resolver: state.resolver });
  } catch {
    throw proxyError("PROXY_POLICY", "proxy target is not allowed", 403);
  }
}

function sameAddress(left, right) {
  const normalize = (value) => String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  const first = normalize(left);
  const second = normalize(right);
  return Boolean(first && second && first === second);
}

function verifySocketAddress(socket, address, destroy) {
  if (!socket || !socket.remoteAddress) return true;
  if (sameAddress(socket.remoteAddress, address)) return true;
  destroy();
  return false;
}

function connectPinned(state, pinned) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let socket;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        socket?.destroy?.();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const attach = () => {
      if (!socket || typeof socket.once !== "function" || typeof socket.on !== "function") {
        finish(proxyError("PROXY_CONNECTION", "upstream connection failed", 502));
        return;
      }
      const onError = () => finish(proxyError("PROXY_CONNECTION", "upstream connection failed", 502));
      socket.on("error", onError);
      socket.once("connect", () => {
        if (!verifySocketAddress(socket, pinned.address, () => finish(proxyError("PROXY_POLICY", "upstream address mismatch", 403)))) {
          finish(proxyError("PROXY_POLICY", "upstream address mismatch", 403));
          return;
        }
        finish();
      });
      timer = setTimeout(() => finish(proxyError("PROXY_TIMEOUT", "upstream connection timed out", 504)), runtime.PROXY_CONNECT_TIMEOUT_MS);
      if (socket.connecting === false && socket.remoteAddress) {
        if (!verifySocketAddress(socket, pinned.address, () => finish(proxyError("PROXY_POLICY", "upstream address mismatch", 403)))) {
          finish(proxyError("PROXY_POLICY", "upstream address mismatch", 403));
          return;
        }
        finish();
      }
    };
    Promise.resolve()
      .then(() => state.connect({ host: pinned.address, port: pinned.port, family: pinned.family }))
      .then((result) => {
        socket = result;
        attach();
      })
      .catch((error) => finish(error));
  });
}

function requestHeadersForUpstream(req, target) {
  const headers = {};
  const connectionTokens = new Set(
    String(headerValue(req.headers, "connection") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "expect",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [name, value] of Object.entries(req.headers || {})) {
    const lower = name.toLowerCase();
    if (hopByHop.has(lower) || connectionTokens.has(lower) || lower === "host") continue;
    headers[lower] = value;
  }
  headers.host = target.authority;
  return headers;
}

function responseHeadersForClient(headers) {
  const output = {};
  const connectionTokens = new Set(
    String(headerValue(headers, "connection") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "expect",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (hopByHop.has(lower) || connectionTokens.has(lower)) continue;
    output[lower] = value;
  }
  return output;
}

function boundedTransform(limit, onLimit, onChunk) {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      total += size;
      onChunk?.(size);
      if (total > limit) {
        const error = proxyError("PROXY_BODY", "proxy payload is too large", 413);
        onLimit?.(error);
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

function streamRequestBody(req, upstream, onLimit) {
  const limiter = boundedTransform(runtime.PROXY_MAX_BODY_BYTES, onLimit);
  limiter.on("error", () => upstream.destroy());
  req.on("aborted", () => upstream.destroy());
  req.pipe(limiter).pipe(upstream);
}

function streamResponseBody(source, destination, onLimit) {
  const limiter = boundedTransform(runtime.PROXY_MAX_RESPONSE_BYTES, onLimit);
  const fail = () => {
    source.destroy();
    if (!destination.headersSent) destination.destroy();
    else destination.destroy();
  };
  limiter.on("error", fail);
  source.on("aborted", fail);
  destination.on("close", () => source.destroy());
  source.pipe(limiter).pipe(destination);
}

function upstreamSocketError(socket, address, upstream) {
  if (!socket || !socket.remoteAddress) return;
  if (!sameAddress(socket.remoteAddress, address)) upstream.destroy(proxyError("PROXY_POLICY", "upstream address mismatch", 403));
}

async function handleProxyHttp(req, res, state) {
  let acquired = false;
  let released = false;
  let upstream = null;
  let upstreamResponse = null;
  let timer = null;
  const release = () => {
    if (!acquired || released) return;
    released = true;
    if (timer) clearTimeout(timer);
    releaseProxy(state);
  };
  const fail = (error) => {
    if (upstream && !upstream.destroyed) upstream.destroy();
    if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
    sendProxyFailure(res, error);
    if ([400, 413].includes(proxyFailureStatus(error))) res.once?.("finish", () => req.destroy?.());
    release();
  };
  try {
    acquireProxy(state);
    acquired = true;
    if (!runtime.proxyRequestAuthorized(req, proxyToken)) {
      throw proxyError("PROXY_AUTH", "proxy authentication required", 407);
    }
    validateProxyHeaders(req);
    const pinned = await pinnedProxyTarget(req, "request", state);
    const headers = requestHeadersForUpstream(req, pinned);
    const requestOptions = {
      protocol: pinned.protocol,
      hostname: pinned.address,
      host: pinned.address,
      port: pinned.port,
      method: req.method,
      path: pinned.path,
      headers,
      setHost: false,
      maxHeaderSize: runtime.PROXY_MAX_HEADER_BYTES,
      rejectUnauthorized: true,
    };
    if (pinned.protocol === "https:" && net.isIP(pinned.host) === 0) requestOptions.servername = pinned.host;
    timer = setTimeout(() => {
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (!res.headersSent) sendProxyFailure(res, proxyError("PROXY_TIMEOUT", "proxy request timed out", 504));
      release();
    }, runtime.PROXY_REQUEST_TIMEOUT_MS);
    upstream = state.request(requestOptions, (response) => {
      upstreamResponse = response;
      if (released) {
        response.destroy();
        return;
      }
      const declaredHeader = response.headers && response.headers["content-length"];
      const declared = contentLengthValue(declaredHeader);
      if (declaredHeader !== undefined && (!Number.isSafeInteger(declared) || declared > runtime.PROXY_MAX_RESPONSE_BYTES)) {
        fail(proxyError("PROXY_BODY", "proxy response is too large", 413));
        return;
      }
      const responseHeaders = responseHeadersForClient(response.headers);
      if (res.destroyed || res.writableEnded) {
        response.destroy();
        release();
        return;
      }
      res.writeHead(response.statusCode || 502, responseHeaders);
      response.on("aborted", () => {
        if (!res.writableEnded) res.destroy();
        release();
      });
      response.on("end", release);
      response.on("error", () => {
        if (!res.writableEnded) res.destroy();
        release();
      });
      streamResponseBody(response, res, () => {
        if (!res.headersSent) sendProxyFailure(res, proxyError("PROXY_BODY", "proxy response is too large", 413));
        else res.destroy();
      });
    });
    if (!upstream || typeof upstream.once !== "function") {
      throw proxyError("PROXY_CONNECTION", "upstream request failed", 502);
    }
    upstream.once("socket", (socket) => {
      if (socket) {
        state.sockets.add(socket);
        socket.once("close", () => state.sockets.delete(socket));
        const checkAddress = () => upstreamSocketError(socket, pinned.address, upstream);
        socket.once("connect", checkAddress);
        checkAddress();
      }
    });
    upstream.once("error", (error) => {
      if (!res.headersSent) fail(proxyError("PROXY_CONNECTION", "upstream request failed", 502));
      else {
        res.destroy();
        release();
      }
    });
    upstream.once("close", release);
    req.once("aborted", () => upstream.destroy());
    res.once("close", () => {
      if (upstream && !upstream.destroyed && !res.writableEnded) upstream.destroy();
      release();
    });
    streamRequestBody(req, upstream, (error) => {
      if (!res.headersSent) sendProxyFailure(res, error);
      else res.destroy();
    });
  } catch (error) {
    fail(error);
  }
}

function destroyTunnelPair(pair) {
  for (const socket of [pair.client, pair.upstream]) {
    if (socket && !socket.destroyed) socket.destroy();
  }
}

function tunnelDirection(source, destination, pair, counter) {
  const limiter = boundedTransform(
    runtime.PROXY_TUNNEL_MAX_BYTES,
    () => destroyTunnelPair(pair),
    (size) => {
      counter.bytes += size;
      if (counter.bytes > runtime.PROXY_TUNNEL_MAX_BYTES) destroyTunnelPair(pair);
    },
  );
  limiter.on("error", () => destroyTunnelPair(pair));
  source.on("error", () => destroyTunnelPair(pair));
  destination.on("error", () => destroyTunnelPair(pair));
  source.pipe(limiter).pipe(destination, { end: false });
}

function establishTunnel(clientSocket, upstreamSocket, head, state, release) {
  state.sockets.add(clientSocket);
  state.sockets.add(upstreamSocket);
  const counter = { bytes: 0 };
  const pair = { client: clientSocket, upstream: upstreamSocket };
  const finish = () => {
    for (const socket of [clientSocket, upstreamSocket]) {
      socket.removeAllListeners("close");
      state.sockets.delete(socket);
    }
    if (timer) clearTimeout(timer);
    destroyTunnelPair(pair);
    release();
  };
  const timer = setTimeout(() => destroyTunnelPair(pair), runtime.PROXY_TUNNEL_TIMEOUT_MS);
  clientSocket.once("close", finish);
  upstreamSocket.once("close", finish);
  clientSocket.setTimeout?.(runtime.PROXY_TUNNEL_TIMEOUT_MS, () => destroyTunnelPair(pair));
  upstreamSocket.setTimeout?.(runtime.PROXY_TUNNEL_TIMEOUT_MS, () => destroyTunnelPair(pair));
  if (head && head.length) {
    counter.bytes += head.length;
    if (counter.bytes > runtime.PROXY_TUNNEL_MAX_BYTES) {
      destroyTunnelPair(pair);
      release();
      return;
    }
    upstreamSocket.write(head);
  }
  tunnelDirection(upstreamSocket, clientSocket, pair, counter);
  tunnelDirection(clientSocket, upstreamSocket, pair, counter);
}

async function handleProxyConnect(req, clientSocket, head, state) {
  let acquired = false;
  let released = false;
  let upstreamSocket = null;
  const release = () => {
    if (!acquired || released) return;
    released = true;
    state.sockets.delete(clientSocket);
    if (upstreamSocket) state.sockets.delete(upstreamSocket);
    releaseProxy(state);
  };
  try {
    acquireProxy(state);
    acquired = true;
    state.sockets.add(clientSocket);
    if (!runtime.proxyRequestAuthorized(req, proxyToken)) {
      throw proxyError("PROXY_AUTH", "proxy authentication required", 407);
    }
    validateProxyHeaders(req);
    const pinned = await pinnedProxyTarget(req, "connect", state);
    upstreamSocket = await connectPinned(state, pinned);
    if (clientSocket.destroyed) {
      upstreamSocket.destroy();
      release();
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    establishTunnel(clientSocket, upstreamSocket, head, state, release);
  } catch (error) {
    if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
    writeProxyConnectFailure(clientSocket, error);
    release();
  }
}

function handleUpgrade(req, socket) {
  socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

function handleClientError(error, socket) {
  if (!socket || socket.destroyed) return;
  if (error && ["ECONNRESET", "EPIPE"].includes(error.code)) {
    socket.destroy();
    return;
  }
  socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

async function snapshotImpl() {
  const current = await ensurePage();
  const data = await current.evaluate(() => {
    const selector = "a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox]";
    const elements = Array.from(document.querySelectorAll(selector)).slice(0, 120);
    const output = [];
    for (const [index, element] of elements.entries()) {
      element.setAttribute("data-vtai-ref", String(index));
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const tag = element.tagName.toLowerCase();
      const inputType = String(element.getAttribute("type") || "").toLowerCase();
      const name = [
        element.getAttribute("aria-label"),
        element.getAttribute("aria-labelledby"),
        element.getAttribute("name"),
        element.getAttribute("placeholder"),
        element.getAttribute("title"),
        element.innerText,
        element.getAttribute("href"),
        element.tagName,
      ]
        .find((value) => value != null && String(value).trim() !== "")
        ?.toString()
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 100) || "element";
      const item = { ref: index, tag, name };
      if (tag === "a") item.href = (element.getAttribute("href") || "").slice(0, 200);
      if (tag === "input") item.inputType = inputType || "text";
      if ((tag === "input" || tag === "textarea" || tag === "select") && String(element.value || "").trim() !== "") {
        item.value = inputType === "password" || inputType === "hidden" ? "[redacted]" : "[value hidden]";
      }
      output.push(item);
    }
    return {
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : "").slice(0, 4000),
      elements: output,
    };
  });
  return runtime.sanitizeSnapshot(data);
}

async function handle(req, res, options = {}) {
  const loopbackApiRequest = isLoopbackApiRequest(req);
  if (isProxyRequest(req) && !loopbackApiRequest) {
    await handleProxyHttp(req, res, options.proxyState || activeProxyState || createProxyState());
    return;
  }
  if (!loopbackApiRequest && !isOriginFormPath(req && req.url)) {
    send(res, 400, { ok: false, error: "invalid request path" });
    return;
  }
  if (!authorized(req)) {
    sendUnauthorized(res);
    return;
  }
  const requestUrl = loopbackApiRequest ? new URL(req.url) : new URL(req.url, "http://127.0.0.1");
  if (
    req.method === "GET" &&
    ["/status", "/preflight", "/probe", "/ready", "/readiness"].includes(requestUrl.pathname)
  ) {
    let pageUrl = null;
    if (context) {
      try {
        pageUrl = (await ensurePage()).url();
      } catch {
      }
    }
    send(
      res,
      200,
      runtime.statusPayload({
        port: listeningPort(),
        running: !!context,
        headless: HEADLESS,
        pageUrl,
        blockedTarget: blockedNavigation,
        browser: browserSelection || runtime.resolveBrowser(),
        profilePath: PROFILE,
      }),
    );
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/navigate") {
    const body = await runtime.readBody(req);
    if (typeof body.url !== "string" || !body.url) {
      send(res, 400, { ok: false, error: "url required" });
      return;
    }
    if (runtime.navigationBlocked(body.url)) {
      send(res, 403, { ok: false, error: "refused (private/loopback target)" });
      return;
    }
    const result = await serial(async () => {
      const current = await ensurePage();
      blockedNavigation = null;
      try {
        await current.goto(body.url, { waitUntil: "domcontentloaded", timeout: 25000 });
      } catch (error) {
        if (blockedNavigation) {
          throw new Error(`navigation blocked by private/loopback policy: ${blockedNavigation}`);
        }
        throw error;
      }
      return { ok: true, url: current.url(), title: await current.title() };
    });
    send(res, 200, result);
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/snapshot") {
    const result = await serial(async () => ({ ok: true, ...(await snapshotImpl()) }));
    send(res, 200, result);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/click") {
    const body = await runtime.readBody(req);
    if (body.ref === undefined) {
      send(res, 400, { ok: false, error: "ref required" });
      return;
    }
    const result = await serial(async () => {
      const current = await ensurePage();
      await current.click(`[data-vtai-ref="${body.ref}"]`, { timeout: 8000 });
      return { ok: true, url: current.url() };
    });
    send(res, 200, result);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/type") {
    const body = await runtime.readBody(req);
    if (body.ref === undefined || body.text === undefined) {
      send(res, 400, { ok: false, error: "ref and type required" });
      return;
    }
    const result = await serial(async () => {
      const current = await ensurePage();
      const selector = `[data-vtai-ref="${body.ref}"]`;
      await current.fill(selector, body.text, { timeout: 8000 });
      if (body.submit) await current.press(selector, "Enter");
      return { ok: true, url: current.url() };
    });
    send(res, 200, result);
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/screenshot") {
    const result = await serial(async () => {
      const current = await ensurePage();
      const buffer = await current.screenshot({ type: "jpeg", quality: 65 });
      return {
        ok: true,
        url: current.url(),
        imageBase64: buffer.toString("base64"),
        mimeType: "image/jpeg",
      };
    });
    send(res, 200, result);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/scroll") {
    const body = await runtime.readBody(req);
    const result = await serial(async () => {
      const current = await ensurePage();
      await current.evaluate(
        ({ dx, dy }) => window.scrollBy(dx || 0, dy || 600),
        { dx: body.dx || 0, dy: body.dy ?? 600 },
      );
      return { ok: true };
    });
    send(res, 200, result);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/back") {
    const result = await serial(async () => {
      const current = await ensurePage();
      blockedNavigation = null;
      try {
        await current.goBack({ timeout: 10000 });
      } catch (error) {
        if (blockedNavigation) {
          throw new Error(`navigation blocked by private/loopback policy: ${blockedNavigation}`);
        }
        throw error;
      }
      return { ok: true, url: current.url() };
    });
    send(res, 200, result);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/shutdown") {
    send(res, 200, { ok: true });
    setImmediate(() => {
      void shutdown();
    });
    return;
  }
  send(res, 404, { ok: false, error: "not found" });
}

function createRequestServer(options = {}) {
  const state = createProxyState(options);
  const instance = http.createServer(
    {
      maxHeaderSize: runtime.PROXY_MAX_HEADER_BYTES,
      maxHeadersCount: 100,
      requestTimeout: runtime.PROXY_REQUEST_TIMEOUT_MS,
      headersTimeout: Math.min(runtime.PROXY_REQUEST_TIMEOUT_MS, 10000),
      keepAliveTimeout: 5000,
    },
    (req, res) => {
      handle(req, res, { proxyState: state }).catch((error) => {
        const status = error && error.statusCode === 413 ? 413 : error instanceof SyntaxError ? 400 : 500;
        send(res, status, {
          ok: false,
          error: runtime.safeErrorMessage(error),
        });
      });
    },
  );
  instance.proxyState = state;
  activeProxyState = state;
  instance.maxConnections = runtime.PROXY_MAX_CONCURRENT * 2;
  instance.maxRequestsPerSocket = 100;
  instance.on("connect", (req, socket, head) => {
    activeProxyState = state;
    handleProxyConnect(req, socket, head, state).catch(() => {
      writeProxyConnectFailure(socket, proxyError("PROXY_CONNECTION", "proxy request failed", 502));
    });
  });
  instance.on("upgrade", handleUpgrade);
  instance.on("clientError", handleClientError);
  return instance;
}

function listenOnLoopback(instance) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      instance.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      instance.removeListener("error", onError);
      const address = instance.address();
      if (!address || typeof address === "string") {
        reject(new Error("browser sidecar did not receive a loopback port"));
        return;
      }
      resolve(address.port);
    };
    instance.once("error", onError);
    instance.once("listening", onListening);
    instance.listen(0, "127.0.0.1");
  });
}

function writeIpc(output, value) {
  return new Promise((resolve, reject) => {
    if (!output || typeof output.write !== "function" || output.isTTY) {
      reject(new Error("browser sidecar IPC is unavailable"));
      return;
    }
    output.write(`${JSON.stringify(value)}\n`, "utf8", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function installIpcCommands(input = process.stdin) {
  if (!input || typeof input.on !== "function") return;
  let buffer = "";
  input.setEncoding?.("utf8");
  input.on("end", () => {
    void shutdown();
  });
  input.on("data", (chunk) => {
    buffer += String(chunk);
    if (buffer.length > 8192) buffer = buffer.slice(-8192);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          if (message && message.type === "shutdown") void shutdown();
        } catch {
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  input.resume?.();
}

async function startServer({ launchBrowser = launch, ipc = process.stdout, ...proxyOptions } = {}) {
  if (stopping) stopping = false;
  initializeCredentials();
  server = createRequestServer(proxyOptions);
  activeProxyState = server.proxyState;
  try {
    await listenOnLoopback(server);
    const port = listeningPort();
    const proxy = proxyConfiguration(port);
    const launched = await launchBrowser({ port, proxy });
    if (launched && typeof launched === "object") {
      context = launched.context || context;
      page = launched.page || page;
      browserSelection = launched.browserSelection || browserSelection;
    }
    await writeIpc(ipc, { type: "ready", port, token: sessionToken });
    if (require.main === module) installIpcCommands();
    return { port, token: sessionToken, server };
  } catch (error) {
    await shutdown({ exit: false });
    throw error;
  }
}

async function preflightMain() {
  const result = runtime.preflight({ env: process.env, port: 0 });
  result.runtime = {
    ready: true,
    source: process.env.VTAI_BROWSER_NODE_SOURCE || "bundled",
    path: process.env.VTAI_BROWSER_NODE_PATH || "node",
  };
  result.node = result.runtime;
  result.profilePath = PROFILE;
  result.baseUrl = null;
  result.port = null;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ready) process.exitCode = 2;
}

async function startMain() {
  await startServer();
}

async function closeWithTimeout(close, timeout = 2000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
  } catch {
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shutdown({ exit = require.main === module } = {}) {
  if (stopping) return;
  stopping = true;
  credentialsReady = false;
  sessionToken = "";
  proxyToken = "";
  const activeContext = context;
  context = null;
  page = null;
  const activeServer = server;
  const activeState = activeProxyState;
  server = null;
  activeProxyState = null;
  if (activeState) {
    for (const socket of activeState.sockets) {
      if (socket && !socket.destroyed) socket.destroy();
    }
  }
  if (activeContext) await closeWithTimeout(() => activeContext.close());
  if (activeServer) {
    await closeWithTimeout(
      () =>
        new Promise((resolve) => {
          if (!activeServer.listening) {
            resolve();
            return;
          }
          activeServer.close(() => resolve());
          activeServer.closeAllConnections?.();
        }),
    );
  }
  blockedNavigation = null;
  queue = Promise.resolve();
  stopping = false;
  if (exit) process.exit(0);
}

if (require.main === module) {
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  if (process.argv.includes("--preflight")) {
    preflightMain().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } else {
    startMain().catch(async (error) => {
      process.stderr.write(`browser launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
      await shutdown({ exit: false });
      process.exitCode = 1;
    });
  }
}

module.exports = {
  NETWORK_POLICY_FLAGS,
  authorized,
  buildLaunchArgs,
  createRequestServer,
  handle,
  installNavigationPolicy,
  initializeCredentials,
  launch,
  proxyConfiguration,
  shutdown,
  startServer,
};
