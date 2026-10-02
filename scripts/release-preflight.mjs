import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_RELEASE_SECRETS = Object.freeze([
  "TAURI_SIGNING_PRIVATE_KEY",
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_TIMESTAMP_URL",
]);

function valuePresent(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function missingReleaseSecrets(env = {}) {
  return REQUIRED_RELEASE_SECRETS.filter((name) => !valuePresent(env[name]));
}

export function cargoPackageVersion(cargoToml) {
  const start = cargoToml.search(/^\[package\]\s*$/m);
  if (start < 0) throw new Error("Cargo.toml has no [package] section");
  const bodyStart = cargoToml.indexOf("\n", start) + 1;
  const remaining = cargoToml.slice(bodyStart);
  const nextSection = remaining.search(/^\[/m);
  const packageSection = nextSection < 0 ? remaining : remaining.slice(0, nextSection);
  const match = packageSection.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Cargo.toml has no package version");
  return match[1];
}

export function parseReleaseVersions({ packageJson, cargoToml, tauriConfig }) {
  let packageData;
  let tauriData;
  try {
    packageData = JSON.parse(packageJson);
  } catch {
    throw new Error("package.json is not valid JSON");
  }
  try {
    tauriData = JSON.parse(tauriConfig);
  } catch {
    throw new Error("tauri.conf.json is not valid JSON");
  }
  const packageVersion = packageData && typeof packageData.version === "string" ? packageData.version : "";
  const cargoVersion = cargoPackageVersion(cargoToml);
  const tauriVersion = tauriData && typeof tauriData.version === "string" ? tauriData.version : "";
  if (!packageVersion || !tauriVersion) throw new Error("release manifests must contain string versions");
  return { packageVersion, cargoVersion, tauriVersion };
}

export function validateReleaseVersion(tag, versions) {
  const { packageVersion, cargoVersion, tauriVersion } = versions;
  if (packageVersion !== cargoVersion || packageVersion !== tauriVersion) {
    throw new Error(`release manifests disagree: package=${packageVersion}, cargo=${cargoVersion}, tauri=${tauriVersion}`);
  }
  const expected = `v${packageVersion}`;
  if (tag !== expected) throw new Error(`release tag must exactly match ${expected}`);
  return { tag, version: packageVersion };
}

function validateSecretValue(name, value) {
  if (!valuePresent(value)) return;
  if (name === "WINDOWS_CERTIFICATE") {
    const compact = value.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length < 8) {
      throw new Error(`invalid release secret: ${name}`);
    }
    let decoded;
    try {
      decoded = Buffer.from(compact, "base64");
    } catch {
      throw new Error(`invalid release secret: ${name}`);
    }
    if (decoded.length === 0) throw new Error(`invalid release secret: ${name}`);
  }
  if (name === "WINDOWS_TIMESTAMP_URL") {
    try {
      const url = new URL(value.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid URL");
    } catch {
      throw new Error(`invalid release secret: ${name}`);
    }
  }
}

export function validateReleaseSecrets(env = {}) {
  const missing = missingReleaseSecrets(env);
  if (missing.length > 0) throw new Error(`missing release secrets: ${missing.join(", ")}`);
  for (const name of REQUIRED_RELEASE_SECRETS) validateSecretValue(name, env[name]);
  return { required: [...REQUIRED_RELEASE_SECRETS] };
}

export async function preflight({ tag, root = process.cwd(), env = process.env } = {}) {
  if (!valuePresent(tag)) throw new Error("release tag is required");
  const [packageJson, cargoToml, tauriConfig] = await Promise.all([
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, "src-tauri", "Cargo.toml"), "utf8"),
    readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  ]);
  const versions = parseReleaseVersions({ packageJson, cargoToml, tauriConfig });
  const version = validateReleaseVersion(tag, versions);
  validateReleaseSecrets(env);
  return { ...version, requiredSecrets: [...REQUIRED_RELEASE_SECRETS] };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tag") result.tag = argv[++index];
    else if (argv[index] === "--root") result.root = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await preflight({
      tag: args.tag || process.env.GITHUB_REF_NAME,
      root: resolve(args.root || join(dirname(fileURLToPath(import.meta.url)), "..")),
    });
    console.log(`release preflight passed for ${result.tag}`);
  } catch (error) {
    console.error(`release preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
