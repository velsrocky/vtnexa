// VTAITool Browser Use sidecar.
// Real Chromium (persistent profile => signed in as you), driven over HTTP.
// No external deps besides playwright-core. Uses only node built-ins otherwise.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const PORT = parseInt(arg("--port", process.env.VTAI_BROWSER_PORT || "39317"), 10);
const PROFILE = arg("--profile", process.env.VTAI_BROWSER_PROFILE || path.join(os.homedir(), ".config", "vtai-browser-profile"));
const CHROME = arg("--chrome", process.env.VTAI_BROWSER_CHROME || "/usr/bin/google-chrome");
const HEADLESS = (arg("--headless", process.env.VTAI_BROWSER_HEADLESS || "0") === "1");
// Per-run bearer token: Rust spawns us with VTAI_BROWSER_TOKEN and a 0600
// --token-file (preferred; env leaks via /proc). Empty token = deny all.
let TOKEN = process.env.VTAI_BROWSER_TOKEN || "";
const TOKEN_FILE = arg("--token-file", process.env.VTAI_BROWSER_TOKEN_FILE || "");
try {
  if (TOKEN_FILE && fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) TOKEN = t;
  }
} catch {}
const NO_SANDBOX = process.env.VTAI_BROWSER_NO_SANDBOX === "1";

let context = null;
let page = null;
// serialize all page ops through one queue
let queue = Promise.resolve();
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

async function launch() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const execPath = fs.existsSync(CHROME) ? CHROME : undefined; // undefined => playwright default chromium
  const args = ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"];
  if (NO_SANDBOX) args.push("--no-sandbox");
  context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: execPath,
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    args,
  });
  page = context.pages()[0] || (await context.newPage());
  console.log(`browser ready headless=${HEADLESS} profile=${PROFILE}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req) {
  if (!TOKEN) return false; // fail-closed: Rust always sets one
  const got = req.headers["x-vtai-token"];
  return typeof got === "string" && got.length > 0 && got === TOKEN;
}

function navigationBlocked(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0" || h === "::1") return true;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const o = m.slice(1).map(Number);
      if (o[0] === 127 || o[0] === 10) return true;
      if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
      if (o[0] === 192 && o[1] === 168) return true;
      if (o[0] === 169 && o[1] === 254) return true;
      if (o[0] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function snapshotImpl() {
  const p = await ensurePage();
  const data = await p.evaluate(() => {
    // tag interactive elements with stable refs for click/type
    const SEL = "a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox]";
    const els = Array.from(document.querySelectorAll(SEL)).slice(0, 120);
    const out = [];
    els.forEach((el, i) => {
      el.setAttribute("data-vtai-ref", String(i));
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // skip invisible
      const name = (
        el.getAttribute("aria-label") ||
        el.innerText ||
        el.value ||
        el.getAttribute("placeholder") ||
        el.getAttribute("href") ||
        el.tagName
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 100);
      const item = { ref: i, tag: el.tagName.toLowerCase(), name };
      if (el.tagName === "A") item.href = (el.getAttribute("href") || "").slice(0, 200);
      if (el.tagName === "INPUT") item.inputType = el.getAttribute("type") || "text";
      out.push(item);
    });
    return {
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : "").slice(0, 4000),
      elements: out,
    };
  });
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    if (!authorized(req)) return send(res, 401, { ok: false, error: "unauthorized (bad/missing x-vtai-token)" });
    if (req.method === "GET" && u.pathname === "/status") {
      const p = context ? await ensurePage() : null;
      return send(res, 200, {
        ok: true,
        running: !!context,
        headless: HEADLESS,
        url: p ? p.url() : null,
      });
    }
    if (req.method === "POST" && u.pathname === "/navigate") {
      const body = await readBody(req);
      if (!body.url) return send(res, 400, { ok: false, error: "url required" });
      if (navigationBlocked(body.url)) return send(res, 403, { ok: false, error: "refused (private/loopback target)" });
      const r = await serial(async () => {
        const p = await ensurePage();
        await p.goto(body.url, { waitUntil: "domcontentloaded", timeout: 25000 });
        return { ok: true, url: p.url(), title: await p.title() };
      });
      return send(res, 200, r);
    }
    if (req.method === "GET" && u.pathname === "/snapshot") {
      const r = await serial(async () => ({ ok: true, ...(await snapshotImpl()) }));
      return send(res, 200, r);
    }
    if (req.method === "POST" && u.pathname === "/click") {
      const body = await readBody(req);
      if (body.ref === undefined) return send(res, 400, { ok: false, error: "ref required" });
      const r = await serial(async () => {
        const p = await ensurePage();
        await p.click(`[data-vtai-ref="${body.ref}"]`, { timeout: 8000 });
        return { ok: true, url: p.url() };
      });
      return send(res, 200, r);
    }
    if (req.method === "POST" && u.pathname === "/type") {
      const body = await readBody(req);
      if (body.ref === undefined || body.text === undefined)
        return send(res, 400, { ok: false, error: "ref and text required" });
      const r = await serial(async () => {
        const p = await ensurePage();
        const sel = `[data-vtai-ref="${body.ref}"]`;
        await p.fill(sel, body.text, { timeout: 8000 });
        if (body.submit) await p.press(sel, "Enter");
        return { ok: true, url: p.url() };
      });
      return send(res, 200, r);
    }
    if (req.method === "GET" && u.pathname === "/screenshot") {
      const r = await serial(async () => {
        const p = await ensurePage();
        // JPEG keeps agent vision payloads small (PNG base64 would eat context).
        const buf = await p.screenshot({ type: "jpeg", quality: 65 });
        return { ok: true, url: p.url(), imageBase64: buf.toString("base64"), mimeType: "image/jpeg" };
      });
      return send(res, 200, r);
    }
    if (req.method === "POST" && u.pathname === "/scroll") {
      const body = await readBody(req);
      const r = await serial(async () => {
        const p = await ensurePage();
        await p.evaluate(
          ({ dx, dy }) => window.scrollBy(dx || 0, dy || 600),
          { dx: body.dx || 0, dy: body.dy ?? 600 },
        );
        return { ok: true };
      });
      return send(res, 200, r);
    }
    if (req.method === "POST" && u.pathname === "/back") {
      const r = await serial(async () => {
        const p = await ensurePage();
        await p.goBack({ timeout: 10000 }).catch(() => {});
        return { ok: true, url: p.url() };
      });
      return send(res, 200, r);
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

launch()
  .then(() => server.listen(PORT, "127.0.0.1", () => console.log(`vtai browser sidecar on 127.0.0.1:${PORT}`)))
  .catch((e) => {
    console.error("launch failed:", e);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  try {
    await context?.close();
  } catch {}
  process.exit(0);
});
