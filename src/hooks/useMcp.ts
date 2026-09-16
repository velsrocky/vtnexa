import { useCallback, useEffect, useState } from "react";
import {
  isMcpEnabled,
  mcpListServers,
  mcpListToolsRaw,
  setMcpEnabled,
  setMcpServerEnabled,
} from "../lib/mcp";

export interface McpServerRow {
  name: string;
  kind: string;
  enabled: boolean;
  tools: number;
  error?: string;
}

// Status panel state for MCP (OpenCode-pattern port). The LLM turn itself
// reads the flag + tools separately in useAgentTurn; this hook is UI only.
export function useMcp({ workspaceRoot }: { workspaceRoot: string }) {
  const [mcpOn, setMcpOn] = useState<boolean>(() => isMcpEnabled());
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [showMcp, setShowMcp] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setNote("");
    try {
      const list = await mcpListServers();
      const rows: McpServerRow[] = list.map((s) => ({
        name: s.name,
        kind: s.kind,
        enabled: s.enabled,
        tools: 0,
      }));
      if (isMcpEnabled()) {
        try {
          const raw = await mcpListToolsRaw();
          const counts = new Map<string, number>();
          const errs = new Map<string, string>();
          for (const t of raw ?? []) {
            if (t.name === "__error__") {
              errs.set(t.server, t.description);
            } else {
              counts.set(t.server, (counts.get(t.server) ?? 0) + 1);
            }
          }
          for (const r of rows) {
            r.tools = counts.get(r.name) ?? 0;
            const e = errs.get(r.name);
            if (e) r.error = e;
          }
        } catch (e) {
          setNote(`tools failed: ${e}`);
        }
      }
      setServers(rows);
    } catch (e) {
      setNote(`servers failed: ${e}`);
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh when the workspace changes or the panel opens.
  useEffect(() => {
    if (showMcp) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMcp, workspaceRoot]);

  async function setOn(on: boolean) {
    setMcpEnabled(on);
    setMcpOn(on);
    await refresh();
  }

  async function setServerOn(name: string, on: boolean) {
    setNote("");
    try {
      await setMcpServerEnabled(name, on);
    } catch (e) {
      setNote(`save failed: ${e}`);
    }
    await refresh();
  }

  return {
    mcpOn,
    setMcpOn: setOn,
    servers,
    toolCount: servers.reduce((n, s) => n + s.tools, 0),
    errorCount: servers.filter((s) => s.error).length,
    loading,
    note,
    refresh,
    setServerOn,
    showMcp,
    setShowMcp,
  };
}
