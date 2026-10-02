import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyReleaseDirectory, verifyReleaseManifest } from "./verify-release.mjs";

const execFileAsync = promisify(execFile);
const tauriCli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const temporaryDirectories = [];
const version = "1.2.3";
const windowsAsset = "VTNexa_1.2.3_x64-setup.exe";
const msiAsset = "VTNexa_1.2.3_x64_en-US.msi";
const linuxAsset = "VTNexa_1.2.3_amd64.AppImage";
const artifacts = new Map([
  [windowsAsset, Buffer.from("windows updater artifact")],
  [msiAsset, Buffer.from("msi updater artifact")],
  [linuxAsset, Buffer.from("linux updater artifact")],
]);

let signingDirectory;
let trustedPublicKey;
let wrongPublicKey;
let trustedSignatures;
let forgedLinuxSignature;

async function generateKeypair(name) {
  const privateKeyPath = join(signingDirectory, `${name}.key`);
  await execFileAsync(process.execPath, [
    tauriCli,
    "signer",
    "generate",
    "--ci",
    "--password",
    "",
    "--write-keys",
    privateKeyPath,
  ]);
  const publicKey = (await readFile(`${privateKeyPath}.pub`, "utf8")).trim().replace(/:$/, "");
  return { privateKeyPath, publicKey };
}

async function signArtifact(asset, privateKeyPath) {
  const path = join(signingDirectory, asset);
  await writeFile(path, artifacts.get(asset));
  await execFileAsync(process.execPath, [
    tauriCli,
    "signer",
    "sign",
    "--private-key-path",
    privateKeyPath,
    "--password",
    "",
    path,
  ]);
  return readFile(`${path}.sig`);
}

function withEnvelopeKeyId(envelope, keyIdEnvelope) {
  const encoded = Buffer.isBuffer(envelope) ? envelope.toString("utf8") : envelope;
  const keyIdEncoded = Buffer.isBuffer(keyIdEnvelope) ? keyIdEnvelope.toString("utf8") : keyIdEnvelope;
  const text = Buffer.from(encoded, "base64").toString("utf8");
  const keyIdText = Buffer.from(keyIdEncoded, "base64").toString("utf8");
  const lines = text.trimEnd().split("\n");
  const keyIdLines = keyIdText.trimEnd().split("\n");
  const payload = Buffer.from(lines[1], "base64");
  const keyIdPayload = Buffer.from(keyIdLines[1], "base64");
  payload.set(keyIdPayload.subarray(2, 10), 2);
  lines[1] = payload.toString("base64");
  return Buffer.from(lines.join("\n") + (text.endsWith("\n") ? "\n" : ""), "utf8").toString("base64");
}

function validFixture() {
  return {
    version,
    platforms: {
      "windows-x86_64": {
        signature: trustedSignatures.get(windowsAsset).toString("utf8"),
        url: `https://github.com/velsrocky/vtnexa/releases/download/v${version}/${windowsAsset}`,
      },
      "windows-x86_64-nsis": {
        signature: trustedSignatures.get(windowsAsset).toString("utf8"),
        url: `https://github.com/velsrocky/vtnexa/releases/download/v${version}/${windowsAsset}`,
      },
      "windows-x86_64-msi": {
        signature: trustedSignatures.get(msiAsset).toString("utf8"),
        url: `https://github.com/velsrocky/vtnexa/releases/download/v${version}/${msiAsset}`,
      },
      "linux-x86_64": {
        signature: trustedSignatures.get(linuxAsset).toString("utf8"),
        url: `https://github.com/velsrocky/vtnexa/releases/download/v${version}/${linuxAsset}`,
      },
      "linux-x86_64-appimage": {
        signature: trustedSignatures.get(linuxAsset).toString("utf8"),
        url: `https://github.com/velsrocky/vtnexa/releases/download/v${version}/${linuxAsset}`,
      },
    },
  };
}

