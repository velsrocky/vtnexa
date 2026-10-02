const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const {
  PROXY_MAX_BODY_BYTES,
  PROXY_USERNAME,
  constantTimeEqual,
  resolvePinnedTarget,
} = require("./runtime");
const {
  NETWORK_POLICY_FLAGS,
  buildLaunchArgs,
  createRequestServer,
  initializeCredentials,
  installNavigationPolicy,
  proxyConfiguration,
  shutdown,
  startServer,
} = require("./server");

function listen(instance) {
  return new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address();
      resolve(typeof address === "string" ? 0 : address.port);
    });
  });
}

function close(instance) {
  return new Promise((resolve) => {
    if (!instance.listening) {
      resolve();
      return;
    }
    instance.close(() => resolve());
    instance.closeAllConnections?.();
  });
}

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function ipcCollector() {
  const chunks = [];
  return {
    write(value, encoding, callback) {
      chunks.push(String(value));
      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

function basicProxy(token, username = PROXY_USERNAME) {
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

function fakeHttpUpstream(responseBody = "public response") {
  const calls = [];
  const factory = (options, callback) => {
    calls.push(options);
    const upstream = new PassThrough();
    upstream.once("finish", () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.statusMessage = "OK";
      response.headers = { "content-type": "text/plain", "content-length": String(Buffer.byteLength(responseBody)) };
      callback(response);
      response.end(responseBody);
    });
    return upstream;
  };
  return { factory, calls };
}

function fakeTunnelConnect(address = "93.184.216.34") {
  const calls = [];
  const sockets = [];
  const connect = (options) => {
    calls.push(options);
    const socket = new PassThrough();
    socket.remoteAddress = address;
    sockets.push(socket);
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
  return { connect, calls, sockets };
}

function proxyRequest(port, path, token, headers = {}) {
  return request(port, path, {
    ...headers,
    "Proxy-Authorization": basicProxy(token),
  });
}

function proxyBodyRequest(port, path, token, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...headers,
          "Proxy-Authorization": basicProxy(token),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function connectRequest(port, authority, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    let response = Buffer.alloc(0);
    const finish = () => {
      const marker = response.indexOf(Buffer.from("\r\n\r\n"));
      if (marker < 0) return;
      socket.removeListener("data", onData);
      resolve({
        socket,
        header: response.subarray(0, marker + 4).toString("utf8"),
        body: response.subarray(marker + 4),
      });
    };
    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      response = Buffer.concat(chunks);
      finish();
    };
    socket.once("error", reject);
    socket.on("data", onData);
    socket.on("connect", () => {
      const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${headers.Host || authority}\r\nProxy-Authorization: ${basicProxy(token)}\r\n${extra}Connection: keep-alive\r\n\r\n`,
      );
    });
  });
}

function fakeBrowser() {
  let closed = false;
  const navigations = [];
  const page = {
    isClosed: () => closed,
    url: () => "https://example.test/account",
    title: async () => "Protected account",
    goto: async (url) => {
      navigations.push(url);
    },
    evaluate: async () => ({
      url: "https://example.test/account",
      title: "Protected account",
      text: "protected page content",
      elements: [],
    }),
  };
  const context = {
    pages: () => [page],
    close: async () => {
      closed = true;
    },
  };
  return {
    context,
    page,
    navigations,
    browserSelection: { ready: true, engine: "chromium", channel: "test", path: "/test/chromium" },
  };
}

test("sidecar authenticates an ephemeral child-owned endpoint", async () => {
  const foreign = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("foreign content");
  });
  const foreignPort = await listen(foreign);
  let foreignRequests = 0;
  foreign.on("request", () => {
    foreignRequests += 1;
  });

  const pending = createRequestServer();
  const pendingPort = await listen(pending);
  for (const path of ["/status", "/preflight", "/probe"]) {
    const beforeCredentials = await request(pendingPort, path);
    assert.equal(beforeCredentials.status, 401);
    assert.equal(beforeCredentials.body, JSON.stringify({ ok: false, error: "unauthorized" }));
    assert.equal(beforeCredentials.body.includes("foreign content"), false);
  }
  await close(pending);

  const ipc = ipcCollector();
  const browser = fakeBrowser();
  let launchInput;
  let launchProbe;
  const started = await startServer({
    requestedPort: foreignPort,
    launchBrowser: async (input) => {
      launchInput = input;
      launchProbe = await request(input.port, "/status");
      return browser;
    },
    ipc,
  });
  const handshake = JSON.parse(ipc.text());
  assert.equal(handshake.type, "ready");
  assert.equal(handshake.port, started.port);
  assert.notEqual(handshake.port, foreignPort);
  assert.equal(typeof handshake.token, "string");
  assert.equal(handshake.token.length, 64);
  assert.equal(launchInput.port, started.port);
  assert.equal(launchInput.proxy.server, `http://127.0.0.1:${started.port}`);
  assert.equal(launchInput.proxy.username, PROXY_USERNAME);
  assert.equal(typeof launchInput.proxy.password, "string");
  assert.equal(launchInput.proxy.password.length, 64);
  assert.notEqual(launchInput.proxy.password, handshake.token);
  assert.equal(ipc.text().includes(launchInput.proxy.password), false);
  assert.equal(launchProbe.status, 401);
  assert.equal(ipc.text().includes("foreign content"), false);
  assert.equal(foreignRequests, 0);
  const launchArgs = buildLaunchArgs(started.port, []);
  assert.equal(launchArgs.some((value) => value.includes(handshake.token)), false);
  for (const expected of [
    "--disable-features=WebTransport",
    "--disable-quic",
    "--disable-webrtc",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ]) {
    assert.equal(launchArgs.includes(expected), true, expected);
  }
  assert.equal(launchArgs.some((value) => value.includes("WebTransport")), true);
  assert.equal(launchArgs.some((value) => value.includes("host-resolver-rules")), true);

  const valid = await request(started.port, "/snapshot", { "x-vtai-token": handshake.token });
  assert.equal(valid.status, 200);
  assert.match(valid.body, /protected page content/);
  assert.equal(valid.body.includes(handshake.token), false);
  const navigated = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: started.port,
        path: "/navigate",
        method: "POST",
        headers: {
          "x-vtai-token": handshake.token,
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ url: "https://public.example/start" }));
  });
  assert.equal(navigated.status, 200);
  assert.deepEqual(browser.navigations, ["https://public.example/start"]);

  for (const invalid of ["", "0".repeat(64), `${handshake.token}x`, handshake.token.slice(0, -1)]) {
    const response = await request(started.port, "/status", { "x-vtai-token": invalid });
    assert.equal(response.status, 401);
    assert.equal(response.body, JSON.stringify({ ok: false, error: "unauthorized" }));
  }
  assert.equal(constantTimeEqual(handshake.token, handshake.token), true);
  assert.equal(constantTimeEqual(handshake.token, `${handshake.token}x`), false);
  assert.equal(constantTimeEqual(handshake.token, handshake.token.slice(0, -1)), false);
  const proxyOnlyApi = await request(started.port, "/status", {
    "Proxy-Authorization": basicProxy(launchInput.proxy.password),
  });
  assert.equal(proxyOnlyApi.status, 401);
  const proxyAsApiBearer = await request(started.port, "/status", {
    Authorization: `Bearer ${launchInput.proxy.password}`,
  });
  assert.equal(proxyAsApiBearer.status, 401);
  const absoluteApi = await request(started.port, `http://127.0.0.1:${started.port}/status`, {
    Authorization: `Bearer ${handshake.token}`,
  });
  assert.equal(absoluteApi.status, 200);
  const bearerOnlyProxy = await request(started.port, "http://public.example/", {
    Authorization: `Bearer ${handshake.token}`,
  });
  assert.equal(bearerOnlyProxy.status, 407);

  const startedAt = Date.now();
  await shutdown({ exit: false });
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(started.server.listening, false);
  await close(foreign);
});

test("network policy intercepts fetch, subresources, redirects, and WebSockets", async () => {
  let routeHandler;
  let socketHandler;
  const context = {
    route: async (_pattern, handler) => {
      routeHandler = handler;
    },
    routeWebSocket: async (_pattern, handler) => {
      socketHandler = handler;
    },
  };
  await installNavigationPolicy(context, {
    checkTarget: async (target) => target.includes("private") || target.includes("127.0.0.1"),
  });
  assert.equal(typeof routeHandler, "function");
  assert.equal(typeof socketHandler, "function");

  function requestRoute(url, resourceType, navigation = false) {
    let action = "pending";
    return {
      action: () => action,
      request: () => ({
        url: () => url,
        resourceType: () => resourceType,
        isNavigationRequest: () => navigation,
      }),
      abort: async () => {
        action = "aborted";
      },
      continue: async () => {
        action = "continued";
      },
    };
  }

  for (const resourceType of ["fetch", "xhr", "image", "script", "stylesheet", "iframe", "other"]) {
    const route = requestRoute("https://public.example/resource", resourceType);
    await routeHandler(route);
    assert.equal(route.action(), "continued", resourceType);
  }
  const blockedImage = requestRoute("https://private.example/image.png", "image");
  await routeHandler(blockedImage);
  assert.equal(blockedImage.action(), "aborted");
  const publicNavigation = requestRoute("https://public.example/start", "document", true);
  await routeHandler(publicNavigation);
  assert.equal(publicNavigation.action(), "continued");
  const redirected = requestRoute("https://private.example/redirect-target", "document", true);
  await routeHandler(redirected);
  assert.equal(redirected.action(), "aborted");

  let connected = 0;
  let closed = 0;
  const socket = (url) => ({
    url: () => url,
    connectToServer: async () => {
      connected += 1;
    },
    close: async () => {
      closed += 1;
    },
  });
  await socketHandler(socket("wss://public.example/socket"));
  await socketHandler(socket("wss://private.example/socket"));
  assert.equal(connected, 0);
  assert.equal(closed, 2);
});

test("proxy HTTP requests resolve once and connect to the validated address", async () => {
  initializeCredentials();
  let resolverCalls = 0;
  const upstream = fakeHttpUpstream("pinned response");
  const instance = createRequestServer({
    resolver: async () => {
      resolverCalls += 1;
      return ["93.184.216.34"];
    },
    request: upstream.factory,
  });
  const port = await listen(instance);
  const token = proxyConfiguration(port).password;
  try {
    const response = await proxyRequest(port, "http://public.example/start", token, {
      Host: "public.example",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, "pinned response");
    assert.equal(resolverCalls, 1);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].hostname, "93.184.216.34");
    assert.equal(upstream.calls[0].host, "93.184.216.34");
    assert.equal(upstream.calls[0].headers.host, "public.example");
    assert.equal(upstream.calls[0].headers["proxy-authorization"], undefined);
    const secure = await proxyRequest(port, "https://public.example/secure", token, {
      Host: "public.example",
    });
    assert.equal(secure.status, 200);
    assert.equal(upstream.calls[1].protocol, "https:");
    assert.equal(upstream.calls[1].servername, "public.example");
    assert.equal(upstream.calls[1].hostname, "93.184.216.34");
    assert.equal(upstream.calls[1].headers.host, "public.example");

    for (const path of [
      "http://public.example/redirect-target",
      "http://public.example/app.js",
      "http://public.example/image.png",
    ]) {
      const next = await proxyRequest(port, path, token, { Host: "public.example" });
      assert.equal(next.status, 200);
    }
    assert.equal(resolverCalls, 5);
    assert.equal(upstream.calls.length, 5);
    assert.ok(upstream.calls.every((call) => call.hostname === "93.184.216.34"));

    const mismatch = await proxyRequest(port, "http://public.example/mismatch", token, {
      Host: "other.example",
    });
    assert.equal(mismatch.status, 403);
    assert.equal(resolverCalls, 5);
    assert.equal(upstream.calls.length, 5);
  } finally {
    await close(instance);
  }
});

