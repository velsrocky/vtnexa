import { useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AuditInput, Workspace } from "../types";
import { newWorkspace, uid } from "../lib/utils";
import { loadLastUsed } from "../lib/providerHistory";
import type { PendingTool } from "../components/ApprovalModal";

const AUDIT_MAX = 100;

/** Stable per-window id: PTYs and logs are namespaced by OS window label.
 * Falls back to "main" outside Tauri (unit tests). */
export const windowLabel = (() => {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
})();
export const wsId = `${windowLabel}:ws`;
export const ptyId = `${windowLabel}:pty`;

// One window = one independent app instance. This hook owns that window's
// single workspace state, its busy flag, in-flight turn, stream coalescing,
// and the approval queue. No lanes - other windows are separate processes of
// the same app with their own state.
export function useWorkspaceState() {
  const [ws, setWs] = useState<Workspace>(() => newWorkspace(wsId, "", loadLastUsed()));
  const [busy, setBusy] = useState(false);
  const turnAbort = useRef<AbortController | null>(null);
  const streamRaf = useRef<number | null>(null);
  const [pendingTools, setPendingTools] = useState<PendingTool[]>([]);
  const stopTurnIdRef = useRef<string>("");

  function updateWs(fn: (w: Workspace) => Workspace) {
    setWs((w) => fn(w));
  }

  function logAudit(e: AuditInput) {
    updateWs((w) => ({
      ...w,
      audit: [...w.audit, { ...e, id: uid(), ts: Date.now() }].slice(-AUDIT_MAX),
    }));
  }

  // Stop the running turn: abort the provider request and release any
  // approval popup waiting. Side effects already applied are not undone.
  // Returns true if a turn was stopped, false otherwise.
  function stopTurn(id: string) {
    if (stopTurnIdRef.current && stopTurnIdRef.current !== id) return false;
    turnAbort.current?.abort();
    turnAbort.current = null;
    stopTurnIdRef.current = "";
    setPendingTools((q) => {
      for (const p of q) p.resolve(false);
      return [];
    });
    return true;
  }

  function flushStreamFrame() {
    if (streamRaf.current != null) {
      cancelAnimationFrame(streamRaf.current);
      streamRaf.current = null;
    }
  }

  function resolveHead(ok: boolean) {
    const [head, ...rest] = pendingTools;
    if (!head) return;
    head.resolve(ok);
    setPendingTools(rest);
  }

  return {
    ws,
    setWs,
    busy,
    setBusy,
    turnAbort,
    stopTurnIdRef,
    streamRaf,
    pendingTools,
    setPendingTools,
    resolveHead,
    updateWs,
    logAudit,
    stopTurn,
    flushStreamFrame,
  };
}
