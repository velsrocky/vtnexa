const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const MAX_BODY_BYTES = 1024 * 1024;
const PROFILE_ENV = "VTAI_BROWSER_PROFILE";
const SESSION_TOKEN_BYTES = 32;
const PROXY_MAX_HEADER_BYTES = 32 * 1024;
const PROXY_MAX_BODY_BYTES = 32 * 1024 * 1024;
const PROXY_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const PROXY_MAX_CONCURRENT = 64;
const PROXY_REQUEST_TIMEOUT_MS = 30000;
const PROXY_CONNECT_TIMEOUT_MS = 10000;
const PROXY_TUNNEL_TIMEOUT_MS = 10 * 60 * 1000;
const PROXY_TUNNEL_MAX_BYTES = 256 * 1024 * 1024;
const PROXY_USERNAME = "vtai-browser";

function generateSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString("hex");
}

function constantTimeEqual(expected, actual) {
  const expectedBytes = Buffer.from(typeof expected === "string" ? expected : "", "utf8");
  const actualBytes = Buffer.from(typeof actual === "string" ? actual : "", "utf8");
  const candidate = Buffer.alloc(expectedBytes.length);
  actualBytes.copy(candidate, 0, 0, Math.min(actualBytes.length, candidate.length));
  const equal = expectedBytes.length > 0 && crypto.timingSafeEqual(expectedBytes, candidate);
  return equal && actualBytes.length === expectedBytes.length;
}

function requestAuthorized(req, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const headers = req && req.headers;
  const custom = headers && headers["x-vtai-token"];
  const authorization = headers && headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const customMatch = constantTimeEqual(token, typeof custom === "string" ? custom : "");
  const bearerMatch = constantTimeEqual(token, bearer);
  return customMatch || bearerMatch;
}

function proxyRequestAuthorized(req, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const headers = req && req.headers;
  const value = headers && headers["proxy-authorization"];
  if (typeof value !== "string") return false;
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(value.trim());
  if (!match) return false;
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) return false;
  return constantTimeEqual(token, decoded.slice(separator + 1));
}

