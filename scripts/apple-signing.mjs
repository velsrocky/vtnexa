// Apple Developer ID signing + notarization contract.
//
// Two things are enforced here:
//
// 1. The RELEASE CREDENTIAL CONTRACT. A public release must carry a Developer
//    ID signature and a notarization ticket. Apple signing material comes in
//    two interchangeable shapes and notarization material in two more, so the
//    contract is expressed as "at least one group per category must be
//    completely configured" rather than a flat list of names.
//
// 2. The ARTIFACT VERIFICATION. A signed-but-un-notarized app is still
//    blocked by Gatekeeper, so the verification checks the signature, the
//    team, the Gatekeeper assessment AND the stapled ticket. The decision
//    logic is pure and unit-tested; the `codesign`/`spctl`/`stapler` calls
//    are the only part that touches the machine.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const APPLE_SIGNING_ENV_NAMES = Object.freeze([
  "APPLE_SIGNING_IDENTITY",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
]);

/** Ways to present a Developer ID Application identity to Tauri. */
export const APPLE_SIGNING_GROUPS = Object.freeze([
  Object.freeze(["APPLE_SIGNING_IDENTITY"]),
  Object.freeze(["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"]),
]);

/** Ways to present notarization credentials to Tauri. */
export const APPLE_NOTARIZATION_GROUPS = Object.freeze([
  Object.freeze(["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]),
  Object.freeze(["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]),
]);

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function evaluateGroups(groups, env) {
  const evaluated = groups.map((names) => {
    const presentNames = names.filter((name) => present(env[name]));
    const missingNames = names.filter((name) => !present(env[name]));
    return { names: [...names], present: presentNames, missing: missingNames, complete: missingNames.length === 0 };
  });
  const complete = evaluated.find((group) => group.complete);
  return {
    groups: evaluated,
    satisfied: Boolean(complete),
    selected: complete ? complete.names : [],
    // When nothing is configured, report every name that could satisfy the
    // category so the failure message is actionable.
    missing: complete ? [] : evaluated.flatMap((group) => group.missing),
  };
}

/**
 * Evaluate the Apple release credentials.
 *
 * `signing` and `notarization` are independent: either can be satisfied by
 * any of its groups. A release requires BOTH.
 */
export function evaluateAppleCredentials(env = {}) {
  return {
    signing: evaluateGroups(APPLE_SIGNING_GROUPS, env),
    notarization: evaluateGroups(APPLE_NOTARIZATION_GROUPS, env),
  };
}

/**
 * The secret names a release must have configured, given the environment.
 * Returns the names of the selected (complete) groups, or - when a category
 * is not satisfied - every name that could complete it.
 */
export function requiredAppleSecrets(env = {}) {
  const state = evaluateAppleCredentials(env);
  const required = [];
  if (state.signing.satisfied) {
    required.push(...state.signing.selected);
  } else {
    required.push(...state.signing.missing);
  }
  if (state.notarization.satisfied) {
    required.push(...state.notarization.selected);
  } else {
    required.push(...state.notarization.missing);
  }
  return [...new Set(required)];
}

/**
 * Validate the FORMAT of the selected Apple secret values. Only the
 * configured (selected) values are checked, and only their NAMES ever
 * appear in an error - never the value itself.
 */
export function validateAppleSecretValues(env = {}) {
  const state = evaluateAppleCredentials(env);
  for (const name of state.signing.selected) {
    if (name === "APPLE_CERTIFICATE") {
      const compact = String(env[name]).replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length < 8) {
        throw new Error(`invalid release secret: ${name}`);
      }
      let decoded;
      try {
        decoded = Buffer.from(compact, "base64");
      } catch {
        throw new Error(`invalid release secret: ${name}`);
      }
      if (decoded.length === 0) throw new Error(`invalid release secret: ${name}`);
    }
    if (name === "APPLE_SIGNING_IDENTITY" && String(env[name]).trim().length < 3) {
      throw new Error(`invalid release secret: ${name}`);
    }
  }
  for (const name of state.notarization.selected) {
    if (name === "APPLE_TEAM_ID" && !/^[A-Z0-9]{10}$/.test(String(env[name]).trim())) {
      throw new Error(`invalid release secret: ${name}`);
    }
    if (name === "APPLE_API_ISSUER" && !/^[0-9a-fA-F-]{36}$/.test(String(env[name]).trim())) {
      throw new Error(`invalid release secret: ${name}`);
    }
  }
  return true;
}

/**
 * Validate the Apple release credentials. Throws with the MISSING NAMES ONLY
 * - never with secret values.
 */
export function validateAppleReleaseSecrets(env = {}) {
  const state = evaluateAppleCredentials(env);
  const missing = [];
  if (!state.signing.satisfied) missing.push(...state.signing.missing);
  if (!state.notarization.satisfied) missing.push(...state.notarization.missing);
  if (missing.length > 0) {
    throw new Error(`missing release secrets: ${[...new Set(missing)].join(", ")}`);
  }
  validateAppleSecretValues(env);
  return {
    signing: state.signing.selected,
    notarization: state.notarization.selected,
  };
}

// ---------------------------------------------------------------------------
// Artifact verification
// ---------------------------------------------------------------------------

export class AppleVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AppleVerificationError";
  }
}

function fail(message) {
  throw new AppleVerificationError(message);
}

/**
 * Parse `codesign -dv --verbose=4` output.
 *
 * Example:
 *   Authority=Developer ID Application: Example Corp (ABCDE12345)
 *   TeamIdentifier=ABCDE12345
 */
export function parseCodesignAuthorities(output) {
  const authorities = [];
  let teamIdentifier = "";
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const authority = line.match(/^Authority=(.*)$/);
    if (authority) {
      authorities.push(authority[1].trim());
      continue;
    }
    const team = line.match(/^TeamIdentifier=(.*)$/);
    if (team) teamIdentifier = team[1].trim();
  }
  return { authorities, teamIdentifier };
}

