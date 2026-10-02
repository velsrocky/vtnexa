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
});
