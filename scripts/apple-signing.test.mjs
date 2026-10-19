import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPLE_NOTARIZATION_GROUPS,
  APPLE_SIGNING_ENV_NAMES,
  APPLE_SIGNING_GROUPS,
  evaluateAppleCredentials,
  isDeveloperIdSigned,
  macosReleaseAssets,
  parseCodesignAuthorities,
  parseGatekeeperAssessment,
  parseStapleValidation,
  requiredAppleSecrets,
  validateAppleReleaseSecrets,
  verifyMacosArtifact,
  verifyMacosReleaseDirectory,
} from "./apple-signing.mjs";

const validEnv = {
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example Corp (ABCDE12345)",
  APPLE_ID: "dev@example.test",
  APPLE_PASSWORD: "app-specific-password",
  APPLE_TEAM_ID: "ABCDE12345",
};

function toolsThatFail(stage) {
  const ok = { code: 0, stdout: "", stderr: "" };
  return {
    codesignVerify: async () => (stage === "codesign" ? { code: 1, stdout: "", stderr: "bad" } : ok),
    codesignDisplay: async () =>
      stage === "identity"
        ? { code: 0, stdout: "Authority=Apple Development: x (ABCDE12345)\nTeamIdentifier=ABCDE12345\n", stderr: "" }
        : {
            code: 0,
            stdout:
              "Authority=Developer ID Application: Example Corp (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
            stderr: "",
          },
    spctlAssess: async () =>
      stage === "gatekeeper"
        ? { code: 1, stdout: "", stderr: "rejected" }
        : { code: 0, stdout: "source=Notarized Developer ID\n", stderr: "" },
    stapleValidate: async () =>
      stage === "staple"
        ? { code: 1, stdout: "", stderr: "no ticket" }
        : { code: 0, stdout: "The validate action worked!", stderr: "" },
  };
}