class BodyLimitError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} byte limit`);
    this.name = "BodyLimitError";
    this.statusCode = 413;
    this.limit = limit;
  }
}

function valueOfEnv(env, name) {
  if (!env) return "";
  if (env[name] != null && String(env[name]).trim() !== "") return String(env[name]).trim();
  const upper = name.toUpperCase();
  if (env[upper] != null && String(env[upper]).trim() !== "") return String(env[upper]).trim();
  return "";
}

function browserChannel(executable) {
  const base = path.basename(String(executable)).toLowerCase();
  if (base.includes("msedge") || base === "edge.exe" || base.includes("microsoft-edge")) return "msedge";
  if (base.includes("chrome")) return "chrome";
  if (base.includes("chromium")) return "chromium";
  return "custom";
}

function windowsCandidates(env) {
  const programFiles = valueOfEnv(env, "ProgramFiles");
  const programFilesX86 = valueOfEnv(env, "ProgramFiles(x86)") || valueOfEnv(env, "ProgramFiles_x86");
  const localAppData = valueOfEnv(env, "LOCALAPPDATA");
  const userProfile = valueOfEnv(env, "USERPROFILE");
  const roots = [programFiles, programFilesX86, localAppData].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push({ file: path.join(root, "Google", "Chrome", "Application", "chrome.exe"), channel: "chrome" });
  }
  for (const root of roots) {
    candidates.push({ file: path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"), channel: "msedge" });
  }
  for (const root of [localAppData, userProfile].filter(Boolean)) {
    candidates.push({ file: path.join(root, "Chromium", "Application", "chrome.exe"), channel: "chromium" });
  }
  return candidates;
}

function macCandidates(env, home) {
  const roots = ["/Applications", path.join(home, "Applications")];
  return roots.flatMap((root) => [
    { file: path.join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"), channel: "chrome" },
    { file: path.join(root, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"), channel: "msedge" },
    { file: path.join(root, "Chromium.app", "Contents", "MacOS", "Chromium"), channel: "chromium" },
  ]);
}

function linuxCandidates(env) {
  const candidates = [
    ["/usr/bin/google-chrome", "chrome"],
    ["/usr/bin/google-chrome-stable", "chrome"],
    ["/opt/google/chrome/chrome", "chrome"],
    ["/usr/bin/microsoft-edge", "msedge"],
    ["/usr/bin/microsoft-edge-stable", "msedge"],
    ["/opt/microsoft/msedge/msedge", "msedge"],
    ["/usr/bin/chromium", "chromium"],
    ["/usr/bin/chromium-browser", "chromium"],
    ["/snap/bin/chromium", "chromium"],
  ];
  const flatpak = valueOfEnv(env, "FLATPAK_BROWSER");
  if (flatpak) candidates.push([flatpak, browserChannel(flatpak)]);
  return candidates.map(([file, channel]) => ({ file, channel }));
}

function commonBrowserCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") return windowsCandidates(env);
  if (platform === "darwin") return macCandidates(env, home);
  if (platform === "linux") return linuxCandidates(env);
  return [];
}

function defaultExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveBrowser(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || defaultExists;
  const override = valueOfEnv(env, "VTAI_BROWSER_CHROME");
  if (override) {
    const file = path.resolve(override);
    if (!exists(file)) {
      return {
        ready: false,
        engine: "chromium",
        channel: null,
        path: file,
        source: "VTAI_BROWSER_CHROME",
        error: `VTAI_BROWSER_CHROME does not exist: ${file}`,
        remediation: "Set VTAI_BROWSER_CHROME to an existing Chrome, Edge, or Chromium executable.",
      };
    }
    return {
      ready: true,
      engine: "chromium",
      channel: browserChannel(file),
      path: file,
      source: "VTAI_BROWSER_CHROME",
    };
  }

  for (const candidate of commonBrowserCandidates(platform, env, options.home || os.homedir())) {
    if (exists(candidate.file)) {
      return {
        ready: true,
        engine: "chromium",
        channel: candidate.channel,
        path: candidate.file,
        source: "common-path",
      };
    }
  }

  let chromium = options.chromium;
  if (!chromium) {
    try {
      ({ chromium } = require("playwright-core"));
    } catch {
      chromium = null;
    }
  }
  if (chromium && typeof chromium.executablePath === "function") {
    try {
      const file = chromium.executablePath();
      if (file && exists(file)) {
        return {
          ready: true,
          engine: "chromium",
          channel: "chromium",
          path: file,
          source: "playwright",
        };
      }
    } catch {
    }
  }

  return {
    ready: false,
    engine: "chromium",
    channel: null,
    path: null,
    source: "none",
    error:
      "browser engine not found: install Google Chrome, Microsoft Edge, or Chromium, or set VTAI_BROWSER_CHROME to an executable",
    remediation: "Install Chrome, Edge, or Chromium and choose Recheck.",
  };
}

function profileDirectory(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const override = valueOfEnv(env, PROFILE_ENV);
  if (override) return path.resolve(override);
  const home = options.home || os.homedir();
  if (platform === "win32") {
    const base =
      valueOfEnv(env, "LOCALAPPDATA") ||
      valueOfEnv(env, "APPDATA") ||
      (home ? path.join(home, "AppData", "Local") : "");
    return path.join(base, "VTNexa", "browser-profile");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "VTNexa", "browser-profile");
  }
  const dataHome = valueOfEnv(env, "XDG_DATA_HOME");
  return path.join(dataHome || path.join(home, ".local", "share"), "VTNexa", "browser-profile");
}

function statusPayload({ port, running, headless = false, pageUrl = null, browser = null, profilePath = null, blockedTarget = null }) {
  const numericPort = Number(port);
  const hasPort = Number.isInteger(numericPort) && numericPort > 0 && numericPort <= 65535;
  return {
    ok: true,
    running: !!running,
    headless: !!headless,
    baseUrl: hasPort ? `http://127.0.0.1:${numericPort}` : null,
    port: hasPort ? numericPort : null,
    pageUrl: pageUrl || null,
    blockedTarget,
    browser: browser || {
      ready: false,
      engine: "chromium",
      channel: null,
      path: null,
    },
    profilePath,
  };
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BODY_BYTES;
  const declared = Number(req.headers && (req.headers["content-length"] || req.headers["Content-Length"]));
  if (Number.isFinite(declared) && declared > limit) {
    const error = new BodyLimitError(limit);
    req.resume?.();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        finish(reject, new BodyLimitError(limit));
        req.resume?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks, size).toString("utf8");
      if (!text) {
        finish(resolve, {});
        return;
      }
      try {
        finish(resolve, JSON.parse(text));
      } catch (error) {
        finish(reject, error);
      }
    });
    req.on("error", (error) => finish(reject, error));
  });
}

