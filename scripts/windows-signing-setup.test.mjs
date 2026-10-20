import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CODE_SIGNING_EKU,
  PFX_INSPECTION_SCRIPT,
  WINDOWS_SIGNING_SECRETS,
  parseArgs,
  validateCertificate,
  validateTimestampUrl,
} from "./windows-signing-setup.mjs";

const goodCertificate = {
  subject: "CN=velstech",
  thumbprint: "0123456789ABCDEF0123456789ABCDEF01234567",
  eku: CODE_SIGNING_EKU,
  hasPrivateKey: true,
  notAfter: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
};

describe("windows signing setup", () => {
  it("requires the three secrets the release pipeline reads", () => {
    assert.deepEqual(WINDOWS_SIGNING_SECRETS, [
      "WINDOWS_CERTIFICATE",
      "WINDOWS_CERTIFICATE_PASSWORD",
      "WINDOWS_TIMESTAMP_URL",
    ]);
  });

  it("parses its own arguments", () => {
    const args = parseArgs([
      "--pfx",
      "C:\\certs\\vtnexa.pfx",
      "--timestamp-url",
      "https://timestamp.example.test",
      "--dry-run",
    ]);
    assert.equal(args.pfx, "C:\\certs\\vtnexa.pfx");
    assert.equal(args.timestampUrl, "https://timestamp.example.test");
    assert.equal(args.dryRun, true);
    assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  });

  it("accepts a timestamp URL the release preflight would accept", () => {
    assert.equal(
      validateTimestampUrl("  https://timestamp.digicert.com  "),
      "https://timestamp.digicert.com",
    );
    assert.throws(() => validateTimestampUrl(""), /timestamp URL is required/);
    assert.throws(() => validateTimestampUrl("not a url"), /valid URL/);
    assert.throws(() => validateTimestampUrl("ftp://timestamp.example.test"), /http\(s\)/);
    assert.throws(() => validateTimestampUrl("https://user:pw@timestamp.example.test"), /http\(s\)/);
  });

  it("accepts a valid code-signing certificate", () => {
    assert.deepEqual(validateCertificate(goodCertificate), goodCertificate);
  });

  it("refuses a certificate that cannot sign the release", () => {
    assert.throws(
      () => validateCertificate({ ...goodCertificate, hasPrivateKey: false }),
      /no private key/,
    );
    assert.throws(
      () => validateCertificate({ ...goodCertificate, eku: "1.3.6.1.4.1.311.10.3.3" }),
      /not a code-signing certificate/,
    );
    assert.throws(
      () => validateCertificate({ ...goodCertificate, thumbprint: "nope" }),
      /40-character hex/,
    );
    assert.throws(
      () =>
        validateCertificate({
          ...goodCertificate,
          notAfter: new Date(Date.now() - 1000).toISOString(),
        }),
      /expired/,
    );
  });

  it("reads the code-signing EKU from the extension, not EnhancedKeyUsageList", () => {
    // On PowerShell 7 `EnhancedKeyUsageList` yields
    // EnhancedKeyUsageRepresentation objects whose Value and Oid are empty
    // and whose ObjectId does not exist, so reading the EKU from that
    // property silently yields nothing and a valid PFX is rejected.
    assert.ok(PFX_INSPECTION_SCRIPT.includes("2.5.29.37"));
    assert.ok(PFX_INSPECTION_SCRIPT.includes("EnhancedKeyUsages"));
    assert.ok(
      !PFX_INSPECTION_SCRIPT.includes("EnhancedKeyUsageList"),
      "must not read the EKU from EnhancedKeyUsageList",
    );
    assert.ok(
      !PFX_INSPECTION_SCRIPT.includes("ObjectId.Value"),
      "must not read the EKU through ObjectId.Value",
    );
    // A `#` comment inside the `;`-joined command string comments out the
    // rest of the script.
    assert.ok(
      !PFX_INSPECTION_SCRIPT.includes("#"),
      "the joined command string must not contain comments",
    );
  });

  it("uses the same EKU expression as the release workflow", () => {
    // The workflow selects the code-signing certificate with the same
    // expression; if one changes, the other has to change with it.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    return readFile(join(root, ".github", "workflows", "ci.yml"), "utf8").then((workflow) => {
      // Only the executable lines matter; the comment that explains the old
      // expression still mentions it.
      const code = workflow
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      assert.ok(
        code.includes('2.5.29.37') && code.includes("1.3.6.1.5.5.7.3.3"),
        "the workflow must select the certificate by its code-signing EKU",
      );
      assert.ok(
        !code.includes("ObjectId.Value"),
        "the workflow must not read the EKU through ObjectId.Value",
      );
      assert.ok(
        !code.includes("EnhancedKeyUsageList"),
        "the workflow must not read the EKU from EnhancedKeyUsageList",
      );
    });
  });
});