/**
 * Does the codesign output show a Developer ID Application signature?
 * An ad-hoc signature ("Signature=adhoc", no Authority) does NOT count.
 */
export function isDeveloperIdSigned({ authorities }) {
  return authorities.some((authority) => authority.startsWith("Developer ID Application:"));
}

/**
 * Parse `spctl --assess --type execute --verbose=4` output.
 *
 * A notarized, Developer ID signed app is reported as:
 *   ... is accepted
 *   source=Notarized Developer ID
 */
export function parseGatekeeperAssessment(output) {
  const text = String(output || "");
  const accepted = /is accepted|accepted$|source=/m.test(text);
  const notarized = /source=Notarized Developer ID|source=Developer ID/.test(text);
  const rejected = /is rejected|rejected$|source=No usable signature|source=Unnotarized/.test(text);
  return { accepted: accepted && !rejected, notarized, rejected };
}

/**
 * Decide whether a stapled notarization ticket is present.
 * `xcrun stapler validate` prints "The validate action worked!" on success.
 */
export function parseStapleValidation(output, exitCode) {
  const text = String(output || "");
  const worked = /validate action worked|valid and signed/i.test(text);
  return { stapled: exitCode === 0 && worked };
}

/**
 * Run a command and capture its output. Never throws on a non-zero exit -
 * the caller decides what a failure means.
 */
export function runTool(tool, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(tool, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 64000) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64000) stderr += chunk.toString();
    });
    child.once("error", (error) => resolveResult({ code: 127, stdout, stderr: String(error) }));
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * The macOS release assets we verify: the `.app` bundle archives (the
 * updater artifacts) and the `.dmg` installers. An extracted `.app`
 * directory counts too - that is what a user actually runs.
 */
export function macosReleaseAssets(names) {
  const assets = [];
  for (const name of names) {
    if (/\.app\.tar\.gz$/i.test(name) || /\.dmg$/i.test(name) || /\.app$/i.test(name)) {
      assets.push(name);
    }
  }
  return assets;
}

