import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSecretCommands,
  parseSigningIdentities,
  teamIdFromIdentity,
} from "./apple-local-export.mjs";

const findIdentityOutput = [
  "  1) 8B4C2E1F9A3D5C7E9F1B2A4D6E8C0A1B3D5F7A9B \"Developer ID Application: Example Corp (ABCDE12345)\"",
  "  2) 1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B \"Apple Development: dev@example.test (ABCDE12345)\"",
  "     2 valid identities found",
].join("\n");

describe("apple local export", () => {
  it("lists only the Developer ID Application identities", () => {
    const identities = parseSigningIdentities(findIdentityOutput);
    assert.equal(identities.length, 1);
    assert.equal(identities[0].name, "Developer ID Application: Example Corp (ABCDE12345)");
    assert.equal(identities[0].teamId, "ABCDE12345");
    assert.equal(identities[0].hash, "8B4C2E1F9A3D5C7E9F1B2A4D6E8C0A1B3D5F7A9B");
  });

  it("finds nothing when there is no identity", () => {
    assert.deepEqual(parseSigningIdentities("     0 valid identities found"), []);
    assert.deepEqual(parseSigningIdentities(""), []);
  });

  it("extracts the team id from the identity name", () => {
    assert.equal(teamIdFromIdentity("Developer ID Application: Example Corp (ABCDE12345)"), "ABCDE12345");
    assert.equal(teamIdFromIdentity("Developer ID Application: No Team"), "");
    assert.equal(teamIdFromIdentity(""), "");
  });

  it("never embeds the certificate or the password in the commands", () => {
    const commands = buildSecretCommands({
      certificateBase64Path: "/tmp/certificate-base64.txt",
      teamId: "ABCDE12345",
    });
    assert.deepEqual(commands, [
      "gh secret set APPLE_CERTIFICATE < /tmp/certificate-base64.txt",
      "gh secret set APPLE_CERTIFICATE_PASSWORD   # the password you used for the .p12 export",
      "gh secret set APPLE_TEAM_ID --body ABCDE12345",
    ]);
    for (const command of commands) {
      assert.doesNotMatch(command, /BEGIN|base64-content/);
    }
  });
});
