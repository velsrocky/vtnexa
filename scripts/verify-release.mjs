import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tauriConfigUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const updaterPlatforms = new Set([
  "darwin-aarch64",
  "darwin-universal",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-armv7",
  "linux-i686",
  "linux-riscv64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-i686",
  "windows-x86_64",
]);

for (const platform of [
  "darwin-aarch64-app",
  "darwin-universal-app",
  "darwin-x86_64-app",
  "linux-aarch64-appimage",
  "linux-aarch64-deb",
  "linux-aarch64-rpm",
  "linux-armv7-appimage",
  "linux-armv7-deb",
  "linux-armv7-rpm",
  "linux-i686-appimage",
  "linux-i686-deb",
  "linux-i686-rpm",
  "linux-riscv64-appimage",
  "linux-riscv64-deb",
  "linux-riscv64-rpm",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
  "windows-aarch64-msi",
  "windows-aarch64-nsis",
  "windows-i686-msi",
  "windows-i686-nsis",
  "windows-x86_64-msi",
  "windows-x86_64-nsis",
]) {
  updaterPlatforms.add(platform);
}

export class ReleaseVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseVerificationError";
  }
}

function fail(message) {
  throw new ReleaseVerificationError(message);
}

function expectedVersionNumber(value) {
  if (typeof value !== "string" || value.trim() === "") fail("release version is required");
  const version = value.startsWith("v") ? value.slice(1) : value;
  if (!version) fail("release version is required");
  return version;
}

function entriesFromFiles(files) {
  if (files instanceof Map) return files;
  if (files instanceof Set) return new Map([...files].map((name) => [name, undefined]));
  if (Array.isArray(files)) return new Map(files.map((name) => [name, undefined]));
  if (files && typeof files === "object") return new Map(Object.entries(files));
  return new Map();
}

function assetMapEntries(assetMap) {
  if (assetMap instanceof Map) return new Map([...assetMap].map(([id, name]) => [String(id), String(name)]));
  if (assetMap instanceof Set) return new Map([...assetMap].map((value) => [String(value), String(value)]));
  if (Array.isArray(assetMap)) {
    return new Map(assetMap.map((asset) => [String(asset.id), String(asset.name)]));
  }
  if (assetMap && typeof assetMap === "object") return new Map(Object.entries(assetMap).map(([id, name]) => [id, String(name)]));
  return new Map();
}

function binaryFile(entries, name, label) {
  const value = entries.get(name);
  if (!(value instanceof Uint8Array)) fail(`${label} is not a byte artifact: ${name}`);
  return Buffer.from(value);
}

function decodeUtf8(value, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || value === "" || value.length % 4 !== 0 || !base64Pattern.test(value)) {
    fail(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) fail(`${label} is not valid base64`);
  return decoded;
}

function minisignLines(value, expected, label) {
  const normalized = value.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) fail(`${label} has malformed line endings`);
  const content = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = content.split("\n");
  if (lines.length !== expected || lines.some((line) => line === "")) fail(`${label} has a malformed minisign envelope`);
  return lines;
}

