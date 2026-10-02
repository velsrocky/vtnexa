import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const NODE_VERSION = "24.18.0";

export const NODE_ARCHIVES = Object.freeze({
  "aix-ppc64": {
    archive: "node-v24.18.0-aix-ppc64.tar.gz",
    sha256: "6463a23739f6b2300ebec5ccd60275e138e3858fc1afc6e8f9bc4e4f6a4b76fa",
    format: "tar.gz",
  },
  "darwin-arm64": {
    archive: "node-v24.18.0-darwin-arm64.tar.gz",
    sha256: "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
    format: "tar.gz",
  },
  "darwin-x64": {
    archive: "node-v24.18.0-darwin-x64.tar.gz",
    sha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    format: "tar.gz",
  },
  "linux-arm64": {
    archive: "node-v24.18.0-linux-arm64.tar.gz",
    sha256: "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
    format: "tar.gz",
  },
  "linux-ppc64le": {
    archive: "node-v24.18.0-linux-ppc64le.tar.gz",
    sha256: "fe1338972f79283c6bc21e61dbf4576bbe8c05aded2999d41c8643ad30265142",
    format: "tar.gz",
  },
  "linux-s390x": {
    archive: "node-v24.18.0-linux-s390x.tar.gz",
    sha256: "371ebc13945fc169493e752f2ddafafab6ecd8ccb451bcff46e09f69c5dd8c7a",
    format: "tar.gz",
  },
  "linux-x64": {
    archive: "node-v24.18.0-linux-x64.tar.gz",
    sha256: "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
    format: "tar.gz",
  },
  "win32-arm64": {
    archive: "node-v24.18.0-win-arm64.zip",
    sha256: "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
    format: "zip",
  },
  "win32-x64": {
    archive: "node-v24.18.0-win-x64.zip",
    sha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    format: "zip",
  },
});

const PLATFORM_ALIASES = Object.freeze({
  aix: "aix",
  darwin: "darwin",
  linux: "linux",
  mac: "darwin",
  macos: "darwin",
  win32: "win32",
  windows: "win32",
});

const ARCH_ALIASES = Object.freeze({
  aarch64: "arm64",
  amd64: "x64",
  arm64: "arm64",
  ppc64: "ppc64",
  ppc64le: "ppc64le",
  s390x: "s390x",
  x64: "x64",
  x86_64: "x64",
});

export function normalizePlatform(platform = process.platform) {
  return PLATFORM_ALIASES[platform] ?? platform;
}

export function normalizeArch(arch = process.arch) {
  return ARCH_ALIASES[arch] ?? arch;
}

export function platformArchive(platform = process.platform, arch = process.arch) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  const key = `${normalizedPlatform}-${normalizedArch}`;
  const record = NODE_ARCHIVES[key];
  if (!record) {
    throw new Error(
      `node runtime: unsupported host ${platform}/${arch}; supported hosts: ${Object.keys(NODE_ARCHIVES).join(", ")}`,
    );
  }
  return {
    key,
    platform: normalizedPlatform,
    arch: normalizedArch,
    executable: normalizedPlatform === "win32" ? "node.exe" : "node",
    ...record,
  };
}

export const archiveForPlatform = platformArchive;
export const getNodeArchive = platformArchive;

export function archiveUrl(platform = process.platform, arch = process.arch) {
  const descriptor = platformArchive(platform, arch);
  return `https://nodejs.org/dist/v${NODE_VERSION}/${descriptor.archive}`;
}

