import { access } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

/// Resolves a PowerShell that can actually run `requiredCommands`.
///
/// Two traps, both hit in the wild:
///
/// - `powershell.exe` (Windows PowerShell 5.1) is only on `PATH` on some
///   images; on a stock Windows install it lives in
///   `%SystemRoot%\System32\WindowsPowerShell\v1.0\`, which is not on `PATH`,
///   so spawning it by bare name fails with `ENOENT`.
/// - a 5.1 install can be partially broken: its `Microsoft.PowerShell.Security`
///   module fails to load, which takes `ConvertTo-SecureString` and
///   `Get-AuthenticodeSignature` with it while the rest of the shell still
///   starts. Probing for the commands the caller actually needs is the only
///   way to notice.
///
/// Candidates are tried in order and each is asked whether it has the
/// commands, so a shell that cannot do the job is never used.
export const POWERSHELL_CANDIDATES = Object.freeze([
  // PowerShell 7 first: it is a single self-contained install and its module
  // set is complete.
  "pwsh.exe",
  "pwsh",
  // Windows PowerShell 5.1, by absolute path and then by name.
  "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "powershell.exe",
]);

function candidatePaths() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  return POWERSHELL_CANDIDATES.map((name) => {
    if (name.startsWith("%SystemRoot%") && systemRoot) {
      return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    }
    return name;
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 65536) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString();
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? { stdout, stderr } : null));
  });
}

/// True when the shell resolves every one of `requiredCommands`.
export async function shellHasCommands(executable, requiredCommands) {
  const script = requiredCommands
    .map(
      (name) =>
        `if (-not (Get-Command ${name} -ErrorAction SilentlyContinue)) { Write-Output 'MISSING:${name}' }`,
    )
    .join("; ");
  const result = await run(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (!result) return false;
  return !result.stdout.includes("MISSING:");
}

/// Returns the first PowerShell that provides `requiredCommands`.
export async function resolvePowerShell(requiredCommands = []) {
  const failures = [];
  for (const candidate of candidatePaths()) {
    const isPath = candidate.includes("/") || candidate.includes("\\");
    if (isPath) {
      try {
        await access(candidate);
      } catch {
        failures.push(`${candidate}: not found`);
        continue;
      }
    }
    if (!(await shellHasCommands(candidate, requiredCommands))) {
      failures.push(`${candidate}: missing ${requiredCommands.join(", ")}`);
      continue;
    }
    return candidate;
  }
  throw new Error(
    `no usable PowerShell found (need: ${requiredCommands.join(", ")}). Tried:\n  ${failures.join("\n  ")}`,
  );
}
