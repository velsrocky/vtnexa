import {
  extractAbsolutePaths,
  hasExplicitUriScheme,
  hasGitPathspecMagic,
  hasPathGlob,
  hasSchemelessNetworkTarget,
  isAbsolutePath,
  isPathInsideRoot,
  isPathInsideRootNative,
  normalizePath,
  resolvePathNative,
  scanShellWords,
} from "./path";
import { MAX_REVIEWABLE_SHELL_COMMAND } from "./approval";

export { isPathInsideRoot } from "./path";

/** Workspace-confinement checks for opencode-style auto-approval.
 *
 *  Rule: agent operations that stay inside the workspace root run WITHOUT an
 *  approval dialog (token is claimed silently by the trusted frontend, never
 *  by the model). Anything reaching outside — absolute paths elsewhere, `~`,
 *  sudo, piped-to-shell downloads — keeps the native OS dialog. Browser and
 *  MCP tools are outside by nature and are never auto-approved.
 *
 *  This is a UX gate, not the security boundary: the Rust backend still
 *  refuses destructive patterns, credential reads, and paths outside the
 *  root even when blindly approved. A prompt-injected model CAN drive
 *  in-workspace writes/shell without a popup in auto mode — that is the
 *  accepted tradeoff, documented in README/SECURITY. */

function resolveCwd(cwd: string | undefined, root: string): string {
  if (!cwd || cwd === ".") return root;
  return cwd;
}

const PRIVATE_PATH_COMPONENTS = [".nexa", ".vtnexa", ".git", ".hg", ".svn"];

function genericPrivatePath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  return path.split(/[\\/]+/).some((part) => {
    const value = part.trim().replace(/[. ]+$/, "").toLowerCase();
    if (PRIVATE_PATH_COMPONENTS.some((name) => value === name || value.startsWith(`${name}:`))) return true;
    if (value.startsWith(":") && PRIVATE_PATH_COMPONENTS.some((name) => value.includes(name))) return true;
    return hasPathGlob(value) && PRIVATE_PATH_COMPONENTS.some((name) => value.includes(name));
  });
}

const BENIGN_DEV = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/urandom"]);

