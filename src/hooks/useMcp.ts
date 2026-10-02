import { useCallback, useEffect, useState } from "react";
import {
  isMcpEnabled,
  mcpListServers,
  mcpListToolsRaw,
  mcpOAuthLogin,
  mcpOAuthLogout,
  mcpOAuthStatus,
  mcpWorkspaceTrust,
  setMcpEnabled,
  setMcpServerEnabled,
  type McpAuthStatus,
} from "../lib/mcp";

export interface McpServerRow {
  name: string;
  kind: string;
  enabled: boolean;
  configured: boolean;
  configured_enabled: boolean;
  trusted: boolean;
  consent_required: boolean;
  workspace_controlled: boolean;
  fingerprint: string;
  tools: number;
  error?: string;
  untrusted?: boolean;
  auth?: McpAuthStatus;
}

// Status panel state for MCP (OpenCode-pattern port). The LLM turn itself
// reads the flag + tools separately in useAgentTurn; this hook is UI only.
export function useMcp({ workspaceRoot }: { workspaceRoot: string }) {
  const [mcpOn, setMcpOn] = useState<boolean>(() => isMcpEnabled());
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
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
        configured: s.configured ?? true,
        configured_enabled: s.configured_enabled ?? s.enabled,
        trusted: s.trusted ?? !s.untrusted,
        consent_required: s.consent_required ?? !!s.untrusted,
        workspace_controlled: s.workspace_controlled ?? !!s.untrusted,
        fingerprint: s.fingerprint ?? "",
        untrusted: !!s.untrusted,
        tools: 0,
      }));
      try {
        const trust = await mcpWorkspaceTrust();
        const consentNames = (trust.workspace_servers ?? []).filter(
          (name) => rows.find((row) => row.name === name)?.consent_required,
        );
        if (consentNames.length > 0) {
          setNote(
            `Consent required for workspace MCP server${consentNames.length === 1 ? "" : "s"}: ${consentNames.join(", ")}. Use Trust & enable to review the native confirmation.`,
          );
        }
      } catch {
        /* trust probe is best-effort */
      }
      const canDiscover = rows.some((row) => row.enabled && row.trusted && row.configured_enabled);
      if (isMcpEnabled() && canDiscover) {
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
      // OAuth state for remote servers (best-effort, never fails refresh).
      await Promise.all(
        rows
          .filter((r) => r.kind === "remote" && r.enabled && r.trusted)
          .map(async (r) => {
            try {
              r.auth = await mcpOAuthStatus(r.name);
            } catch {
              r.auth = undefined;
            }
          }),
      );
      setServers(rows);
    } catch (e) {
      setNote(`servers failed: ${e}`);
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh when the workspace changes or the panel opens. refresh is a
  // useCallback([]) — referentially stable, so listing it is loop-safe.
  useEffect(() => {
    if (showMcp) void refresh();
  }, [showMcp, workspaceRoot, refresh]);

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

  async function signIn(name: string) {
    setSigningIn(name);
    setNote("");
    try {
      const msg = await mcpOAuthLogin(name);
      setNote(msg);
    } catch (e) {
      setNote(`sign-in failed: ${e}`);
    } finally {
      setSigningIn(null);
      await refresh();
    }
  }

  async function signOut(name: string) {
    setNote("");
    try {
      await mcpOAuthLogout(name);
    } catch (e) {
      setNote(`sign-out failed: ${e}`);
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
    signingIn,
    note,
    refresh,
    setServerOn,
    signIn,
    signOut,
    showMcp,
    setShowMcp,
  };
}
