import type { ToolDef } from "./providers";

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