/**
 * Verify one macOS release artifact.
 *
 * `tools` is injectable so the decision logic can be unit-tested without a
 * signed build: { codesignVerify, codesignDisplay, spctlAssess, stapleValidate }
 */
export async function verifyMacosArtifact(artifact, { expectedTeam = "", tools } = {}) {
  const {
    codesignVerify = (path) => runTool("codesign", ["--verify", "--deep", "--strict", "--verbose=2", path]),
    codesignDisplay = (path) => runTool("codesign", ["-dv", "--verbose=4", path]),
    spctlAssess = (path) => runTool("spctl", ["--assess", "--type", "execute", "--verbose=4", path]),
    stapleValidate = (path) => runTool("xcrun", ["stapler", "validate", path]),
  } = tools || {};

  const verify = await codesignVerify(artifact);
  if (verify.code !== 0) {
    fail(`macOS artifact is not correctly signed: ${artifact}`);
  }

  const display = await codesignDisplay(artifact);
  const identity = parseCodesignAuthorities(display.stdout || display.stderr);
  if (!isDeveloperIdSigned(identity)) {
    fail(`macOS artifact is not signed with a Developer ID Application certificate: ${artifact}`);
  }
  if (expectedTeam && identity.teamIdentifier && identity.teamIdentifier !== expectedTeam) {
    fail(
      `macOS artifact is signed by team ${identity.teamIdentifier}, expected ${expectedTeam}: ${artifact}`,
    );
  }

  const assessment = await spctlAssess(artifact);
  const gatekeeper = parseGatekeeperAssessment(assessment.stdout || assessment.stderr);
  if (!gatekeeper.accepted) {
    fail(`macOS artifact is not accepted by Gatekeeper: ${artifact}`);
  }
  if (!gatekeeper.notarized) {
    fail(`macOS artifact is not notarized: ${artifact}`);
  }

  const staple = await stapleValidate(artifact);
  const ticket = parseStapleValidation(staple.stdout || staple.stderr, staple.code);
  if (!ticket.stapled) {
    fail(`macOS artifact has no stapled notarization ticket: ${artifact}`);
  }

  return {
    artifact,
    teamIdentifier: identity.teamIdentifier,
    authorities: identity.authorities,
    notarized: true,
  };
}

/**
 * Verify every macOS artifact in a release directory. Fails closed: a
 * release with no macOS artifact at all is an error, not a pass.
 */
export async function verifyMacosReleaseDirectory({
  directory,
  expectedTeam = "",
  names,
  tools,
} = {}) {
  let assets = names;
  if (!assets) {
    const entries = await readdir(directory, { withFileTypes: true });
    assets = entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry) => entry.name);
  }
  const macosAssets = macosReleaseAssets(assets);
  if (macosAssets.length === 0) {
    fail("release has no macOS artifact to verify");
  }
  const verified = [];
  for (const asset of macosAssets) {
    verified.push(
      await verifyMacosArtifact(join(directory, asset), { expectedTeam, tools }),
    );
  }
  return { assets: verified };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--directory" || argv[index] === "--dir") result.directory = argv[++index];
    else if (argv[index] === "--bundle") result.bundle = argv[++index];
    else if (argv[index] === "--team") result.team = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const expectedTeam = args.team || process.env.APPLE_TEAM_ID || "";
    if (args.bundle) {
      const asset = await verifyMacosArtifact(args.bundle, { expectedTeam });
      console.log(
        `apple verification passed for ${asset.artifact} (team ${asset.teamIdentifier || "unknown"})`,
      );
    } else if (args.directory) {
      const result = await verifyMacosReleaseDirectory({
        directory: args.directory,
        expectedTeam,
      });
      for (const asset of result.assets) {
        console.log(
          `apple verification passed for ${asset.artifact} (team ${asset.teamIdentifier || "unknown"})`,
        );
      }
    } else {
      throw new Error(
        "usage: node scripts/apple-signing.mjs (--bundle <path> | --directory <dir>) [--team <TEAMID>]",
      );
    }
  } catch (error) {
    console.error(`apple verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