describe("apple signing credentials", () => {
  it("accepts a complete identity + apple-id credential set", () => {
    const state = evaluateAppleCredentials(validEnv);
    assert.equal(state.signing.satisfied, true);
    assert.equal(state.notarization.satisfied, true);
    assert.deepEqual(state.signing.selected, ["APPLE_SIGNING_IDENTITY"]);
    assert.deepEqual(state.notarization.selected, ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]);
  });

  it("accepts the certificate + api-key alternatives", () => {
    const state = evaluateAppleCredentials({
      APPLE_CERTIFICATE: "YnVja2V0IHBmaXg=",
      APPLE_CERTIFICATE_PASSWORD: "pfx password",
      APPLE_API_KEY: "/tmp/AuthKey.p8",
      APPLE_API_KEY_ID: "KEYID",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(state.signing.satisfied, true);
    assert.equal(state.notarization.satisfied, true);
    assert.deepEqual(state.signing.selected, ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"]);
    assert.deepEqual(state.notarization.selected, ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]);
  });

  it("fails closed when signing material is missing", () => {
    const env = { ...validEnv };
    delete env.APPLE_SIGNING_IDENTITY;
    assert.throws(() => validateAppleReleaseSecrets(env), (error) => {
      assert.match(error.message, /APPLE_SIGNING_IDENTITY|APPLE_CERTIFICATE/);
      return true;
    });
  });

  it("fails closed when notarization material is missing", () => {
    const env = { ...validEnv };
    delete env.APPLE_ID;
    delete env.APPLE_PASSWORD;
    assert.throws(() => validateAppleReleaseSecrets(env), (error) => {
      assert.match(error.message, /APPLE_ID/);
      assert.match(error.message, /APPLE_PASSWORD/);
      return true;
    });
  });

  it("rejects a partially configured group", () => {
    const env = { ...validEnv, APPLE_PASSWORD: "" };
    assert.throws(() => validateAppleReleaseSecrets(env), /APPLE_PASSWORD/);
  });

  it("never prints secret values", () => {
    const env = { ...validEnv };
    delete env.APPLE_PASSWORD;
    assert.throws(() => validateAppleReleaseSecrets(env), (error) => {
      assert.doesNotMatch(error.message, /app-specific-password/);
      assert.doesNotMatch(error.message, /dev@example\.test/);
      return true;
    });
  });

  it("reports the names a release needs", () => {
    assert.deepEqual(requiredAppleSecrets(validEnv), [
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
    ]);
  });

  it("keeps the credential groups explicit", () => {
    assert.deepEqual(APPLE_SIGNING_GROUPS, [
      ["APPLE_SIGNING_IDENTITY"],
      ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"],
    ]);
    assert.deepEqual(APPLE_NOTARIZATION_GROUPS, [
      ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"],
      ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    ]);
    for (const name of APPLE_SIGNING_ENV_NAMES) {
      assert.ok(
        APPLE_SIGNING_GROUPS.flat().includes(name) || APPLE_NOTARIZATION_GROUPS.flat().includes(name),
        `${name} is not part of any group`,
      );
    }
  });
});

describe("apple artifact verification", () => {
  it("parses authorities and the team identifier", () => {
    const parsed = parseCodesignAuthorities(
      "Executable=/Applications/VTNexa.app\nAuthority=Developer ID Application: Example Corp (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
    );
    assert.deepEqual(parsed.authorities, ["Developer ID Application: Example Corp (ABCDE12345)"]);
    assert.equal(parsed.teamIdentifier, "ABCDE12345");
    assert.equal(isDeveloperIdSigned(parsed), true);
  });

  it("does not accept an ad-hoc or Apple Development signature", () => {
    assert.equal(isDeveloperIdSigned(parseCodesignAuthorities("Signature=adhoc\n")), false);
    assert.equal(
      isDeveloperIdSigned(parseCodesignAuthorities("Authority=Apple Development: x (ABCDE12345)\n")),
      false,
    );
  });

  it("parses the Gatekeeper assessment", () => {
    const accepted = parseGatekeeperAssessment("VTNexa.app: accepted\nsource=Notarized Developer ID\n");
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.notarized, true);
    const rejected = parseGatekeeperAssessment("VTNexa.app: rejected\nsource=Unnotarized Developer ID\n");
    assert.equal(rejected.accepted, false);
  });

  it("parses the stapler verdict", () => {
    assert.equal(parseStapleValidation("The validate action worked!", 0).stapled, true);
    assert.equal(parseStapleValidation("", 1).stapled, false);
    assert.equal(parseStapleValidation("The validate action worked!", 1).stapled, false);
  });

  it("selects only the macOS release assets", () => {
    assert.deepEqual(
      macosReleaseAssets([
        "VTNexa_1.0.5_aarch64.app.tar.gz",
        "VTNexa_1.0.5_aarch64.app.tar.gz.sig",
        "VTNexa_1.0.5_aarch64.dmg",
        "VTNexa_1.0.5_x64-setup.exe",
        "VTNexa_1.0.5_amd64.deb",
        "latest.json",
      ]),
      ["VTNexa_1.0.5_aarch64.app.tar.gz", "VTNexa_1.0.5_aarch64.dmg"],
    );
  });

  it("also accepts an extracted app bundle", () => {
    assert.deepEqual(macosReleaseAssets(["VTNexa.app", "latest.json"]), ["VTNexa.app"]);
  });

  it("accepts a properly signed, notarized, stapled artifact", async () => {
    const result = await verifyMacosArtifact("/tmp/VTNexa.app", {
      expectedTeam: "ABCDE12345",
      tools: toolsThatFail("none"),
    });
    assert.equal(result.teamIdentifier, "ABCDE12345");
    assert.equal(result.notarized, true);
  });

  it("rejects a broken signature", async () => {
    await assert.rejects(
      () => verifyMacosArtifact("/tmp/VTNexa.app", { tools: toolsThatFail("codesign") }),
      /not correctly signed/,
    );
  });

  it("rejects a signature that is not a Developer ID Application", async () => {
    await assert.rejects(
      () => verifyMacosArtifact("/tmp/VTNexa.app", { tools: toolsThatFail("identity") }),
      /not signed with a Developer ID Application certificate/,
    );
  });

  it("rejects an artifact Gatekeeper refuses", async () => {
    await assert.rejects(
      () => verifyMacosArtifact("/tmp/VTNexa.app", { tools: toolsThatFail("gatekeeper") }),
      /not accepted by Gatekeeper/,
    );
  });

  it("rejects an artifact without a stapled ticket", async () => {
    await assert.rejects(
      () => verifyMacosArtifact("/tmp/VTNexa.app", { tools: toolsThatFail("staple") }),
      /no stapled notarization ticket/,
    );
  });

  it("fails closed when the release has no macOS artifact", async () => {
    await assert.rejects(
      () => verifyMacosReleaseDirectory({ directory: "/tmp", names: ["latest.json"] }),
      /no macOS artifact/,
    );
  });
});
