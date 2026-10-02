const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Readable } = require("node:stream");
const {
  PROXY_USERNAME,
  SESSION_TOKEN_BYTES,
  commonBrowserCandidates,
  constantTimeEqual,
  generateSessionToken,
  navigationBlocked,
  networkTargetBlocked,
  parseConnectTarget,
  parseHostHeader,
  parseProxyTarget,
  profileDirectory,
  proxyRequestAuthorized,
  redactNavigationTarget,
  readBody,
  requestAuthorized,
  resolveBrowser,
  resolvePinnedTarget,
  sanitizeSnapshot,
  statusPayload,
} = require("./runtime");

function request(chunks, headers = {}) {
  const stream = Readable.from(chunks);
  stream.headers = headers;
  return stream;
}

test("Windows resolution finds the system Edge before Playwright", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  };
  const edge = commonBrowserCandidates("win32", env).find((candidate) => candidate.channel === "msedge");
  assert.ok(edge);
  const result = resolveBrowser({
    platform: "win32",
    env,
    exists: (file) => file === edge.file,
    chromium: { executablePath: () => "/should/not/be/used" },
  });
  assert.equal(result.ready, true);
  assert.equal(result.channel, "msedge");
  assert.equal(result.path, edge.file);
});

test("VTAI_BROWSER_CHROME is checked before common locations", () => {
  // resolveBrowser path.resolve()s the override against the real OS, so the
  // expected path has to be resolved the same way or this breaks on Windows.
  const override = path.resolve("/custom/browser");
  const env = {
    VTAI_BROWSER_CHROME: "/custom/browser",
    ProgramFiles: "/not-used",
  };
  const result = resolveBrowser({
    platform: "linux",
    env,
    exists: (file) => file === override,
  });
  assert.equal(result.source, "VTAI_BROWSER_CHROME");
  assert.equal(result.ready, true);
  assert.equal(result.path, override);
});

test("status separates the sidecar endpoint from the page URL", () => {
  const result = statusPayload({
    port: 40123,
    running: true,
    pageUrl: "https://example.test:8443/account",
  });
  assert.equal(result.baseUrl, "http://127.0.0.1:40123");
  assert.equal(result.port, 40123);
  assert.equal(result.pageUrl, "https://example.test:8443/account");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "url"), false);
});

test("session credentials are random and bearer checks fail closed", () => {
  const first = generateSessionToken();
  const second = generateSessionToken();
  assert.equal(first.length, SESSION_TOKEN_BYTES * 2);
  assert.notEqual(first, second);
  assert.equal(constantTimeEqual(first, first), true);
  assert.equal(constantTimeEqual(first, second), false);
  assert.equal(constantTimeEqual(first, `${first}x`), false);
  assert.equal(requestAuthorized({ headers: { "x-vtai-token": first } }, first), true);
  assert.equal(requestAuthorized({ headers: { authorization: `Bearer ${first}` } }, first), true);
  assert.equal(requestAuthorized({ headers: {} }, first), false);
  assert.equal(requestAuthorized({ headers: { "x-vtai-token": second } }, first), false);
});

test("proxy authentication is separate from sidecar bearer authentication", () => {
  const token = generateSessionToken();
  const headers = { "proxy-authorization": `Basic ${Buffer.from(`${PROXY_USERNAME}:${token}`).toString("base64")}` };
  assert.equal(proxyRequestAuthorized({ headers }, token), true);
  assert.equal(proxyRequestAuthorized({ headers: { authorization: `Bearer ${token}` } }, token), false);
  assert.equal(proxyRequestAuthorized({ headers: { "x-vtai-token": token } }, token), false);
  assert.equal(proxyRequestAuthorized({ headers: { "proxy-authorization": "Basic malformed" } }, token), false);
});

test("proxy targets require matching Host and pin one validated address", async () => {
  const target = parseProxyTarget("https://public.example:443/path");
  assert.equal(target.authority, "public.example");
  assert.equal(parseConnectTarget("public.example:443").port, 443);
  assert.equal(parseHostHeader("public.example:443").host, "public.example");
  let calls = 0;
  const pinned = await resolvePinnedTarget(target, {
    resolver: async () => {
      calls += 1;
      return ["93.184.216.34"];
    },
  });
  assert.equal(pinned.address, "93.184.216.34");
  assert.equal(calls, 1);
  await assert.rejects(
    resolvePinnedTarget(target, { resolver: async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] }),
    /mixed address families/,
  );
  await assert.rejects(resolvePinnedTarget(target, { resolver: async () => ["10.0.0.7"] }), /disallowed/);
});

