// Export the macOS Developer ID material to the exact GitHub secret format.
//
// The Apple Developer flow is easy to get wrong by hand: the .p12 has to be
// exported from the LOGIN keychain, base64-encoded WITHOUT line wrapping,
// and the notarization credentials are a separate account. This script does
// the mechanical part and prints the commands to run.
//
// It never prints the certificate or the password - the base64 goes to a
// file, and the file's contents are what you paste into GitHub.
//
// Usage:
//   node scripts/apple-local-export.mjs --list
//   node scripts/apple-local-export.mjs --export <dir> [--identity "<name>"]

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Parse `security find-identity -v -p codesigning` output.
 *
 * Example line:
 *   1) 8B4C... "Developer ID Application: Example Corp (ABCDE12345)"
 */
export function parseSigningIdentities(output) {
  const identities = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^\d+\)\s+([0-9A-F]+)\s+"(.+)"$/);
    if (!match) continue;
    const [, hash, name] = match;
    if (!name.startsWith("Developer ID Application:")) continue;
    identities.push({ hash, name, teamId: teamIdFromIdentity(name) });
  }
  return identities;
}

/**
 * The Team ID is the trailing parenthesised group of the identity name:
 *   "Developer ID Application: Example Corp (ABCDE12345)" -> ABCDE12345
 */
export function teamIdFromIdentity(name) {
  const match = String(name || "").match(/\(([A-Z0-9]{10})\)\s*$/);
  return match ? match[1] : "";
}

/**
 * The exact `gh secret set` commands for the material this script exports.
 * Values are never embedded - each is piped from a file or a prompt.
 */
export function buildSecretCommands({ certificateBase64Path, teamId }) {
  const commands = [
    `gh secret set APPLE_CERTIFICATE < ${certificateBase64Path}`,
    `gh secret set APPLE_CERTIFICATE_PASSWORD   # the password you used for the .p12 export`,
  ];
  if (teamId) commands.push(`gh secret set APPLE_TEAM_ID --body ${teamId}`);
  return commands;
}

export function runTool(tool, args, { input } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(tool, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => resolveResult({ code: 127, stdout, stderr: String(error) }));
    child.once("close", (code) => {
      if (input !== undefined) {
        child.stdin.write(input);
      }
      child.stdin.end();
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** List the Developer ID Application identities in the login keychain. */
export async function listIdentities() {
  const result = await runTool("security", ["find-identity", "-v", "-p", "codesigning"]);
  return parseSigningIdentities(result.stdout);
}

/**
 * Export a Developer ID identity to a PKCS#12 file.
 *
 * `security export` needs the item name as its final argument, and the
 * identity name contains spaces and parentheses - so it is passed as a
 * separate argv entry (no shell involved).
 */
export async function exportIdentity(identity, { outputPath, password }) {
  const result = await runTool(
    "security",
    [
      "export",
      "-k",
      process.env.HOME ? join(process.env.HOME, "Library/Keychains/login.keychain-db") : "login.keychain-db",
      "-t",
      "identities",
      "-f",
      "pkcs12",
      "-P",
      password,
      "-o",
      outputPath,
      identity.name,
    ],
    { input: `${password}\n` },
  );
  if (result.code !== 0) {
    throw new Error(`security export failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return outputPath;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--list") result.list = true;
    else if (argv[index] === "--export") result.exportDir = argv[++index];
    else if (argv[index] === "--identity") result.identity = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const identities = await listIdentities();

    if (identities.length === 0) {
      console.error(
        "No Developer ID Application identity found in the login keychain.\n" +
          "You need a PAID Apple Developer Program membership and a\n" +
          "'Developer ID Application' certificate - see docs/APPLE-SIGNING.md.",
      );
      process.exitCode = 1;
    } else {
      console.log("Developer ID Application identities in the login keychain:");
      for (const identity of identities) {
        console.log(`  ${identity.hash}  ${identity.name}  [team ${identity.teamId}]`);
      }
    }

    if (args.exportDir) {
      if (identities.length === 0) throw new Error("no Developer ID Application identity to export");
      const chosen = args.identity
        ? identities.find((identity) => identity.name === args.identity)
        : identities[0];
      if (!chosen) throw new Error(`identity not found: ${args.identity}`);
      if (identities.length > 1 && !args.identity) {
        throw new Error(
          "more than one identity found - pass --identity \"<exact name>\" to choose one",
        );
      }
      const password = process.env.APPLE_CERTIFICATE_PASSWORD;
      if (!password) {
        throw new Error(
          "set APPLE_CERTIFICATE_PASSWORD to the password you want for the .p12 export",
        );
      }
      await mkdir(args.exportDir, { recursive: true });
      const p12Path = join(args.exportDir, "certificate.p12");
      const b64Path = join(args.exportDir, "certificate-base64.txt");
      await exportIdentity(chosen, { outputPath: p12Path, password });
      // `openssl base64 -A` matches Tauri's documented format: one line, no
      // wrapping. A wrapped base64 blob fails Tauri's decoder.
      const encoded = await runTool("openssl", [
        "base64",
        "-A",
        "-in",
        p12Path,
        "-out",
        b64Path,
      ]);
      if (encoded.code !== 0) {
        throw new Error(`openssl base64 failed: ${encoded.stderr.trim()}`);
      }
      console.log("");
      console.log("Exported:");
      console.log(`  identity : ${chosen.name}`);
      console.log(`  team id  : ${chosen.teamId}`);
      console.log(`  p12      : ${p12Path}  (keep this out of your repo)`);
      console.log(`  base64   : ${b64Path}`);
      console.log("");
      console.log("Now set the GitHub secrets:");
      for (const command of buildSecretCommands({
        certificateBase64Path: b64Path,
        teamId: chosen.teamId,
      })) {
        console.log(`  ${command}`);
      }
      console.log("");
      console.log("For notarization, pick ONE (see docs/APPLE-SIGNING.md):");
      console.log("  Apple ID route:      APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID");
      console.log("  App Store Connect:   APPLE_API_KEY (Key ID), APPLE_API_ISSUER, APPLE_API_KEY_CONTENT (.p8)");
    }
  } catch (error) {
    console.error(`apple export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