function isSensitiveField(field) {
  const type = String(field.inputType || field.type || "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const labels = [field.name, field.placeholder, field.ariaLabel, field.title, field.id, field.autocomplete]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /(pass(word|code)?|secret|token|api[-_ ]?key|one[-_ ]?time|otp|pin|security code)/i.test(labels);
}

function snapshotName(field) {
  return [
    field.ariaLabel,
    field.name,
    field.placeholder,
    field.title,
    field.innerText,
    field.href,
    field.tag,
  ]
    .filter((value) => value != null && String(value).trim() !== "")
    .map((value) => String(value).trim().replace(/\s+/g, " ").slice(0, 100))[0] || "element";
}

function sanitizeSnapshot(snapshot) {
  const input = snapshot && typeof snapshot === "object" ? snapshot : {};
  const sourceElements = Array.isArray(input.elements) ? input.elements : [];
  const secrets = sourceElements
    .filter((element) => isSensitiveField(element))
    .map((element) => (element && element.value != null ? String(element.value) : ""))
    .filter((value) => value.length > 0);
  const elements = sourceElements.map((source) => {
    const element = { ...(source || {}) };
    const tag = String(element.tag || "").toLowerCase();
    const sensitive = isSensitiveField(element);
    element.name = snapshotName(element);
    if (sensitive) {
      for (const [key, value] of Object.entries(element)) {
        if (typeof value !== "string") continue;
        for (const secret of secrets) element[key] = value.split(secret).join("[redacted]");
      }
    }
    if ((tag === "input" || tag === "textarea" || tag === "select") && Object.prototype.hasOwnProperty.call(element, "value")) {
      element.value = sensitive ? "[redacted]" : "[value hidden]";
    }
    return element;
  });
  let text = typeof input.text === "string" ? input.text : "";
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  return { ...input, text, elements };
}

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function ipv4Number(host) {
  const parts = normalizeHost(host).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inIpv4Range(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

function ipv4Disallowed(host) {
  const value = ipv4Number(host);
  if (value === null) return true;
  for (const [base, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ]) {
    if (inIpv4Range(value, ipv4Number(base), prefix)) return true;
  }
  return false;
}

function parseIpv6(host) {
  let value = normalizeHost(host);
  if (!value || value.includes("%")) return null;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4 = ipv4Number(tail);
    if (ipv4 === null) return null;
    value = `${value.slice(0, lastColon + 1)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const parts = half.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts;
  };
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (left === null || right === null) return null;
  let groups;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  }
  return groups.map((part) => BigInt(`0x${part}`));
}

function ipv6Value(groups) {
  return groups.reduce((value, group) => (value << 16n) | group, 0n);
}

function ipv6EmbeddedIpv4(groups) {
  if (groups.slice(0, 5).every((group) => group === 0n) && groups[5] === 0xffffn) {
    return Number((groups[6] << 16n) | groups[7]);
  }
  return null;
}

function ipv6Disallowed(host) {
  const groups = parseIpv6(host);
  if (!groups) return true;
  const embedded = ipv6EmbeddedIpv4(groups);
  if (embedded !== null) {
    return ipv4Disallowed(
      `${(embedded >>> 24) & 0xff}.${(embedded >>> 16) & 0xff}.${(embedded >>> 8) & 0xff}.${embedded & 0xff}`,
    );
  }
  if (groups.slice(0, 6).every((group) => group === 0n)) return true;
  const value = ipv6Value(groups);
  const first = Number(value >> 112n);
  const second = Number(groups[1]);
  if (value === 0n || value === 1n) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001) {
    if (
      second === 0 ||
      second === 1 ||
      second === 2 ||
      second === 3 ||
      second === 0xdb8 ||
      (second >= 0x10 && second <= 0x2f)
    ) {
      return true;
    }
  }
  if (first === 0x2002) return true;
  if (first === 0x3fff && (groups[1] & 0xf000n) === 0n) return true;
  return (first & 0xe000) !== 0x2000;
}

function addressDisallowed(address) {
  const value = normalizeHost(address);
  const version = net.isIP(value);
  if (version === 4) return ipv4Disallowed(value);
  if (version === 6) return ipv6Disallowed(value);
  return true;
}

function hostnameDisallowed(host) {
  const value = normalizeHost(host);
  return (
    !value ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value.endsWith(".home.arpa") ||
    value.endsWith(".lan") ||
    value === "metadata.google.internal"
  );
}

function networkUrl(target) {
  try {
    const url = new URL(String(target));
    const protocol = url.protocol.toLowerCase();
    if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) return null;
    const host = normalizeHost(url.hostname);
    if (!host) return null;
    return { host, protocol };
  } catch {
    return null;
  }
}

function defaultNetworkPort(protocol) {
  return protocol === "https:" || protocol === "wss:" ? 443 : 80;
}

function parseNetworkPort(value, protocol) {
  if (value === "" || value === undefined || value === null) return defaultNetworkPort(protocol);
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error("invalid network port");
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid network port");
  return port;
}

function formatNetworkAuthority(host, port, protocol) {
  const normalized = normalizeHost(host);
  const formatted = net.isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  return port === defaultNetworkPort(protocol) ? formatted : `${formatted}:${port}`;
}

function parseHostHeader(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error("invalid Host header");
  }
  let host;
  let port = "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) throw new Error("invalid Host header");
    host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":") || !/^\d+$/.test(rest.slice(1))) throw new Error("invalid Host header");
      port = rest.slice(1);
    }
  } else {
    const firstColon = value.indexOf(":");
    const lastColon = value.lastIndexOf(":");
    if (firstColon !== lastColon) throw new Error("invalid Host header");
    if (firstColon >= 0) {
      host = value.slice(0, firstColon);
      port = value.slice(firstColon + 1);
      if (!/^\d+$/.test(port)) throw new Error("invalid Host header");
    } else {
      host = value;
    }
  }
  const normalized = normalizeHost(host);
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("@") || normalized.includes("%")) {
    throw new Error("invalid Host header");
  }
  if (net.isIP(normalized) === 0) {
    const labels = normalized.split(".");
    if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9_-]+$/i.test(label))) {
      throw new Error("invalid Host header");
    }
  }
  return { host: normalized, port: port ? parseNetworkPort(port, "http:") : null };
}

function parseProxyTarget(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || !/^https?:\/\//i.test(value)) {
    throw new Error("invalid proxy target");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid proxy target");
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!["http:", "https:"].includes(protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("invalid proxy target");
  }
  const host = normalizeHost(parsed.hostname);
  if (!host) throw new Error("invalid proxy target");
  const port = parseNetworkPort(parsed.port, protocol);
  return {
    host,
    port,
    protocol,
    path: `${parsed.pathname || "/"}${parsed.search || ""}`,
    authority: formatNetworkAuthority(host, port, protocol),
  };
}

function parseConnectTarget(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\s\\/@?#]/.test(value)) {
    throw new Error("invalid CONNECT target");
  }
  let host;
  let portText;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(value);
    if (!match) throw new Error("invalid CONNECT target");
    host = match[1];
    portText = match[2];
  } else {
    const match = /^([^:]+):(\d+)$/.exec(value);
    if (!match) throw new Error("invalid CONNECT target");
    host = match[1];
    portText = match[2];
  }
  const normalized = normalizeHost(host);
  if (!normalized || normalized.includes("%")) throw new Error("invalid CONNECT target");
  const port = parseNetworkPort(portText, "https:");
  return {
    host: normalized,
    port,
    protocol: "https:",
    path: "",
    authority: formatNetworkAuthority(normalized, port, "https:"),
  };
}

function hostHeaderMatches(target, header) {
  if (!target || !header) return false;
  const targetHost = normalizeHost(target.host);
  const headerHost = normalizeHost(header.host);
  if (!targetHost || targetHost !== headerHost) return false;
  const targetPort = parseNetworkPort(target.port, target.protocol);
  const headerPort = header.port || defaultNetworkPort(target.protocol);
  return targetPort === headerPort;
}

async function resolveHostAddressesOnce(host, resolver = dns) {
  const value = normalizeHost(host);
  if (!value) throw new Error("empty DNS host");
  if (net.isIP(value)) return [value];
  if (hostnameDisallowed(value)) throw new Error("disallowed DNS host");
  let records;
  const errors = [];
  if (typeof resolver === "function") {
    records = await resolver(value);
  } else if (resolver && (typeof resolver.resolve4 === "function" || typeof resolver.resolve6 === "function")) {
    const requests = [];
    if (typeof resolver.resolve4 === "function") {
      requests.push(
        Promise.resolve()
          .then(() => resolver.resolve4(value))
          .catch((error) => {
            errors.push(error);
            return [];
          }),
      );
    }
    if (typeof resolver.resolve6 === "function") {
      requests.push(
        Promise.resolve()
          .then(() => resolver.resolve6(value))
          .catch((error) => {
            errors.push(error);
            return [];
          }),
      );
    }
    records = (await Promise.all(requests)).flat();
  } else if (resolver && typeof resolver.lookup === "function") {
    records = await resolver.lookup(value, { all: true, verbatim: true });
  } else if (resolver && typeof resolver.resolveAny === "function") {
    records = await resolver.resolveAny(value);
  } else if (resolver && typeof resolver.resolve === "function") {
    records = await resolver.resolve(value);
  } else {
    throw new Error("DNS resolver is unavailable");
  }
  const addresses = new Set();
  const invalid = { value: false };
  addAddresses(records, addresses, invalid);
  if (invalid.value) throw new Error("DNS returned an invalid address");
  if (addresses.size === 0) {
    const meaningful = errors.find((error) => !dnsMissing(error));
    if (meaningful) throw meaningful;
    throw new Error("DNS returned no addresses");
  }
  if (errors.some((error) => !dnsMissing(error))) throw errors.find((error) => !dnsMissing(error));
  return [...addresses];
}

async function resolveDefaultPinnedAddresses(host) {
  const lookup = (family) => ({
    lookup: (value, options) => dns.lookup(value, { ...options, family }),
  });
  try {
    return await resolveHostAddressesOnce(host, lookup(4));
  } catch (error) {
    if (!dnsMissing(error) && !/DNS returned no addresses/.test(String(error && error.message))) throw error;
    return resolveHostAddressesOnce(host, lookup(6));
  }
}

async function resolvePinnedTarget(target, options = {}) {
  const parsed = typeof target === "string"
    ? parseProxyTarget(target)
    : target && {
        ...target,
        port: parseNetworkPort(target.port, target.protocol),
        authority: formatNetworkAuthority(target.host, parseNetworkPort(target.port, target.protocol), target.protocol),
      };
  if (!parsed || !parsed.host || !parsed.protocol) throw new Error("invalid proxy target");
  const host = normalizeHost(parsed.host);
  if (!host || hostnameDisallowed(host)) throw new Error("disallowed proxy target");
  const addresses = net.isIP(host)
    ? [host]
    : await withTimeout(
        options.resolver
          ? resolveHostAddressesOnce(host, options.resolver)
          : resolveDefaultPinnedAddresses(host),
      );
  if (addresses.length === 0 || addresses.some((address) => net.isIP(normalizeHost(address)) === 0 || addressDisallowed(address))) {
    throw new Error("proxy target resolved to a disallowed address");
  }
  const families = new Set(addresses.map((address) => net.isIP(normalizeHost(address))));
  if (families.size !== 1) throw new Error("proxy target returned mixed address families");
  return {
    ...parsed,
    host,
    addresses,
    address: normalizeHost(addresses[0]),
    family: families.values().next().value,
  };
}

const DNS_RESOLUTION_TIMEOUT = 5000;

function withTimeout(promise, timeout = DNS_RESOLUTION_TIMEOUT) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("DNS resolution timed out")), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

function dnsMissing(error) {
  return error && ["ENODATA", "ENOTFOUND", "EAI_NODATA"].includes(error.code);
}

function addAddresses(value, addresses, invalid = { value: false }) {
  if (typeof value === "string") {
    const address = normalizeHost(value);
    if (net.isIP(address)) addresses.add(address);
    else invalid.value = true;
    return invalid;
  }
  if (Array.isArray(value)) {
    for (const item of value) addAddresses(item, addresses, invalid);
    return invalid;
  }
  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "address")) {
      if (typeof value.address !== "string" || net.isIP(normalizeHost(value.address)) === 0) {
        invalid.value = true;
      } else {
        addresses.add(normalizeHost(value.address));
      }
    }
    if (value.type && ["A", "AAAA"].includes(value.type) && !value.address) invalid.value = true;
  }
  return invalid;
}

async function resolveAnyAddresses(host, resolver, addresses, seen, invalid) {
  if (typeof resolver.resolveAny !== "function") return;
  if (seen.has(host)) throw new Error("DNS CNAME loop");
  seen.add(host);
  const records = await resolver.resolveAny(host);
  const cnames = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record && record.type === "CNAME" && typeof record.value === "string") cnames.push(normalizeHost(record.value));
    addAddresses(record, addresses, invalid);
  }
  for (const cname of cnames) {
    try {
      await resolveAnyAddresses(cname, resolver, addresses, seen, invalid);
    } catch (error) {
      throw new Error(`DNS CNAME resolution failed: ${error.message}`);
    }
  }
}

async function resolveHostAddresses(host, resolver = dns) {
  const value = normalizeHost(host);
  if (!value) throw new Error("empty DNS host");
  if (typeof resolver === "function") {
    const addresses = new Set();
    const invalid = { value: false };
    addAddresses(await resolver(value), addresses, invalid);
    if (invalid.value) throw new Error("DNS returned an invalid address");
    if (addresses.size === 0) throw new Error("DNS returned no addresses");
    return [...addresses];
  }
  if (!resolver || typeof resolver !== "object") throw new Error("DNS resolver is unavailable");
  const addresses = new Set();
  const invalid = { value: false };
  const errors = [];
  if (typeof resolver.lookup === "function") {
    try {
      addAddresses(await resolver.lookup(value, { all: true, verbatim: true }), addresses, invalid);
    } catch (error) {
      errors.push(error);
    }
  }
  if (typeof resolver.resolveAny === "function") {
    try {
      await resolveAnyAddresses(value, resolver, addresses, new Set(), invalid);
    } catch (error) {
      errors.push(error);
    }
  }
  if (typeof resolver.resolve === "function") {
    try {
      addAddresses(await resolver.resolve(value), addresses, invalid);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const method of ["resolve4", "resolve6"]) {
    if (typeof resolver[method] !== "function") continue;
    try {
      addAddresses(await resolver[method](value), addresses, invalid);
    } catch (error) {
      errors.push(error);
    }
  }
  if (invalid.value) throw new Error("DNS returned an invalid address");
  if (addresses.size === 0) throw errors[0] || new Error("DNS returned no addresses");
  if (errors.some((error) => !dnsMissing(error))) throw errors.find((error) => !dnsMissing(error));
  return [...addresses];
}

function navigationBlocked(target, options = null) {
  const parsed = networkUrl(target);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) return true;
  if (hostnameDisallowed(parsed.host)) return true;
  const version = net.isIP(parsed.host);
  if (version !== 0) return addressDisallowed(parsed.host);
  if (options && (options.resolver || options.resolve || options.dns)) {
    return networkTargetBlocked(target, options);
  }
  return false;
}

async function stableHostAddresses(host, resolver) {
  const first = await resolveHostAddresses(host, resolver);
  const second = await resolveHostAddresses(host, resolver);
  const firstSet = new Set(first);
  const secondSet = new Set(second);
  if (firstSet.size !== secondSet.size || [...firstSet].some((address) => !secondSet.has(address))) {
    throw new Error("DNS answers changed during validation");
  }
  return [...firstSet];
}

async function networkTargetBlocked(target, options = {}) {
  const parsed = networkUrl(target);
  if (!parsed || hostnameDisallowed(parsed.host)) return true;
  const version = net.isIP(parsed.host);
  if (version !== 0) return addressDisallowed(parsed.host);
  try {
    const resolver = options.resolver || options.resolve || options.dns || dns;
    const addresses = await withTimeout(stableHostAddresses(parsed.host, resolver));
    return addresses.length === 0 || addresses.some(addressDisallowed);
  } catch {
    return true;
  }
}

function nonNetworkUrl(target) {
  try {
    return ["about:", "blob:", "data:"].includes(new URL(String(target)).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function redactNavigationTarget(target) {
  try {
    const url = new URL(target);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "blocked navigation target";
  }
}

function safeErrorMessage(error) {
  let message = String((error && error.message) || error || "");
  message = message.replace(/https?:\/\/[^\s)"']+/gi, (value) => redactNavigationTarget(value));
  return message.replace(/([?&](?:token|secret|password|code)=)[^&\s]+/gi, "$1[redacted]").slice(0, 1000);
}

function preflight(options = {}) {
  const profilePath = profileDirectory(options);
  const browser = resolveBrowser(options);
  const numericPort = Number(options.port || 0);
  const hasPort = Number.isInteger(numericPort) && numericPort > 0 && numericPort <= 65535;
  return {
    ok: true,
    ready: browser.ready,
    running: false,
    browser,
    profilePath,
    baseUrl: hasPort ? `http://127.0.0.1:${numericPort}` : null,
    port: hasPort ? numericPort : null,
    pageUrl: null,
    missing: browser.ready ? [] : [browser.error],
    remediation: browser.ready ? [] : [browser.remediation],
  };
}

module.exports = {
  BodyLimitError,
  MAX_BODY_BYTES,
  PROXY_MAX_BODY_BYTES,
  PROXY_MAX_CONCURRENT,
  PROXY_MAX_HEADER_BYTES,
  PROXY_MAX_RESPONSE_BYTES,
  PROXY_CONNECT_TIMEOUT_MS,
  PROXY_REQUEST_TIMEOUT_MS,
  PROXY_TUNNEL_MAX_BYTES,
  PROXY_TUNNEL_TIMEOUT_MS,
  PROXY_USERNAME,
  SESSION_TOKEN_BYTES,
  addressDisallowed,
  browserChannel,
  commonBrowserCandidates,
  constantTimeEqual,
  formatNetworkAuthority,
  generateSessionToken,
  hostHeaderMatches,
  isSensitiveField,
  navigationBlocked,
  networkTargetBlocked,
  networkUrl,
  nonNetworkUrl,
  parseConnectTarget,
  parseHostHeader,
  parseProxyTarget,
  proxyRequestAuthorized,
  resolveDefaultPinnedAddresses,
  resolveHostAddresses,
  resolveHostAddressesOnce,
  resolvePinnedTarget,
  preflight,
  profileDirectory,
  readBody,
  redactNavigationTarget,
  requestAuthorized,
  resolveBrowser,
  safeErrorMessage,
  sanitizeSnapshot,
  snapshotName,
  statusPayload,
};