test("proxy rejects mixed and private DNS answers before any upstream connect", async () => {
  initializeCredentials();
  for (const answers of [
    ["93.184.216.34", "10.0.0.7"],
    ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    ["127.0.0.1"],
  ]) {
    const upstream = fakeHttpUpstream();
    const instance = createRequestServer({
      resolver: async () => answers,
      request: upstream.factory,
    });
    const port = await listen(instance);
    const token = proxyConfiguration(port).password;
    const response = await proxyRequest(port, "http://private.example/", token, {
      Host: "private.example",
    });
    assert.equal(response.status, 403, answers.join(","));
    assert.equal(upstream.calls.length, 0, answers.join(","));
    await close(instance);
  }
});

test("HTTPS CONNECT rejects private DNS before opening a tunnel", async () => {
  initializeCredentials();
  const tunnel = fakeTunnelConnect();
  const instance = createRequestServer({
    resolver: async () => ["10.0.0.9"],
    connect: tunnel.connect,
  });
  const port = await listen(instance);
  const token = proxyConfiguration(port).password;
  const response = await connectRequest(port, "private.example:443", token);
  assert.match(response.header, /^HTTP\/1\.1 403/);
  response.socket.destroy();
  assert.equal(tunnel.calls.length, 0);
  await close(instance);
});