test("request bodies are bounded before JSON parsing", async () => {
  await assert.rejects(
    readBody(request([Buffer.alloc(8, 97)], { "content-length": "9" }), 8),
    (error) => error.statusCode === 413,
  );
  await assert.rejects(
    readBody(request([Buffer.alloc(4, 97), Buffer.alloc(5, 98)]), 8),
    (error) => error.statusCode === 413,
  );
  assert.deepEqual(await readBody(request([Buffer.from('{"ok":true}')])), { ok: true });
});

test("snapshot masking removes sensitive values", () => {
  const result = sanitizeSnapshot({
    text: "The secret is hunter2",
    elements: [
      { tag: "input", inputType: "password", name: "hunter2", value: "hunter2" },
      { tag: "input", inputType: "text", name: "Search", value: "private-value" },
    ],
  });
  assert.equal(result.elements[0].value, "[redacted]");
  assert.equal(result.elements[0].name.includes("hunter2"), false);
  assert.equal(result.elements[1].value, "[value hidden]");
  assert.equal(result.text.includes("hunter2"), false);
  assert.equal(JSON.stringify(result).includes("private-value"), false);
});

test("navigation policy blocks private and loopback redirect targets", () => {
  assert.equal(navigationBlocked("https://example.com/"), false);
  assert.equal(navigationBlocked("https://127.0.0.1:9443/"), true);
  assert.equal(navigationBlocked("https://[::1]/"), true);
  assert.equal(navigationBlocked("https://169.254.169.254/"), true);
  assert.equal(redactNavigationTarget("https://127.0.0.1:9443/callback?token=secret"), "https://127.0.0.1:9443/callback");
});

test("network policy resolves all public DNS answers and blocks private DNS answers", async () => {
  const publicResolver = {
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ],
    resolveAny: async () => [
      { type: "A", address: "93.184.216.34" },
      { type: "AAAA", address: "2606:2800:220:1:248:1893:25c8:1946" },
    ],
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => ["2606:2800:220:1:248:1893:25c8:1946"],
  };
  assert.equal(await networkTargetBlocked("https://public.example/", { resolver: publicResolver }), false);
  const privateResolver = {
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ],
    resolveAny: async () => [
      { type: "A", address: "93.184.216.34" },
      { type: "A", address: "10.0.0.7" },
    ],
    resolve4: async () => ["93.184.216.34", "10.0.0.7"],
    resolve6: async () => {
      const error = new Error("no AAAA");
      error.code = "ENODATA";
      throw error;
    },
  };
  assert.equal(await networkTargetBlocked("https://private.example/", { resolver: privateResolver }), true);
  assert.equal(await navigationBlocked("https://private.example/", { resolver: privateResolver }), true);
  assert.equal(
    await networkTargetBlocked("https://ipv6.example/", {
      resolver: async () => ["fc00::1"],
    }),
    true,
  );
  assert.equal(
    await networkTargetBlocked("https://unresolved.example/", {
      resolver: async () => [],
    }),
    true,
  );
  let answer = 0;
  assert.equal(
    await networkTargetBlocked("https://rebind.example/", {
      resolver: async () => [answer++ === 0 ? "93.184.216.34" : "10.0.0.8"],
    }),
    true,
  );
});

test("network policy covers private literals and WebSocket schemes", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:10.0.0.1]/",
    "ws://127.0.0.1:9222/",
    "wss://169.254.169.254/",
  ]) {
    assert.equal(await networkTargetBlocked(url), true, url);
  }
  assert.equal(
    await networkTargetBlocked("wss://public.example/", { resolver: async () => ["93.184.216.34"] }),
    false,
  );
});

test("profile paths use native platform locations", () => {
  assert.match(profileDirectory({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } }), /VTNexa[\\/]browser-profile$/);
  assert.match(profileDirectory({ platform: "darwin", env: {}, home: "/Users/test" }), /Library[\\/]Application Support[\\/]VTNexa[\\/]browser-profile$/);
  assert.match(profileDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, home: "/home/test" }), /data[\\/]VTNexa[\\/]browser-profile$/);
});
