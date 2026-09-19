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
  requestApproval?: (tool: string, args: Record<string, any>) => Promise<import("./approval").Approval | null>;
  /** Agent wrote a Nexa note directly: mirror it into the sidebar state. */
  onNexaWrite?: (kind: NexaKind, content: string) => void;
  /** Plan mode: runTool refuses every non-read-only tool (fail-closed), and
   *  chatWithTools withholds their defs so the model plans instead of acts. */
  planMode?: boolean;
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
 *  and every non-read-only built-in. Capped: tools cost context per round. */
export function toolsForMode(base: ToolDef[], extra: ToolDef[], plan: boolean): ToolDef[] {
  if (!plan) return [...base, ...extra.slice(0, 50)];
  return base.filter((t) => READONLY_TOOLS.has(t.function.name));
}