export function requiredRuntimeFiles(platform = process.platform, arch = process.arch) {
  const descriptor = platformArchive(platform, arch);
  return [descriptor.executable, "node-license.txt", "node-version.txt", "node-runtime.json"];
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function executableVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("node runtime: executable version check timed out"));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 256) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 256) stderr += chunk.toString();
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (code === 0) finish(resolve, stdout.trim());
      else finish(reject, new Error(`node runtime: executable version check exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function downloadArchive(url, destination, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response || response.ok === false) {
    throw new Error(`node runtime: download failed (${response?.status ?? "unknown status"})`);
  }
  if (!response.body) throw new Error("node runtime: download returned no body");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function assertChecksum(filePath, expected, label) {
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `node runtime: SHA-256 mismatch for ${label}; expected ${expected}, got ${actual}`,
    );
  }
  return actual;
}

async function ensureArchive(descriptor, options) {
  const override =
    options.archivePath ??
    process.env.VTAI_NODE_ARCHIVE ??
    process.env.VTAI_NODE_ARCHIVE_PATH ??
    process.env.VTNEXA_NODE_ARCHIVE ??
    process.env.NODE_RUNTIME_ARCHIVE;
  if (override) {
    const source = join(override);
    if (!(await exists(source))) {
      throw new Error(`node runtime: local archive override not found: ${source}`);
    }
    await assertChecksum(source, descriptor.sha256, source);
    return { path: source, cached: false };
  }

  const cacheDir = options.cacheDir ?? join(process.cwd(), ".cache", "node-runtime", NODE_VERSION);
  const cached = join(cacheDir, descriptor.archive);
  await mkdir(cacheDir, { recursive: true });
  if (await exists(cached)) {
    await assertChecksum(cached, descriptor.sha256, cached);
    return { path: cached, cached: true };
  }
  if (options.offline) {
    throw new Error("node runtime: offline mode requires a verified cached archive or VTAI_NODE_ARCHIVE/--archive");
  }

  const temporaryDir = await mkdtemp(join(cacheDir, ".download-"));
  const temporary = join(temporaryDir, descriptor.archive);
  const url = archiveUrl(descriptor.platform, descriptor.arch);
  try {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("node runtime: no download implementation; set VTAI_NODE_ARCHIVE for offline provisioning");
    }
    await downloadArchive(url, temporary, fetchImpl);
    await assertChecksum(temporary, descriptor.sha256, temporary);
    await rename(temporary, cached);
    return { path: cached, cached: false };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function findFile(root, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (wanted.has(entry.name.toLowerCase())) return full;
    }
  }
  return null;
}

async function extractArchive(archivePath, descriptor) {
  const destination = await mkdtemp(join(tmpdir(), "vtnexa-node-"));
  try {
    if (descriptor.format === "zip") {
      if (process.platform === "win32") {
        const powershell = process.env.ComSpec ? "powershell.exe" : "pwsh";
        const escapedArchive = archivePath.replaceAll("'", "''");
        const escapedDestination = destination.replaceAll("'", "''");
        await runCommand(powershell, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
        ]);
      } else {
        await runCommand("unzip", ["-q", archivePath, "-d", destination]);
      }
    } else {
      await runCommand("tar", ["-xzf", archivePath, "-C", destination]);
    }
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw new Error(`node runtime: archive extraction failed: ${error.message}`);
  }
}

async function pathEntryExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function replaceDirectoryAtomically(source, destination) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const backup = join(parent, `.${basename(destination)}.previous-${randomUUID()}`);
  let moved = false;
  try {
    if (await pathEntryExists(destination)) {
      await rename(destination, backup);
      moved = true;
    }
    await rename(source, destination);
  } catch (error) {
    if (moved) {
      try {
        await rename(backup, destination);
      } catch {
      }
    }
    throw error;
  }
  if (moved) {
    try {
      await rm(backup, { recursive: true, force: true });
    } catch {
    }
  }
}

async function stageRuntime(archivePath, descriptor, stageDir, options = {}) {
  await assertChecksum(archivePath, descriptor.sha256, archivePath);
  const extract = options.extractArchive || extractArchive;
  const versionChecker = options.executableVersion || executableVersion;
  let archiveCopyDir = null;
  let extracted = null;
  let candidate = null;
  try {
    if (!descriptor.archive || basename(descriptor.archive) !== descriptor.archive) {
      throw new Error("node runtime: invalid archive name");
    }
    archiveCopyDir = await mkdtemp(join(tmpdir(), "vtnexa-node-archive-"));
    const archiveCopy = join(archiveCopyDir, descriptor.archive);
    await copyFile(archivePath, archiveCopy);
    await assertChecksum(archiveCopy, descriptor.sha256, archiveCopy);
    extracted = await extract(archiveCopy, descriptor);
    if (!extracted) throw new Error("node runtime: archive extraction returned no directory");
    const executable = await findFile(extracted, [descriptor.executable]);
    const license = await findFile(extracted, ["LICENSE", "LICENSE.txt", "LICENSE.md"]);
    const executableName = executable ? basename(executable) : "";
    const executableMatches = descriptor.platform === "win32"
      ? executableName.toLowerCase() === descriptor.executable.toLowerCase()
      : executableName === descriptor.executable;
    if (!executable || !executableMatches) {
      throw new Error(`node runtime: archive has no expected executable ${descriptor.executable}`);
    }
    if (!license) throw new Error("node runtime: archive has no Node license");
    const archiveVersion = (await versionChecker(executable)).replace(/^v/, "");
    if (archiveVersion !== NODE_VERSION) {
      throw new Error(`node runtime: archive version mismatch; expected ${NODE_VERSION}, got ${archiveVersion}`);
    }

    await mkdir(dirname(stageDir), { recursive: true });
    candidate = await mkdtemp(join(dirname(stageDir), `.${basename(stageDir)}-runtime-`));
    const stagedExecutable = join(candidate, descriptor.executable);
    await copyFile(executable, stagedExecutable);
    if (descriptor.platform !== "win32") await chmod(stagedExecutable, 0o755);
    await copyFile(license, join(candidate, "node-license.txt"));
    await writeFile(join(candidate, "node-version.txt"), `${NODE_VERSION}\n`, "utf8");
    const executableSha256 = await sha256File(stagedExecutable);
    await writeFile(
      join(candidate, "node-runtime.json"),
      `${JSON.stringify({
        version: NODE_VERSION,
        platform: descriptor.platform,
        arch: descriptor.arch,
        archive: descriptor.archive,
        archiveSha256: descriptor.sha256,
        executable: descriptor.executable,
        executableSha256,
      })}\n`,
      "utf8",
    );
    if (!(await runtimeMatchesDescriptor(candidate, descriptor))) {
      throw new Error("node runtime: extracted runtime verification failed");
    }
    await replaceDirectoryAtomically(candidate, stageDir);
    candidate = null;
    return {
      files: [descriptor.executable, "node-license.txt", "node-version.txt", "node-runtime.json"],
      executableSha256,
    };
  } finally {
    if (extracted) await rm(extracted, { recursive: true, force: true });
    if (candidate) await rm(candidate, { recursive: true, force: true });
    if (archiveCopyDir) await rm(archiveCopyDir, { recursive: true, force: true });
  }
}

async function runtimeMatchesDescriptor(stageDir, descriptor) {
  const files = [descriptor.executable, "node-license.txt", "node-version.txt", "node-runtime.json"];
  for (const file of files) {
    try {
      const info = await stat(join(stageDir, file));
      if (!info.isFile() || info.size === 0) return false;
    } catch {
      return false;
    }
  }
  try {
    const version = (await readFile(join(stageDir, "node-version.txt"), "utf8")).trim();
    const manifest = JSON.parse(await readFile(join(stageDir, "node-runtime.json"), "utf8"));
    if (
      version !== NODE_VERSION ||
      manifest.version !== NODE_VERSION ||
      manifest.platform !== descriptor.platform ||
      manifest.arch !== descriptor.arch ||
      manifest.archive !== descriptor.archive ||
      manifest.archiveSha256 !== descriptor.sha256 ||
      manifest.executable !== descriptor.executable
    ) {
      return false;
    }
    if (typeof manifest.executableSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.executableSha256)) {
      return false;
    }
    return (await sha256File(join(stageDir, descriptor.executable))) === manifest.executableSha256.toLowerCase();
  } catch {
    return false;
  }
}

export async function runtimeReady(stageDir, platform = process.platform, arch = process.arch) {
  const descriptor = typeof platform === "object" ? platform : platformArchive(platform, arch);
  return runtimeMatchesDescriptor(stageDir, descriptor);
}

export async function provisionNode(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const descriptor = options.descriptor ?? platformArchive(platform, arch);
  const stageDir = options.stageDir ?? join(process.cwd(), "src-tauri", "sidecar-stage", "browser");
  const existingStage = await pathEntryExists(stageDir);
  let archive;
  try {
    archive = await ensureArchive(descriptor, options);
  } catch (error) {
    if (existingStage) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}; the existing staged Node runtime is not trusted without its official archive; run pnpm provision-node`,
      );
    }
    throw error;
  }
  const staged = await stageRuntime(archive.path, descriptor, stageDir, options);
  if (!(await runtimeMatchesDescriptor(stageDir, descriptor))) {
    throw new Error("node runtime: staged runtime verification failed");
  }
  return { reused: false, cachedArchive: archive.cached, descriptor, stageDir, ...staged };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--archive") result.archivePath = argv[++i];
    if (arg === "--offline") result.offline = true;
    if (arg === "--platform") result.platform = argv[++i];
    if (arg === "--arch") result.arch = argv[++i];
    if (arg === "--cache") result.cacheDir = argv[++i];
    if (arg === "--stage") result.stageDir = argv[++i];
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await provisionNode(parseArgs(process.argv.slice(2)));
    console.log(
      `provision-node: ${result.reused ? "reused" : "staged"} Node ${NODE_VERSION} (${result.descriptor.key}) in ${result.stageDir}`,
    );
  } catch (error) {
    console.error(`provision-node: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
