import type { UndoEntry } from "../types";
import type { NexaKind } from "./tauri";

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolPolicy {
  /** Agent fs_write no longer writes directly: stage into Diff review gate.
   *  May be async - the UI fetches the on-disk original for a faithful diff. */
  onProposeWrite?: (path: string, content: string) => void | Promise<void>;
  /** Return an Approval (native OS dialog confirmed) to allow
   *  shell/browser/file side-effects, null to reject. Read-only tools bypass
   *  this. The dialog lives outside page DOM so injected content and the model
   *  cannot click it. */
  requestApproval?: (tool: string, args: Record<string, unknown>) => Promise<import("./approval").Approval | null>;
  /** Agent wrote a Nexa note directly: mirror it into the sidebar state. */
  onNexaWrite?: (kind: NexaKind, content: string) => void;
  /** Plan mode: runTool refuses every non-read-only tool (fail-closed), and
   *  chatWithTools withholds their defs so the model plans instead of acts. */
  planMode?: boolean;
  /** Opencode-style auto-approval: workspace-confined operations skip the
   *  approval dialog (frontend claims the token silently); anything reaching
   *  outside the workspace keeps the native dialog. Requires workspaceRoot. */
  autoApproveWorkspace?: boolean;
  workspaceRoot?: string;
  /** Fires when runTool auto-claimed (no dialog) — lets the caller tag audits. */
  onAutoApproval?: (tool: string) => void;
  /** Skill confinement (from skillConfinement): the turn may offer and run
   *  ONLY these tools. runTool refuses anything else fail-closed BEFORE any
   *  approval dialog, so a read-only skill can never pop a side-effect
   *  approval. Unset = full surface. */
  allowedTools?: { skill: string; tools: string[] };
  /** Reversible agent file op just applied (rename/delete) - UI pushes it for /undo. */
  onUndoCapture?: (e: UndoEntry) => void;
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/** Plan-mode allowlist: everything else is withheld from the model and
 *  refused by runTool. Writes are out entirely - even staged ones.
 *  NOTE: lsp_diagnostics/lsp are NOT read-only (ts/rs spawn workspace code:
 *  tsc/build.rs, local language servers) — they need approval in Build and
 *  are withheld in Plan. Python py_compile stays gated dynamically (safe). */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "fs_list",
  "fs_read",
  "fs_search",
  "fs_glob",
  "skill_list",
  "skill_read",
  "sessions_list",
  "session_read",
  "git_status",
  "git_diff",
  "git_log",
  "nexa_read",
  "browser_snapshot",
  "browser_screenshot",
  "browser_scroll",
  "shell_poll",
]);

export function isReadOnlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name);
}

// Side-effecting tools require explicit user approval + backend token.
// lsp_* are gated dynamically (ts/rs need approval; py is pure) — see
// runTool needsGate, not here.
const GATED_TOOLS = new Set([
  "shell_run",
  "shell_bg",
  "shell_kill",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_back",
  "git_commit",
  "fs_rename",
  "fs_delete",
]);

/** MCP tools (`mcp_*`) always require approval — OpenCode `mcp_* ask` default. */
export function isGatedTool(name: string): boolean {
  if (GATED_TOOLS.has(name)) return true;
  return name.startsWith("mcp_") && name.length > 5 && name.length <= 128 && /^[A-Za-z0-9_]+$/.test(name);
}

/** Turn tool list for the mode. Plan drops MCP extras (unknown side effects)
 *  and every non-read-only built-in. `allowed` (skill confinement) narrows
 *  further to the skill's own tools, extras included. Capped: tools cost
 *  context per round. */
export function toolsForMode(
  base: ToolDef[],
  extra: ToolDef[],
  plan: boolean,
  allowed?: string[] | null,
): ToolDef[] {
  if (!plan) {
    if (!allowed) return [...base, ...extra.slice(0, 50)];
    const set = new Set(allowed);
    return [...base, ...extra.slice(0, 50)].filter((t) => set.has(t.function.name));
  }
  if (!allowed) return base.filter((t) => READONLY_TOOLS.has(t.function.name));
  const set = new Set(allowed);
  return base.filter((t) => READONLY_TOOLS.has(t.function.name) && set.has(t.function.name));
}
