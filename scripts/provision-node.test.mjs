import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NODE_VERSION,
  platformArchive,
  provisionNode,
  requiredRuntimeFiles,
  runtimeReady,
  sha256File,
} from "./provision-node.mjs";

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "vtnexa-provision-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("Node runtime provisioning", () => {
  it("maps supported hosts to exact official archives", () => {
    assert.deepEqual(platformArchive("win32", "x64"), {
      key: "win32-x64",
      platform: "win32",
      arch: "x64",
      executable: "node.exe",
      archive: "node-v24.18.0-win-x64.zip",
      sha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
      format: "zip",
    });
    assert.equal(platformArchive("macos", "aarch64").key, "darwin-arm64");
    assert.equal(platformArchive("linux", "x86_64").key, "linux-x64");
    assert.throws(() => platformArchive("linux", "mips"), /unsupported host/);
  });

  it("rejects a local archive whose checksum does not match the pin", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "node.zip");
    const stageDir = join(root, "stage");
    await writeFile(archive, "not the pinned archive");
    const descriptor = { ...platformArchive("win32", "x64"), sha256: "0".repeat(64) };
    await assert.rejects(
      provisionNode({ descriptor, archivePath: archive, stageDir }),
      /SHA-256 mismatch/,
    );
    await assert.rejects(readFile(join(stageDir, "node.exe")), /ENOENT/);
  });

  it("rejects a self-authenticated staged executable without a trusted archive", async () => {
    const root = await temporaryDirectory();
    const stageDir = join(root, "stage");
    const cacheDir = join(root, "cache");
    const descriptor = platformArchive("linux", "x64");
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, descriptor.executable), "attacker runtime");
    await writeFile(join(stageDir, "node-license.txt"), "license");
    await writeFile(join(stageDir, "node-version.txt"), `${NODE_VERSION}\n`);
    await writeFile(
      join(stageDir, "node-runtime.json"),
      JSON.stringify({
        version: NODE_VERSION,
        platform: descriptor.platform,
        arch: descriptor.arch,
        archive: descriptor.archive,
        archiveSha256: descriptor.sha256,
        executable: descriptor.executable,
        executableSha256: await sha256File(join(stageDir, descriptor.executable)),
      }),
    );
    assert.equal(await runtimeReady(stageDir, descriptor), true);
    await assert.rejects(
      provisionNode({ descriptor, offline: true, cacheDir, stageDir }),
      /pnpm provision-node/,
    );
  });

  it("accepts only archive-backed verified staging and replaces the stage atomically", async () => {
    const root = await temporaryDirectory();
    const stageDir = join(root, "stage");
    const payloadDir = join(root, "payload");
    const archive = join(root, "verified.archive");
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, "sentinel"), "old");
    await mkdir(payloadDir, { recursive: true });
    await writeFile(join(payloadDir, "node"), "verified runtime");
    await writeFile(join(payloadDir, "LICENSE"), "license");
    await writeFile(archive, "archive bytes");
    const descriptor = {
      key: "test-linux-x64",
      platform: "linux",
      arch: "x64",
      executable: "node",
      archive: "verified.archive",
      sha256: await sha256File(archive),
      format: "tar.gz",
    };
    const result = await provisionNode({
      descriptor,
      archivePath: archive,
      stageDir,
      extractArchive: async () => payloadDir,
      executableVersion: async () => `v${NODE_VERSION}`,
    });
    assert.equal(result.reused, false);
    assert.deepEqual(result.files, requiredRuntimeFiles("linux", "x64"));
    assert.equal(await readFile(join(stageDir, "node"), "utf8"), "verified runtime");
    assert.equal(await readFile(join(stageDir, "sentinel"), "utf8").catch(() => ""), "");
    assert.equal(await runtimeReady(stageDir, descriptor), true);
  });

  it("rejects an archive with the wrong executable or version before replacement", async () => {
    for (const failure of ["executable", "version"]) {
      const root = await temporaryDirectory();
      const stageDir = join(root, "stage");
      const payloadDir = join(root, "payload");
      const archive = join(root, "verified.archive");
      await mkdir(stageDir, { recursive: true });
      await writeFile(join(stageDir, "sentinel"), "old");
      await mkdir(payloadDir, { recursive: true });
      if (failure === "executable") await writeFile(join(payloadDir, "node.exe"), "wrong executable");
      else {
        await writeFile(join(payloadDir, "node"), "runtime");
        await writeFile(join(payloadDir, "LICENSE"), "license");
      }
      await writeFile(archive, "archive bytes");
      const descriptor = {
        key: "test-linux-x64",
        platform: "linux",
        arch: "x64",
        executable: "node",
        archive: "verified.archive",
        sha256: await sha256File(archive),
        format: "tar.gz",
      };
      await assert.rejects(
        provisionNode({
          descriptor,
          archivePath: archive,
          stageDir,
          extractArchive: async () => payloadDir,
          executableVersion: async () => (failure === "version" ? "v0.0.0" : `v${NODE_VERSION}`),
        }),
        failure === "executable" ? /expected executable/ : /version mismatch/,
      );
      assert.equal(await readFile(join(stageDir, "sentinel"), "utf8"), "old");
    }
  });
  it("rechecks a cached archive before replacing an existing stage", async () => {
    const root = await temporaryDirectory();
    const stageDir = join(root, "stage");
    const cacheDir = join(root, "cache");
    const archive = join(cacheDir, "verified.archive");
    await mkdir(stageDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(stageDir, "sentinel"), "old");
    await writeFile(archive, "archive bytes");
    const descriptor = {
      key: "test-linux-x64",
      platform: "linux",
      arch: "x64",
      executable: "node",
      archive: "verified.archive",
      sha256: await sha256File(archive),
      format: "tar.gz",
    };
    await writeFile(archive, "tampered archive");
    await assert.rejects(
      provisionNode({ descriptor, offline: true, cacheDir, stageDir }),
      /SHA-256 mismatch/,
    );
    assert.equal(await readFile(join(stageDir, "sentinel"), "utf8"), "old");
  });

  it("does not reuse a runtime without an executable digest", async () => {
    const root = await temporaryDirectory();
    const stageDir = join(root, "stage");
    const descriptor = platformArchive("linux", "x64");
    await mkdir(stageDir, { recursive: true });
    for (const file of requiredRuntimeFiles("linux", "x64")) {
      if (file === "node-version.txt") await writeFile(join(stageDir, file), `${NODE_VERSION}\n`);
      else if (file !== "node-runtime.json") await writeFile(join(stageDir, file), "x");
    }
    await writeFile(
      join(stageDir, "node-runtime.json"),
      JSON.stringify({
        version: NODE_VERSION,
        platform: descriptor.platform,
        arch: descriptor.arch,
        archive: descriptor.archive,
        archiveSha256: descriptor.sha256,
        executable: descriptor.executable,
      }),
    );
    assert.equal(await runtimeReady(stageDir, "linux", "x64"), false);
    await assert.rejects(
      provisionNode({ offline: true, cacheDir: join(root, "empty-cache"), stageDir }),
      /offline mode requires/,
    );
  });

  it("fails offline mode without a local archive", async () => {
    const root = await temporaryDirectory();
    await assert.rejects(
      provisionNode({ offline: true, cacheDir: join(root, "empty-cache"), stageDir: join(root, "stage") }),
      /offline mode requires/,
    );
  });

  it("requires every executable, license, and version metadata file", async () => {
    const root = await temporaryDirectory();
    const stageDir = join(root, "stage");
    const descriptor = platformArchive("linux", "x64");
    await mkdir(stageDir, { recursive: true });
    for (const file of requiredRuntimeFiles("linux", "x64")) {
      if (file === "node-version.txt") await writeFile(join(stageDir, file), `${NODE_VERSION}\n`);
      else if (file !== "node-runtime.json") await writeFile(join(stageDir, file), "x");
    }
    await writeFile(
      join(stageDir, "node-runtime.json"),
      JSON.stringify({
        version: NODE_VERSION,
        platform: descriptor.platform,
        arch: descriptor.arch,
        archive: descriptor.archive,
        archiveSha256: descriptor.sha256,
        executable: descriptor.executable,
        executableSha256: await sha256File(join(stageDir, descriptor.executable)),
      }),
    );
    assert.equal(await runtimeReady(stageDir, "linux", "x64"), true);
    await rm(join(stageDir, "node-license.txt"));
    assert.equal(await runtimeReady(stageDir, "linux", "x64"), false);
    await writeFile(join(stageDir, "node-license.txt"), "license");
    await rm(join(stageDir, "node-runtime.json"));
    assert.equal(await runtimeReady(stageDir, "linux", "x64"), false);
  });
});
