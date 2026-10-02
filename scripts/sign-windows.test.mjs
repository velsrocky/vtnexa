import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSignToolArgs,
  signWindowsFile,
  validateSigningEnvironment,
} from "./sign-windows.mjs";

const temporaryDirectories = [];
const thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567";

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

async function temporaryFile() {
  const directory = await mkdtemp(join(tmpdir(), "vtnexa-sign-test-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "app.exe");
  await writeFile(file, "binary");
  return file;
}

describe("Windows signing command", () => {
  it("constructs SHA-256 file and timestamp arguments", () => {
    assert.deepEqual(
      buildSignToolArgs({
        file: "C:\\build\\VTNexa.exe",
        thumbprint,
        timestampUrl: "https://timestamp.example.test",
      }),
      [
        "sign",
        "/sha1",
        thumbprint,
        "/fd",
        "sha256",
        "/tr",
        "https://timestamp.example.test",
        "/td",
        "sha256",
        "C:\\build\\VTNexa.exe",
      ],
    );
  });

  it("skips only when no signing material is configured", () => {
    assert.deepEqual(validateSigningEnvironment({}, "win32"), { mode: "skip", missing: [] });
    assert.deepEqual(validateSigningEnvironment({ SIGNTOOL_PATH: "C:\\signtool.exe" }, "win32"), { mode: "skip", missing: [] });
  });

  it("activates signing when CI material is present", () => {
    assert.deepEqual(
      validateSigningEnvironment(
        {
          WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint,
          WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test",
        },
        "win32",
      ),
      {
        mode: "sign",
        thumbprint,
        timestampUrl: "https://timestamp.example.test",
        missing: [],
      },
    );
  });

  it("fails closed for partial material without exposing values", () => {
    assert.throws(
      () => validateSigningEnvironment({ WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint, WINDOWS_TIMESTAMP_URL: "" }, "win32"),
      (error) => {
        assert.match(error.message, /WINDOWS_TIMESTAMP_URL/);
        assert.doesNotMatch(error.message, new RegExp(thumbprint));
        return true;
      },
    );
  });

  it("passes the derived thumbprint and timestamp to signtool", async () => {
    const file = await temporaryFile();
    let invocation;
    const result = await signWindowsFile(file, {
      platform: "win32",
      env: {
        WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint,
        WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test",
      },
      signtoolPath: "C:\\signtool.exe",
      runSigntool: async (tool, args) => {
        invocation = { tool, args };
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(invocation.tool, "C:\\signtool.exe");
    assert.deepEqual(invocation.args, buildSignToolArgs({
      file,
      thumbprint,
      timestampUrl: "https://timestamp.example.test",
    }));
  });
});