const WINDOWS_ENV_REFERENCE_RE = /%[A-Za-z_][A-Za-z0-9_]*%|\$env:[A-Za-z_][A-Za-z0-9_]*/i;
const WINDOWS_WRAPPER_RE = /(?:^|[\s;&|()])(?:[A-Za-z]:[\\/][^\s"']*[\\/])?(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)(?=\s|$)/i;
const SENSITIVE_SHELL_PATH_RE = /(?:^|[\\/\s])(?:\.ssh|\.gnupg|\.aws)(?:[\\/\s]|$)|appdata|userprofile|c:[\\/]users(?:[\\/]|$)|windows[\\/]system32[\\/](?:config|drivers[\\/]etc)/i;
const CODE_COMMANDS = new Set(["python", "python3", "node", "nodejs", "perl", "ruby", "php", "awk", "gawk", "sed", "find", "xargs"]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "pwsh", "powershell", "cmd"]);
const EMBEDDED_ABSOLUTE_RE = /(?:^|[\s"'=(:,;])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9]|\/(?!\/))/;

function commandBase(value: string): string {
  return value.replace(/^.*[\\/]/, "").toLowerCase();
}

function relativePathEscapes(value: string): boolean {
  if (/\s/.test(value) && !/^[.\\/~]/.test(value) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return false;
  let depth = 0;
  for (const part of value.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
}

function relativeOutsideWord(value: string, quoted: boolean, expanded: boolean): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const equals = trimmed.indexOf("=");
  const candidate = (equals >= 0 ? trimmed.slice(equals + 1) : trimmed).trim();
  if (!candidate) return false;
  if (quoted && !expanded && /^~/.test(candidate)) return false;
  if (/^(?:~|\.\.(?:[\\/]|$))/.test(candidate)) return true;
  if (relativePathEscapes(candidate)) return true;
  if (/^[A-Za-z]:/.test(candidate) && !isAbsolutePath(candidate)) return true;
  if (/^\\/.test(candidate) && !isAbsolutePath(candidate)) return true;
  return false;
}

function privateWord(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const candidate = trimmed.includes("=") ? trimmed.slice(trimmed.indexOf("=") + 1) : trimmed;
  return genericPrivatePath(candidate) && (candidate.startsWith(".") || candidate.startsWith(":") || candidate.startsWith("/") || candidate.startsWith("\\") || candidate.includes("/") || candidate.includes("\\") || hasPathGlob(candidate));
}

function hasRiskyCodeWord(scan: ReturnType<typeof scanShellWords>): boolean {
  for (let index = 0; index < scan.words.length; index += 1) {
    const base = commandBase(scan.words[index].value);
    if (!CODE_COMMANDS.has(base) && !SHELL_COMMANDS.has(base)) continue;
    const rest = scan.words.slice(index + 1);
    if (
      (CODE_COMMANDS.has(base) && !["awk", "gawk", "sed", "find", "xargs"].includes(base)) &&
      rest.some((word) => ["-c", "-e", "-r", "--eval", "--command"].includes(word.value))
    ) return true;
    if (SHELL_COMMANDS.has(base) && rest.some((word) => ["-c", "/c", "-Command"].includes(word.value))) return true;
    if (["awk", "gawk", "sed"].includes(base)) {
      const scriptIndex = rest.findIndex(
        (word, offset) => word.quoted && (offset === 0 || ["-e", "-f"].includes(rest[offset - 1]?.value)),
      );
      if (scriptIndex >= 0 && EMBEDDED_ABSOLUTE_RE.test(rest[scriptIndex].value)) return true;
    }
  }
  return false;
}

function shellRequiresApproval(cmd: string, scan: ReturnType<typeof scanShellWords>): boolean {
  if (!cmd.trim() || !scan.complete || scan.unsupported || cmd.length > MAX_REVIEWABLE_SHELL_COMMAND || hasExplicitUriScheme(cmd) || hasSchemelessNetworkTarget(cmd)) return true;
  const first = scan.words[0] ? commandBase(scan.words[0].value) : "";
  if (first && ["eval", "exec", "source", ".", "command", "builtin", "sh", "bash", "zsh", "dash"].includes(first)) return true;
  if (first === "env" && scan.words.slice(1).some((word) => ["-S", "--split-string"].includes(word.value))) return true;
  if (hasRiskyCodeWord(scan)) return true;
  if (WINDOWS_ENV_REFERENCE_RE.test(cmd) || /\$HOME|\$\{HOME\}|\$home/i.test(cmd)) return true;
  if (WINDOWS_WRAPPER_RE.test(cmd) || SENSITIVE_SHELL_PATH_RE.test(cmd)) return true;
  if (/(^|[\s;&|()])(sudo|doas)\b/.test(cmd)) return true;
  if (/\|\s*(sh|bash|zsh|dash|pwsh|powershell)\b/.test(cmd)) return true;
  for (const word of scan.words) {
    if (word.expanded) return true;
    if (relativeOutsideWord(word.value, word.quoted, word.expanded)) return true;
    if (privateWord(word.value)) return true;
  }
  return false;
}

function shellPathsRequireApproval(paths: string[], inside: (path: string) => boolean): boolean {
  for (const raw of paths) {
    if (hasExplicitUriScheme(raw) || hasPathGlob(raw) || genericPrivatePath(raw)) return true;
    const path = normalizePath(raw);
    if (BENIGN_DEV.has(path)) continue;
    if (!inside(path)) return true;
  }
  return false;
}


/** True when a shell command reaches outside the workspace and needs a dialog. */
export function shellTouchesOutside(cmd: string, root: string): boolean {
  if (typeof cmd !== "string" || !root) return true;
  const scan = scanShellWords(cmd);
  if (shellRequiresApproval(cmd, scan)) return true;
  return shellPathsRequireApproval(extractAbsolutePaths(cmd, true), (path) => isPathInsideRoot(path, root));
}

async function shellTouchesOutsideNative(cmd: string, root: string): Promise<boolean> {
  if (typeof cmd !== "string" || !root) return true;
  const scan = scanShellWords(cmd);
  if (shellRequiresApproval(cmd, scan)) return true;
  for (const raw of extractAbsolutePaths(cmd, true)) {
    if (hasExplicitUriScheme(raw) || hasPathGlob(raw) || genericPrivatePath(raw)) return true;
    const path = normalizePath(raw);
    if (BENIGN_DEV.has(path)) continue;
    if (!(await isPathInsideRootNative(path, root))) return true;
  }
  return false;
}

/** True when the agent call is workspace-confined and may skip the dialog. */
export function isWorkspaceConfined(tool: string, args: Record<string, unknown>, root: string): boolean {
  if (!root) return false;
  const inside = (p: unknown) =>
    typeof p === "string" && !hasPathGlob(p) && !genericPrivatePath(p) && isPathInsideRoot(p, root);
  const gitInside = (p: unknown) =>
    typeof p === "string" && !hasGitPathspecMagic(p) && !hasPathGlob(p) && !genericPrivatePath(p) && isPathInsideRoot(p, root);
  const cwdOk = (c: unknown) =>
    typeof c !== "string" ||
    c === "" ||
    c === "." ||
    (!hasPathGlob(c) && !hasGitPathspecMagic(c) && !genericPrivatePath(c) && isPathInsideRoot(c, root));
  switch (tool) {
    case "fs_write":
    case "fs_create":
      return inside(args.path);
    case "fs_rename":
      return inside(args.old_path) && inside(args.new_path);
    case "fs_delete":
      return inside(args.path);
    case "git_commit": {
      if (!cwdOk(args.cwd)) return false;
      const files = Array.isArray(args.files) ? args.files : [];
      return files.length > 0 && files.every((f: unknown) => gitInside(f));
    }
    case "shell_run":
    case "shell_bg": {
      const cwd = resolveCwd(typeof args.cwd === "string" ? args.cwd : "", root);
      if (hasPathGlob(cwd) || genericPrivatePath(cwd) || !isPathInsideRoot(cwd, root)) return false;
      return typeof args.cmd === "string" && !shellTouchesOutside(args.cmd, root);
    }
    case "shell_kill":
    case "shell_poll":
      return true;
    case "lsp_diagnostics":
    case "lsp":
      return inside(args.path);
    default:
      return false;
  }
}

export async function isWorkspaceConfinedNative(
  tool: string,
  args: Record<string, unknown>,
  root: string,
  cwd?: string,
): Promise<boolean> {
  if (!root) return false;
  const inside = async (value: unknown): Promise<boolean> => {
    if (typeof value !== "string" || !value || hasPathGlob(value) || genericPrivatePath(value)) return false;
    const resolved = isAbsolutePath(value) ? value : await resolvePathNative(value, cwd || root);
    return !genericPrivatePath(resolved) && isPathInsideRootNative(resolved, root);
  };
  const gitInside = async (value: unknown): Promise<boolean> => {
    if (typeof value !== "string" || !value || hasGitPathspecMagic(value) || hasPathGlob(value) || genericPrivatePath(value)) return false;
    const resolved = isAbsolutePath(value) ? value : await resolvePathNative(value, cwd || root);
    return !genericPrivatePath(resolved) && isPathInsideRootNative(resolved, root);
  };
  const cwdOk = async (value: unknown): Promise<boolean> => {
    if (typeof value !== "string" || value === "" || value === ".") return true;
    return !hasPathGlob(value) && !hasGitPathspecMagic(value) && !genericPrivatePath(value) && isAbsolutePath(value) && isPathInsideRootNative(value, root);
  };
  switch (tool) {
    case "fs_write":
    case "fs_create":
    case "fs_delete":
      return inside(args.path);
    case "fs_rename":
      return (await inside(args.old_path)) && (await inside(args.new_path));
    case "git_commit": {
      if (!(await cwdOk(args.cwd))) return false;
      const files = Array.isArray(args.files) ? args.files : [];
      if (files.length === 0) return false;
      for (const file of files) {
        if (!(await gitInside(file))) return false;
      }
      return true;
    }
    case "shell_run":
    case "shell_bg": {
      const shellCwd = resolveCwd(typeof args.cwd === "string" ? args.cwd : "", root);
      if (hasPathGlob(shellCwd) || genericPrivatePath(shellCwd) || !isAbsolutePath(shellCwd) || !(await isPathInsideRootNative(shellCwd, root))) return false;
      return typeof args.cmd === "string" && !(await shellTouchesOutsideNative(args.cmd, root));
    }
    case "shell_kill":
    case "shell_poll":
      return true;
    case "lsp_diagnostics":
    case "lsp":
      return inside(args.path);
    default:
      return false;
  }
}