export function configuredUpdaterPublicKey() {
  let config;
  try {
    config = JSON.parse(readFileSync(tauriConfigUrl, "utf8"));
  } catch (error) {
    fail(`Tauri updater configuration is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const publicKey = config?.plugins?.updater?.pubkey;
  if (typeof publicKey !== "string" || publicKey.trim() === "") fail("Tauri updater public key is missing");
  return publicKey;
}

function parseUpdaterPublicKey(encoded) {
  const text = decodeUtf8(decodeBase64(encoded, "Tauri updater public key"), "Tauri updater public key");
  const lines = minisignLines(text, 2, "Tauri updater public key");
  // The comment carries the key id as hex, but `tauri signer generate` drops
  // leading zeros (~6% of ids start with a 0x00-0x0F high byte -> 15 hex chars).
  // The id used for verification is the payload bytes below, so the comment is
  // decorative: accept 1-16 hex rather than failing a valid key.
  if (!/^untrusted comment: minisign public key(?::)? [0-9a-f]{1,16}$/i.test(lines[0])) {
    fail("Tauri updater public key has a malformed comment");
  }
  const payload = decodeBase64(lines[1], "Tauri updater public key payload");
  if (payload.length !== 42) fail("Tauri updater public key payload has an invalid length");
  const algorithm = payload.toString("latin1", 0, 2);
  if (algorithm !== "Ed" && algorithm !== "ED") fail("Tauri updater public key uses an unsupported algorithm");
  const keyId = payload.subarray(2, 10);
  let key;
  try {
    key = createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, payload.subarray(10)]),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("Tauri updater public key is not a valid Ed25519 key");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("Tauri updater public key is not an Ed25519 key");
  return { key, keyId };
}

function parseUpdaterSignature(encoded, label) {
  const text = decodeUtf8(decodeBase64(encoded, label), label);
  const lines = minisignLines(text, 4, label);
  if (!lines[0].startsWith("untrusted comment: ") || lines[0].length === "untrusted comment: ".length) {
    fail(`${label} has a malformed untrusted comment`);
  }
  if (!lines[2].startsWith("trusted comment: ") || lines[2].length === "trusted comment: ".length) {
    fail(`${label} has a malformed trusted comment`);
  }
  const payload = decodeBase64(lines[1], `${label} payload`);
  const globalSignature = decodeBase64(lines[3], `${label} global signature`);
  if (payload.length !== 74) fail(`${label} payload has an invalid length`);
  if (globalSignature.length !== 64) fail(`${label} global signature has an invalid length`);
  const algorithm = payload.toString("latin1", 0, 2);
  if (algorithm !== "Ed" && algorithm !== "ED") fail(`${label} uses an unsupported algorithm`);
  return {
    algorithm,
    globalSignature,
    keyId: payload.subarray(2, 10),
    signature: payload.subarray(10),
    trustedComment: Buffer.from(lines[2].slice("trusted comment: ".length), "utf8"),
  };
}

function verifyUpdaterSignature(artifact, signature, publicKey, platform, asset) {
  if (!signature.keyId.equals(publicKey.keyId)) {
    fail(`updater signature key ID does not match for ${platform}: ${asset}`);
  }
  const signedBytes = signature.algorithm === "ED" ? createHash("blake2b512").update(artifact).digest() : artifact;
  if (!verifyEd25519(null, signedBytes, publicKey.key, signature.signature)) {
    fail(`updater signature verification failed for ${platform}: ${asset}`);
  }
  const globalBytes = Buffer.concat([signature.signature, signature.trustedComment]);
  if (!verifyEd25519(null, globalBytes, publicKey.key, signature.globalSignature)) {
    fail(`updater trusted-comment verification failed for ${platform}: ${asset}`);
  }
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    fail("latest.json contains a malformed URL path");
  }
}

function assertRepository(pathname, repository) {
  if (!repository) return;
  const match = pathname.match(/^\/(?:repos\/)?([^/]+)\/([^/]+)\/releases\/(?:assets|download)\//);
  if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) {
    fail("latest.json asset URL points to a different repository");
  }
}

function assetFromUrl(rawUrl, expectedVersion, assetMap, repository) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") fail("latest.json contains an empty asset URL");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("latest.json contains a malformed asset URL");
  }
  if (url.protocol !== "https:" || !["github.com", "api.github.com"].includes(url.hostname) || url.username || url.password || url.hash) {
    fail("latest.json contains an unsafe asset URL");
  }
  const pathname = decodePathname(url.pathname);
  assertRepository(pathname, repository);
  const apiMarker = "/releases/assets/";
  const apiIndex = pathname.indexOf(apiMarker);
  let asset;
  if (url.hostname === "api.github.com" && apiIndex >= 0) {
    const assetId = pathname.slice(apiIndex + apiMarker.length).split("/")[0];
    if (!/^\d+$/.test(assetId)) fail("latest.json contains an invalid GitHub asset URL");
    asset = assetMap.get(assetId);
    if (!asset) fail(`latest.json asset ${assetId} was not downloaded`);
  } else {
    const releaseMarker = "/releases/download/";
    const markerIndex = pathname.indexOf(releaseMarker);
    if (url.hostname !== "github.com" || markerIndex < 0) fail("latest.json asset URL is not a GitHub release URL");
    const tag = pathname.slice(markerIndex + releaseMarker.length).split("/")[0];
    if (tag !== `v${expectedVersion}`) fail("latest.json asset URL points to a different release tag");
    asset = pathname.split("/").pop() || "";
  }
  if (!asset || asset === "." || asset === ".." || /[\\/]/.test(asset)) {
    fail("latest.json contains an invalid asset filename");
  }
  return asset;
}

function verifyEntry({ platform, entry, entries, expectedVersion, assetMap, repository, publicKey, seenAssets }) {
  if (!updaterPlatforms.has(platform)) fail(`latest.json contains an unsupported updater platform: ${platform}`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`updater platform ${platform} is malformed`);
  if (typeof entry.signature !== "string" || entry.signature.trim() === "") {
    fail(`updater platform ${platform} has no signature`);
  }
  const entryKeys = Object.keys(entry);
  if (entryKeys.length !== 2 || !entryKeys.includes("signature") || !entryKeys.includes("url")) {
    fail(`updater platform ${platform} has unexpected fields`);
  }
  const asset = assetFromUrl(entry.url, expectedVersion, assetMap, repository);
  const previousSignature = seenAssets.get(asset);
  if (previousSignature !== undefined && previousSignature !== entry.signature) {
    fail(`latest.json maps one asset to mismatched signatures: ${asset}`);
  }
  seenAssets.set(asset, entry.signature);
  if (!entries.has(asset)) fail(`missing updater asset ${asset}`);
  const signatureAsset = `${asset}.sig`;
  if (!entries.has(signatureAsset)) fail(`missing updater signature ${signatureAsset}`);
  const artifact = binaryFile(entries, asset, "updater artifact");
  const signatureFile = decodeUtf8(binaryFile(entries, signatureAsset, "updater signature file"), "updater signature file");
  if (signatureFile !== entry.signature) fail(`signature content does not match for ${asset}`);
  const signature = parseUpdaterSignature(entry.signature, `updater signature for ${platform}`);
  verifyUpdaterSignature(artifact, signature, publicKey, platform, asset);
  return { platform, asset, signatureAsset };
}

function windowsInstallerNames(entries, windowsAssets) {
  const names = [...entries.keys()];
  const platformInstallers = [...windowsAssets].filter((name) => /\.(exe|msi|msi\.zip|nsis\.zip)$/i.test(name));
  if (platformInstallers.length === 0) fail("latest.json has no Windows installer updater asset");
  const executable = names.find((name) => name.toLowerCase().endsWith(".exe"));
  const msi = names.find((name) => name.toLowerCase().endsWith(".msi"));
  if (!executable) fail("release is missing a Windows executable installer artifact");
  if (!msi) fail("release is missing a Windows MSI installer artifact");
  return [executable, msi];
}

function assertUniqueJsonKeys(text) {
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') break;
        end += 1;
      }
      if (end >= text.length) return;
      const frame = stack.at(-1);
      if (frame?.type === "object" && frame.expectingKey) {
        let key;
        try {
          key = JSON.parse(text.slice(index, end + 1));
        } catch {
          index = end + 1;
          continue;
        }
        if (frame.keys.has(key)) fail(`latest.json contains duplicate object key: ${key}`);
        frame.keys.add(key);
        frame.expectingKey = false;
      }
      index = end + 1;
      continue;
    }
    if (character === "{") {
      stack.push({ type: "object", keys: new Set(), expectingKey: true });
    } else if (character === "[") {
      stack.push({ type: "array" });
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.type === "object") frame.expectingKey = true;
    }
    index += 1;
  }
}

export function verifyReleaseManifest({
  manifest,
  files,
  expectedVersion,
  assetMap = new Map(),
  repository = "",
  publicKey = configuredUpdaterPublicKey(),
}) {
  const version = expectedVersionNumber(expectedVersion);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("latest.json is malformed");
  if (manifest.version !== version) fail(`latest.json version does not match v${version}`);
  if (!manifest.platforms || typeof manifest.platforms !== "object" || Array.isArray(manifest.platforms)) {
    fail("latest.json has no updater platforms object");
  }
  const parsedPublicKey = parseUpdaterPublicKey(publicKey);
  const entries = entriesFromFiles(files);
  const mappedAssets = assetMapEntries(assetMap);
  const seenAssets = new Map();
  const checked = [];
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!platform.trim()) fail("latest.json contains an empty platform key");
    checked.push(
      verifyEntry({
        platform,
        entry,
        entries,
        expectedVersion: version,
        assetMap: mappedAssets,
        repository,
        publicKey: parsedPublicKey,
        seenAssets,
      }),
    );
  }
  if (checked.length === 0) fail("latest.json has no updater platform assets");
  const windowsAssets = new Set(
    checked.filter(({ platform }) => platform.startsWith("windows-")).map(({ asset }) => asset),
  );
  if (windowsAssets.size === 0) fail("latest.json has no Windows updater platform");
  const windowsInstallers = windowsInstallerNames(entries, windowsAssets);
  return { version, assets: checked.map(({ asset }) => asset), windowsInstallers };
}

export async function verifyReleaseDirectory({
  directory,
  expectedVersion,
  assetMap = new Map(),
  repository = "",
  publicKey = configuredUpdaterPublicKey(),
}) {
  let names;
  try {
    names = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail(`release asset directory is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = new Map();
  for (const entry of names) {
    if (entry.isFile()) files.set(entry.name, await readFile(join(directory, entry.name)));
  }
  if (!files.has("latest.json")) fail("release is missing latest.json");
  let manifest;
  try {
    const manifestText = decodeUtf8(binaryFile(files, "latest.json", "release manifest"), "latest.json");
    assertUniqueJsonKeys(manifestText);
    manifest = JSON.parse(manifestText);
  } catch (error) {
    fail(`latest.json is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return verifyReleaseManifest({ manifest, files, expectedVersion, assetMap, repository, publicKey });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--directory" || argv[index] === "--dir") result.directory = argv[++index];
    else if (argv[index] === "--tag" || argv[index] === "--version") result.version = argv[++index];
    else if (argv[index] === "--asset-map") result.assetMap = argv[++index];
    else if (argv[index] === "--repository") result.repository = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.directory || !args.version) throw new Error("usage: node scripts/verify-release.mjs --directory <dir> --tag v<version> [--asset-map <file>] [--repository owner/name]");
    const assetMap = args.assetMap ? JSON.parse(await readFile(args.assetMap, "utf8")) : new Map();
    const result = await verifyReleaseDirectory({
      directory: args.directory,
      expectedVersion: args.version,
      assetMap,
      repository: args.repository || process.env.GITHUB_REPOSITORY || "",
    });
    console.log(`release verification passed for v${result.version} with ${result.assets.length} updater assets`);
  } catch (error) {
    console.error(`release verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