test("proxy authentication, target binding, and payload limits fail before connect", async () => {
  initializeCredentials();
  let resolverCalls = 0;
  const upstream = fakeHttpUpstream();
  const tunnel = fakeTunnelConnect();
  const instance = createRequestServer({
    maxConcurrent: 2,
    resolver: async () => {
      resolverCalls += 1;
      return ["93.184.216.34"];
    },
    request: upstream.factory,
    connect: tunnel.connect,
  });
  const port = await listen(instance);
  const token = proxyConfiguration(port).password;
  try {
    const noAuth = await request(port, "http://public.example/");
    assert.equal(noAuth.status, 407);
    const bearerOnly = await request(port, "http://public.example/", {
      Authorization: `Bearer ${initializeCredentials()}`,
    });
    assert.equal(bearerOnly.status, 407);
    assert.equal(resolverCalls, 0);

    const mismatch = await connectRequest(port, "public.example:443", token, { Host: "other.example" });
    assert.match(mismatch.header, /^HTTP\/1\.1 403/);
    mismatch.socket.destroy();
    assert.equal(tunnel.calls.length, 0);

    const oversized = await proxyBodyRequest(
      port,
      "http://public.example/upload",
      token,
      "small",
      { Host: "public.example", "content-length": String(PROXY_MAX_BODY_BYTES + 1) },
    );
    assert.equal(oversized.status, 413);
    assert.equal(upstream.calls.length, 0);
    assert.equal(resolverCalls, 0);
  } finally {
    await close(instance);
  }
});

