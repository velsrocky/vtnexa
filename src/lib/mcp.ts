import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "./providers";

export interface McpServerStatus {
  name: string;
  kind: string;
  enabled: boolean;
}

export interface McpToolInfo {
  server: string;
  name: string;
  qualified_name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const FLAG_KEY = "vtai.mcpEnabled";

/** Feature flag: MCP stays off until the user opts in (context + code-exec risk). */
export function isMcpEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMcpEnabled(on: boolean): void {
  try {
    localStorage.setItem(FLAG_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp_") && name.length > 5 && name.length <= 128 && /^[A-Za-z0-9_]+$/.test(name);
}

export async function mcpListServers(): Promise<McpServerStatus[]> {
  return invoke<McpServerStatus[]>("mcp_list_servers");
}

export async function mcpListTools(): Promise<McpToolInfo[]> {
  if (!isMcpEnabled()) return [];
  const raw = await invoke<McpToolInfo[]>("mcp_list_tools");
  // Backend emits one __error__ pseudo-tool per failing server: keep it out
  // of the LLM tool list, surface via status UI instead.
  return (raw ?? []).filter((t) => t.name !== "__error__" && isMcpToolName(t.qualified_name));
}

export async function mcpCallTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  return invoke<string>("mcp_call_tool", { server, tool, args: args ?? {} });
}

export async function mcpConfigGet(): Promise<{ servers: Record<string, { type: string; enabled: boolean }> }> {
  return invoke("mcp_config_get");
}

// ---- Qualified-name resolution ----
// Sanitizing is lossy (dots/dashes collapse), so exact reverse-mapping needs
// the last tools/list result. The agent turn caches it; runTool resolves via
// exact qualified match first, prefix heuristic as fallback.
let toolCache: McpToolInfo[] = [];

export function setMcpToolCache(tools: McpToolInfo[]): void {
  toolCache = tools ?? [];
}

export function resolveMcpQualified(qualified: string): { server: string; tool: string } | null {
  const exact = toolCache.find((t) => t.qualified_name === qualified);
  if (exact) return { server: exact.server, tool: exact.name };
  // Fallback: derive server by prefix, pass the fragment through as the tool
  // name (works when upstream names were already clean).
  const servers = [...new Set(toolCache.map((t) => t.server))];
  if (servers.length === 0) return null;
  return splitQualifiedName(qualified, servers);
}

/** Convert backend tool infos to LLM tool defs. Descriptions are prefixed so the model knows the origin. */
export function toMcpToolDefs(tools: McpToolInfo[]): ToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.qualified_name,
      description: `[mcp:${t.server}] ${t.description || t.name}`.slice(0, 800),
      parameters:
        t.input_schema && typeof t.input_schema === "object" && Object.keys(t.input_schema).length > 0
          ? (t.input_schema as Record<string, unknown>)
          : { type: "object", properties: {} },
    },
  }));
}

/**
 * Split `mcp_<server>_<tool>` back into parts using longest-server-prefix
 * match (tool names may contain underscores). Returns null when no known
 * server matches.
 */
export function splitQualifiedName(qualified: string, servers: string[]): { server: string; tool: string } | null {  if (!isMcpToolName(qualified)) return null;
  const rest = qualified.slice("mcp_".length);
  // Longest first so `my` doesn't shadow `my_mcp`.
  const sorted = [...servers].sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    const prefix = `${s.toLowerCase()}_`;
    if (rest.toLowerCase().startsWith(prefix)) {
      const tool = rest.slice(prefix.length);
      if (tool) return { server: s, tool };
    }
  }
  return null;
}
