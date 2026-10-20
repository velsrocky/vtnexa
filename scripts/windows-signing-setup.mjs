import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";import { pathToFileURL } from "node:url";

// Extended Key Usage OID for Code Signing (1.3.6.1.5.5.7.3.3).
export const CODE_SIGNING_EKU = "1.3.6.1.5.5.7.3.3";

export const WINDOWS_SIGNING_SECRETS = Object.freeze([
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_TIMESTAMP_URL",
]);

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pfx") result.pfx = argv[++index];
    else if (arg === "--timestamp-url") result.timestampUrl = argv[++index];
    else if (arg === "--repository") result.repository = argv[++index];
    else if (arg === "--dry-run") result.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

/// Validates the timestamp service URL the same way the release preflight
/// does, so a URL that passes here cannot fail the tagged pipeline later.
export function validateTimestampUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error("a timestamp URL is required");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("the timestamp URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("the timestamp URL must be http(s) without credentials");
  }
  return value;
}

/// Checks the certificate details reported by the Windows certificate store.
///
/// The pipeline imports the PFX and then requires the thumbprint it derived
/// to match every artifact, so the certificate has to be a code-signing
/// certificate that is currently valid.
export function validateCertificate(certificate) {
  const problems = [];
  if (!certificate || !certificate.hasPrivateKey) {
    problems.push("the certificate has no private key");
  }
  if (!certificate.eku || !certificate.eku.includes(CODE_SIGNING_EKU)) {
    problems.push(
      `the certificate is not a code-signing certificate (EKU ${CODE_SIGNING_EKU} required)`,
    );
  }
  if (!certificate.thumbprint || !/^[0-9A-F]{40}$/i.test(certificate.thumbprint)) {
    problems.push("the certificate thumbprint is not a 40-character hex value");
  }
  if (!certificate.notAfter) {
    problems.push("the certificate has no expiry date");
  } else if (new Date(certificate.notAfter).getTime() <= Date.now()) {
    problems.push(`the certificate expired on ${certificate.notAfter}`);
  }
  if (problems.length > 0) {
    throw new Error(`the PFX is not usable for Windows code signing: ${problems.join("; ")}`);
  }
  return certificate;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 65536) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/// Resolves a PowerShell that can actually be executed.
///
/// `powershell.exe` (Windows PowerShell 5.1) is only on `PATH` on some
/// images; on a stock Windows install it lives in
/// `%SystemRoot%\System32\WindowsPowerShell\v1.0\`, which is not on `PATH`.
async function resolvePowerShell() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (systemRoot) {
    const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not there; fall through to the PATH lookup.
    }
  }
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    try {
      await run(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
      return candidate;
    } catch {
      // Not runnable; try the next candidate.
    }
  }
  throw new Error(
    "no PowerShell found; install PowerShell 7 (`pwsh`) or make powershell.exe resolvable",
  );
}

/// Reads the certificate details out of a PFX using the Windows certificate
/// store, so the same machinery the release pipeline uses is what validates
/// the file here.
async function inspectPfx(pfxPath, password) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$secure = ConvertTo-SecureString -String $env:PFX_PASSWORD -AsPlainText -Force",
    "$certs = @(Import-PfxCertificate -FilePath $env:PFX_PATH -CertStoreLocation Cert:\\CurrentUser\\My -Password $secure | Where-Object { $_.HasPrivateKey })",
    "$cert = $certs | Where-Object { $_.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value } | Where-Object { $_ -eq '1.3.6.1.5.5.7.3.3' } } | Select-Object -First 1",
    "if ($null -eq $cert) { $cert = $certs | Select-Object -First 1 }",
    "if ($null -eq $cert) { throw 'the PFX contained no certificate with a private key' }",
    "$eku = ($cert.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value }) -join ','",
    "[pscustomobject]@{ thumbprint = $cert.Thumbprint; eku = $eku; notAfter = $cert.NotAfter.ToString('o'); hasPrivateKey = [bool]$cert.HasPrivateKey; subject = $cert.Subject } | ConvertTo-Json -Compress",
  ].join("; ");
  const powershell = await resolvePowerShell();
  const { stdout } = await run(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, PFX_PATH: pfxPath, PFX_PASSWORD: password } },
  );
  return JSON.parse(stdout.trim().split(/\r?\n/).pop());
}

async function setSecret(name, value, repository) {
  const args = ["secret", "set", name];
  if (repository) args.push("--repo", repository);
  const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`gh secret set ${name} failed with ${code}: ${stderr.trim()}`));
  });
  child.stdin.end(value);
}

export async function setupWindowsSigning({ pfx, password, timestampUrl, repository, dryRun }) {
  if (!pfx) throw new Error("a PFX file is required (--pfx <path>)");
  if (!password) {
    throw new Error(
      "the PFX password is required; set it in WINDOWS_CERTIFICATE_PASSWORD rather than on the command line",
    );
  }
  const url = validateTimestampUrl(timestampUrl);
  const certificate = validateCertificate(await inspectPfx(pfx, password));
  const base64 = (await readFile(pfx)).toString("base64");

  if (dryRun) {
    return {
      dryRun: true,
      certificate,
      secrets: [...WINDOWS_SIGNING_SECRETS],
      bytes: base64.length,
    };
  }

  await setSecret("WINDOWS_CERTIFICATE", base64, repository);
  await setSecret("WINDOWS_CERTIFICATE_PASSWORD", password, repository);
  await setSecret("WINDOWS_TIMESTAMP_URL", url, repository);

  return { dryRun: false, certificate, secrets: [...WINDOWS_SIGNING_SECRETS] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const password = process.env.WINDOWS_CERTIFICATE_PASSWORD;
    const result = await setupWindowsSigning({
      pfx: args.pfx,
      password,
      timestampUrl: args.timestampUrl,
      repository: args.repository,
      dryRun: args.dryRun,
    });
    const label = result.dryRun ? "would set" : "set";
    console.log(`windows-signing: ${label} ${result.secrets.join(", ")}`);
    console.log(
      `windows-signing: certificate ${result.certificate.subject} (thumbprint ${result.certificate.thumbprint})`,
    );
    if (result.dryRun) {
      console.log(`windows-signing: ${result.bytes} base64 characters of PFX material`);
    } else {
      console.log(
        "windows-signing: tag the release to publish; release-preflight and release-verify both refuse an unsigned Windows artifact",
      );
    }
  } catch (error) {
    console.error(`windows-signing: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
