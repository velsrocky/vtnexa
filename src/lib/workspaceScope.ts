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

function stripQuotes(cmd: string): string {
  // Remove single/double-quoted spans so prose like "fix /etc bug" in a
  // commit message doesn't count as touching /etc.
  return cmd.replace(/"([^"\\]|\\.)*"/g, " ").replace(/'([^'\\]|\\.)*'/g, " ");
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** Lexical inside-check (mirrors the backend's safe_absolute + prefix rule). */
export function isPathInsideRoot(path: string, root: string): boolean {
  if (!path.startsWith("/")) return false;
  const r = normalize(root || "/");
  const n = normalize(path);
  return n === r || n.startsWith(r.endsWith("/") ? r : r + "/");
}

function resolveCwd(cwd: string | undefined, root: string): string {
  if (!cwd || cwd === ".") return root;
  return cwd;
}

// Harmless device paths that must not trigger approval (e.g. `> /dev/null`).
const BENIGN_DEV = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/urandom"]);

/** True when a shell command reaches outside the workspace and needs a dialog. */
export function shellTouchesOutside(cmd: string, root: string): boolean {
  const bare = stripQuotes(cmd);
  // Home dir, env-indirected home, privilege escalation.
  if (/(^|[\s;|&()])~(\/|$)/.test(bare)) return true;
  if (/\$HOME|\$\{HOME\}|\$home/i.test(bare)) return true;
  if (/(^|[\s;|&()])(sudo|doas)\b/.test(bare)) return true;
  // Piped network download into a shell = remote code execution as the user.
  if (/\|\s*(sh|bash|zsh|dash|pwsh|powershell)\b/.test(bare)) return true;
  // Absolute paths resolving outside the root (benign /dev nodes exempt).
  const re = /(^|[\s;|&()'"`=])(\/[A-Za-z0-9._~][\w./~+-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) {
    const p = normalize(m[2]);
    if (BENIGN_DEV.has(p)) continue;
    if (!isPathInsideRoot(p, root)) return true;
  }
  // Bare `/` (filesystem root) never matches the token above but is always
  // outside any workspace.
  if (/(^|[\s;|&()])\/(?=[\s;|&()]|$)/.test(bare)) return true;
  return false;
}

/** True when the agent call is workspace-confined and may skip the dialog. */
export function isWorkspaceConfined(tool: string, args: Record<string, unknown>, root: string): boolean {
  if (!root) return false;
  const inside = (p: unknown) => typeof p === "string" && isPathInsideRoot(p, root);
  const cwdOk = (c: unknown) =>
    typeof c !== "string" || c === "" || c === "." || isPathInsideRoot(c, root);
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
      return files.every((f: unknown) => inside(f));
    }
    case "shell_run":
    case "shell_bg": {
      const cwd = resolveCwd(typeof args.cwd === "string" ? args.cwd : "", root);
      if (!isPathInsideRoot(cwd, root)) return false;
      return !shellTouchesOutside(String(args.cmd ?? ""), root);
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