function validFiles() {
  return new Map([
    ...[...artifacts].map(([asset, bytes]) => [asset, Buffer.from(bytes)]),
    ...[...trustedSignatures].map(([asset, signature]) => [`${asset}.sig`, Buffer.from(signature)]),
  ]);
}

async function createReleaseDirectory(files = validFiles(), latestJson = JSON.stringify(validFixture())) {
  const directory = await mkdtemp(join(tmpdir(), "vtnexa-release-test-"));
  temporaryDirectories.push(directory);
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes);
  if (latestJson !== undefined) await writeFile(join(directory, "latest.json"), latestJson);
  return directory;
}

function verify(overrides = {}) {
  return verifyReleaseManifest({
    manifest: validFixture(),
    files: validFiles(),
    expectedVersion: version,
    publicKey: trustedPublicKey,
    ...overrides,
  });
}

before(async () => {
  signingDirectory = await mkdtemp(join(tmpdir(), "vtnexa-updater-signing-"));
  const trusted = await generateKeypair("trusted");
  const wrong = await generateKeypair("wrong");
  trustedPublicKey = trusted.publicKey;
  wrongPublicKey = wrong.publicKey;
  trustedSignatures = new Map();
  for (const asset of artifacts.keys()) {
    trustedSignatures.set(asset, await signArtifact(asset, trusted.privateKeyPath));
  }
  forgedLinuxSignature = await signArtifact(linuxAsset, wrong.privateKeyPath);
  wrongPublicKey = withEnvelopeKeyId(wrongPublicKey, trustedPublicKey);
  forgedLinuxSignature = Buffer.from(withEnvelopeKeyId(forgedLinuxSignature, trustedPublicKey), "utf8");
});

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

after(async () => {
  if (signingDirectory) await rm(signingDirectory, { recursive: true, force: true });
});