test("proxy concurrency is bounded and excess work fails closed", async () => {
  initializeCredentials();
  let releaseDns;
  const upstream = fakeHttpUpstream("bounded");
  const instance = createRequestServer({
    maxConcurrent: 1,
    resolver: () => new Promise((resolve) => {
      releaseDns = resolve;
    }),
    request: upstream.factory,
  });
  const port = await listen(instance);
  const token = proxyConfiguration(port).password;
  const first = proxyRequest(port, "http://public.example/first", token, { Host: "public.example" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await proxyRequest(port, "http://public.example/second", token, { Host: "public.example" });
  assert.equal(second.status, 503);
  assert.equal(upstream.calls.length, 0);
  releaseDns(["93.184.216.34"]);
  assert.equal((await first).status, 200);
  await close(instance);
});

test("HTTPS CONNECT uses one pinned address and preserves the tunnel", async () => {
  initializeCredentials();
  let resolverCalls = 0;
  const tunnel = fakeTunnelConnect("93.184.216.34");
  const instance = createRequestServer({
    resolver: async () => {
      resolverCalls += 1;
      return ["93.184.216.34"];
    },
    connect: tunnel.connect,
  });
  const port = await listen(instance);
  const token = proxyConfiguration(port).password;
  const connected = await connectRequest(port, "public.example:443", token);
  assert.match(connected.header, /^HTTP\/1\.1 200 Connection Established/);
  assert.equal(resolverCalls, 1);
  assert.equal(tunnel.calls.length, 1);
  assert.equal(tunnel.calls[0].host, "93.184.216.34");
  assert.equal(tunnel.calls[0].port, 443);
  const payload = new Promise((resolve) => tunnel.sockets[0].once("data", resolve));
  connected.socket.write("tunnel payload");
  assert.equal((await payload).toString("utf8"), "tunnel payload");
  connected.socket.destroy();
  await close(instance);
});
