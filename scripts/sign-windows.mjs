import { access, readdir } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SIGNING_ENV_NAMES = Object.freeze([
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_CERTIFICATE_THUMBPRINT",
  "WINDOWS_TIMESTAMP_URL",
]);
const TOOL_ENV_NAMES = Object.freeze(["SIGNTOOL_PATH", "TAURI_WINDOWS_SIGNTOOL_PATH"]);

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function missingRuntimeValues(env) {
  return ["WINDOWS_CERTIFICATE_THUMBPRINT", "WINDOWS_TIMESTAMP_URL"].filter((name) => !present(env[name]));
}

export function validateSigningEnvironment(env = process.env, platform = process.platform) {
  const configured = SIGNING_ENV_NAMES.filter((name) => present(env[name]));
  if (configured.length === 0) return { mode: "skip", missing: [] };
  const missing = missingRuntimeValues(env);
  if (missing.length > 0) {
    throw new Error(`Windows signing environment is incomplete; missing: ${missing.join(", ")}`);
  }
  if (platform !== "win32") {
    throw new Error("Windows signing material is only valid on Windows");
  }
  const thumbprint = env.WINDOWS_CERTIFICATE_THUMBPRINT.trim();
  if (!/^[0-9a-f]{40}$/i.test(thumbprint)) {
    throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character hexadecimal thumbprint");
  }
  let timestamp;
  try {
    timestamp = new URL(env.WINDOWS_TIMESTAMP_URL.trim());
  } catch {
    throw new Error("WINDOWS_TIMESTAMP_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(timestamp.protocol) || timestamp.username || timestamp.password) {
    throw new Error("WINDOWS_TIMESTAMP_URL must be an HTTP or HTTPS URL without credentials");
  }
  return { mode: "sign", thumbprint, timestampUrl: env.WINDOWS_TIMESTAMP_URL.trim(), missing: [] };
}

export function buildSignToolArgs({ file, thumbprint, timestampUrl }) {
  if (!present(file) || !present(thumbprint) || !present(timestampUrl)) {
    throw new TypeError("file, thumbprint, and timestampUrl are required");
  }
  return [
    "sign",
    "/sha1",
    thumbprint,
    "/fd",
    "sha256",
    "/tr",
    timestampUrl,
    "/td",
    "sha256",
    file,
  ];
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findSigntool(env) {
  const configuredPath = env.SIGNTOOL_PATH || env.TAURI_WINDOWS_SIGNTOOL_PATH;
  if (present(configuredPath)) return resolve(configuredPath.trim());
  for (const directory of (env.PATH || "").split(delimiter)) {
    const candidate = join(directory.replace(/^"|"$/g, ""), "signtool.exe");
    if (await exists(candidate)) return candidate;
  }
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
  ].filter(present);
  for (const root of roots) {
    const kitRoot = join(root, "Windows Kits", "10", "bin");
    const stack = [kitRoot];
    while (stack.length > 0) {
      const directory = stack.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === "signtool.exe") return full;
      }
    }
  }
  throw new Error("signtool.exe was not found; set SIGNTOOL_PATH");
}

function redact(value, env) {
  let output = value;
  for (const name of [...SIGNING_ENV_NAMES, ...TOOL_ENV_NAMES]) {
    const secret = env[name];
    if (present(secret) && secret.length >= 4) output = output.split(secret).join(`[${name}]`);
  }
  return output;
}

export function runSigntool(tool, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(tool, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 16000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16000) stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code: code ?? 1, signal, stdout, stderr }));
  });
}

export async function signWindowsFile(file, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const state = validateSigningEnvironment(env, platform);
  if (state.mode === "skip") return { skipped: true };
  const filePath = resolve(file);
  if (!(await exists(filePath))) throw new Error(`file to sign does not exist: ${filePath}`);
  const tool = options.signtoolPath || (await findSigntool(env));
  const args = buildSignToolArgs({ file: filePath, thumbprint: state.thumbprint, timestampUrl: state.timestampUrl });
  const result = await (options.runSigntool || runSigntool)(tool, args);
  if (result.code !== 0) {
    const detail = redact(`${result.stdout}\n${result.stderr}`.trim(), env);
    throw new Error(`signtool failed for ${filePath}${detail ? `: ${detail}` : ""}`);
  }
  return { skipped: false, tool, args };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error("usage: node scripts/sign-windows.mjs <file>");
    const result = await signWindowsFile(process.argv[2]);
    console.log(result.skipped ? "sign-windows: skipped because signing material is absent" : "sign-windows: signed with SHA-256 and timestamp");
  } catch (error) {
    console.error(`sign-windows: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