describe("release artifact verifier", () => {
  it("accepts artifacts signed by a real temporary minisign keypair", () => {
    const result = verify();
    assert.deepEqual(result.windowsInstallers, [windowsAsset, msiAsset]);
    assert.equal(result.assets.length, 5);
  });

  it("maps GitHub API asset URLs to downloaded artifact bytes", () => {
    const manifest = validFixture();
    const ids = new Map([
      ["windows-x86_64", 101],
      ["windows-x86_64-nsis", 102],
      ["windows-x86_64-msi", 103],
      ["linux-x86_64", 104],
      ["linux-x86_64-appimage", 105],
    ]);
    for (const [platform, id] of ids) {
      manifest.platforms[platform].url = `https://api.github.com/repos/velsrocky/vtnexa/releases/assets/${id}`;
    }
    const result = verify({
      manifest,
      assetMap: Object.fromEntries([...ids].map(([platform, id]) => [id, {
        "windows-x86_64": windowsAsset,
        "windows-x86_64-nsis": windowsAsset,
        "windows-x86_64-msi": msiAsset,
        "linux-x86_64": linuxAsset,
        "linux-x86_64-appimage": linuxAsset,
      }[platform]])),
    });
    assert.deepEqual(new Set(result.assets), new Set([windowsAsset, msiAsset, linuxAsset]));
  });

  it("rejects a release without latest.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vtnexa-release-test-"));
    temporaryDirectories.push(directory);
    await assert.rejects(
      verifyReleaseDirectory({ directory, expectedVersion: version, publicKey: trustedPublicKey }),
      /missing latest\.json/,
    );
  });

  it("rejects a missing platform signature", () => {
    const manifest = validFixture();
    delete manifest.platforms["linux-x86_64"].signature;
    assert.throws(() => verify({ manifest }), /has no signature/);
  });

  it("rejects a missing updater signature file", () => {
    const files = validFiles();
    files.delete(`${windowsAsset}.sig`);
    assert.throws(() => verify({ files }), /missing updater signature/);
  });

  it("rejects a wrong manifest version", () => {
    const manifest = validFixture();
    manifest.version = "9.9.9";
    assert.throws(() => verify({ manifest }), /version does not match/);
  });

  it("rejects malformed asset URLs", () => {
    const manifest = validFixture();
    manifest.platforms["linux-x86_64"].url = "not-a-url";
    assert.throws(() => verify({ manifest }), /malformed asset URL/);
  });

  it("rejects a release without both Windows installer artifacts", () => {
    const manifest = validFixture();
    const files = validFiles();
    delete manifest.platforms["windows-x86_64-msi"];
    files.delete(msiAsset);
    assert.throws(() => verify({ manifest, files }), /missing a Windows MSI/);
  });

  it("rejects a signature file that does not match latest.json", () => {
    const files = validFiles();
    files.set(`${windowsAsset}.sig`, Buffer.from(trustedSignatures.get(linuxAsset)));
    assert.throws(() => verify({ files }), /signature content does not match/);
  });

  it("rejects tampered artifact bytes", () => {
    const files = validFiles();
    files.set(windowsAsset, Buffer.from("tampered windows updater artifact"));
    assert.throws(() => verify({ files }), /signature verification failed/);
  });

  it("rejects a forged minisign signature", () => {
    const manifest = validFixture();
    const files = validFiles();
    const forged = forgedLinuxSignature.toString("utf8");
    manifest.platforms["linux-x86_64"].signature = forged;
    files.set(`${linuxAsset}.sig`, forgedLinuxSignature);
    assert.throws(() => verify({ manifest, files }), /signature verification failed/);
  });

  it("rejects matching manifest and signature text verified with the wrong key", () => {
    assert.throws(() => verify({ publicKey: wrongPublicKey }), /signature verification failed/);
  });

  it("rejects a signature mapped to different artifact bytes", () => {
    const manifest = validFixture();
    const files = validFiles();
    delete manifest.platforms["windows-x86_64-msi"];
    manifest.platforms["linux-x86_64"].url = `https://github.com/velsrocky/vtnexa/releases/download/v${version}/${msiAsset}`;
    files.set(`${msiAsset}.sig`, Buffer.from(trustedSignatures.get(linuxAsset)));
    assert.throws(() => verify({ manifest, files }), /signature verification failed/);
  });

  it("rejects a malformed updater public key", () => {
    assert.throws(() => verify({ publicKey: "not-base64" }), /public key is not valid base64/);
  });

  it("rejects a malformed updater signature", () => {
    const manifest = validFixture();
    const files = validFiles();
    manifest.platforms["linux-x86_64"].signature = "not-base64";
    files.set(`${linuxAsset}.sig`, Buffer.from("not-base64"));
    assert.throws(() => verify({ manifest, files }), /signature for linux-x86_64 is not valid base64/);
  });

  it("rejects unexpected platform entry fields", () => {
    const manifest = validFixture();
    manifest.platforms["linux-x86_64"].digest = "sha256:fake";
    assert.throws(() => verify({ manifest }), /unexpected fields/);
  });

  it("rejects extra updater platform entries", () => {
    const manifest = validFixture();
    manifest.platforms["freebsd-x86_64"] = { ...manifest.platforms["linux-x86_64"] };
    assert.throws(() => verify({ manifest }), /unsupported updater platform/);
  });

  it("rejects duplicate platform entries in latest.json", async () => {
    const entry = validFixture().platforms["windows-x86_64"];
    const duplicateEntry = JSON.stringify(entry);
    const latestJson = `{"version":"${version}","platforms":{"windows-x86_64":${duplicateEntry},"windows-x86_64":${duplicateEntry}}}`;
    const directory = await createReleaseDirectory(validFiles(), latestJson);
    await assert.rejects(
      verifyReleaseDirectory({ directory, expectedVersion: version, publicKey: trustedPublicKey }),
      /duplicate object key/,
    );
  });
});
