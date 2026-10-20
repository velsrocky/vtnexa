import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_SIGNING_EKU,
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
});
