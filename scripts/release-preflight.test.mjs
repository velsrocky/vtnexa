import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_RELEASE_SECRETS,
  missingReleaseSecrets,
  parseReleaseVersions,
  validateReleaseSecrets,
  validateReleaseVersion,
} from "./release-preflight.mjs";

const validVersions = {
  packageJson: JSON.stringify({ version: "1.2.3" }),
  cargoToml: '[package]\nname = "vtnexa"\nversion = "1.2.3"\n\n[dependencies]\nversion = "9.9.9"\n',
  tauriConfig: JSON.stringify({ version: "1.2.3" }),
};

const validSecrets = {
  TAURI_SIGNING_PRIVATE_KEY: "private key material",
  WINDOWS_CERTIFICATE: "YnVja2V0IHBmaXg=",
  WINDOWS_CERTIFICATE_PASSWORD: "pfx password",
  WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example Corp (ABCDE12345)",
  APPLE_ID: "dev@example.test",
  APPLE_PASSWORD: "app-specific-password",
  APPLE_TEAM_ID: "ABCDE12345",
};

describe("release preflight", () => {
  it("requires the exact tag and matching manifest versions", () => {
    const versions = parseReleaseVersions(validVersions);
    assert.deepEqual(validateReleaseVersion("v1.2.3", versions), { tag: "v1.2.3", version: "1.2.3" });
    assert.throws(() => validateReleaseVersion("v1.2.4", versions), /exactly match v1\.2\.3/);
    assert.throws(
      () => validateReleaseVersion("v1.2.3", { ...versions, cargoVersion: "1.2.4" }),
      /manifests disagree/,
    );
  });

  it("reports only missing secret names", () => {
    const env = { ...validSecrets };
    delete env.WINDOWS_CERTIFICATE;
    delete env.WINDOWS_TIMESTAMP_URL;
    assert.deepEqual(missingReleaseSecrets(env), ["WINDOWS_CERTIFICATE", "WINDOWS_TIMESTAMP_URL"]);
    assert.throws(() => validateReleaseSecrets(env), (error) => {
      assert.equal(error.message, "missing release secrets: WINDOWS_CERTIFICATE, WINDOWS_TIMESTAMP_URL");
      assert.doesNotMatch(error.message, /pfx password|timestamp\.example/);
      return true;
    });
  });

  it("rejects malformed secret values without printing them", () => {
    assert.throws(
      () => validateReleaseSecrets({ ...validSecrets, WINDOWS_CERTIFICATE: "not base64!" }),
      (error) => {
        assert.equal(error.message, "invalid release secret: WINDOWS_CERTIFICATE");
        assert.doesNotMatch(error.message, /not base64/);
        return true;
      },
    );
    assert.throws(
      () => validateReleaseSecrets({ ...validSecrets, WINDOWS_TIMESTAMP_URL: "file:///tmp/timestamp" }),
      /WINDOWS_TIMESTAMP_URL/,
    );
  });

  it("keeps the required public release contract explicit", () => {
    assert.deepEqual(REQUIRED_RELEASE_SECRETS, [
      "TAURI_SIGNING_PRIVATE_KEY",
      "WINDOWS_CERTIFICATE",
      "WINDOWS_CERTIFICATE_PASSWORD",
      "WINDOWS_TIMESTAMP_URL",
    ]);
    assert.deepEqual(validateReleaseSecrets(validSecrets).required, REQUIRED_RELEASE_SECRETS);
  });

  it("requires macOS Developer ID signing", () => {
    const env = { ...validSecrets };
    delete env.APPLE_SIGNING_IDENTITY;
    assert.throws(() => validateReleaseSecrets(env), (error) => {
      assert.match(error.message, /APPLE_SIGNING_IDENTITY/);
      assert.doesNotMatch(error.message, /Example Corp/);
      return true;
    });
  });

  it("requires macOS notarization credentials", () => {
    const env = { ...validSecrets };
    delete env.APPLE_ID;
    delete env.APPLE_PASSWORD;
    delete env.APPLE_TEAM_ID;
    assert.throws(() => validateReleaseSecrets(env), (error) => {
      assert.match(error.message, /APPLE_ID/);
      assert.match(error.message, /APPLE_PASSWORD/);
      assert.match(error.message, /APPLE_TEAM_ID/);
      assert.doesNotMatch(error.message, /dev@example\.test/);
      return true;
    });
  });

  it("accepts the certificate + api-key alternatives", () => {
    const env = { ...validSecrets };
    delete env.APPLE_SIGNING_IDENTITY;
    delete env.APPLE_ID;
    delete env.APPLE_PASSWORD;
    delete env.APPLE_TEAM_ID;
    env.APPLE_CERTIFICATE = "YnVja2V0IHBmaXg=";
    env.APPLE_CERTIFICATE_PASSWORD = "pfx password";
    env.APPLE_API_KEY = "/tmp/AuthKey.p8";
    env.APPLE_API_KEY_ID = "KEYID";
    env.APPLE_API_ISSUER = "00000000-0000-0000-0000-000000000000";
    const result = validateReleaseSecrets(env);
    assert.deepEqual(result.apple.signing, ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"]);
    assert.deepEqual(result.apple.notarization, [
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ]);
  });

  it("rejects a malformed Apple team id", () => {
    assert.throws(
      () => validateReleaseSecrets({ ...validSecrets, APPLE_TEAM_ID: "not-a-team" }),
      (error) => {
        assert.equal(error.message, "invalid release secret: APPLE_TEAM_ID");
        assert.doesNotMatch(error.message, /not-a-team/);
        return true;
      },
    );
  });

  it("rejects a malformed Apple certificate", () => {
    const env = { ...validSecrets };
    delete env.APPLE_SIGNING_IDENTITY;
    env.APPLE_CERTIFICATE = "not base64!";
    env.APPLE_CERTIFICATE_PASSWORD = "pfx password";
    assert.throws(
      () => validateReleaseSecrets(env),
      (error) => {
        assert.equal(error.message, "invalid release secret: APPLE_CERTIFICATE");
        assert.doesNotMatch(error.message, /not base64/);
        return true;
      },
    );
  });
});
