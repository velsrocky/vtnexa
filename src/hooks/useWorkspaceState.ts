import { useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AuditInput, Workspace } from "../types";
import { newWorkspace, uid } from "../lib/utils";
import { loadLastUsed } from "../lib/providerHistory";

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
// single workspace state, its busy flag, in-flight turn, and stream
// coalescing. Approvals are native OS dialogs (see lib/approval) — there is
// no page-DOM approval queue. No lanes - other windows are separate processes
// of the same app with their own state.
export function useWorkspaceState() {
  const [ws, setWs] = useState<Workspace>(() => newWorkspace(wsId, "", loadLastUsed()));
  const [busy, setBusy] = useState(false);
  const turnAbort = useRef<AbortController | null>(null);
  const streamRaf = useRef<number | null>(null);
  const stopTurnIdRef = useRef<string>("");

  // Stable identities: memoized children and context slices below can rely
  // on these never changing, so stream-token setWs calls don't cascade into
  // unrelated panes. (setWs/setBusy from useState are already stable.)
  const updateWs = useCallback((fn: (w: Workspace) => Workspace) => {
    setWs((w) => fn(w));
  }, []);

  const logAudit = useCallback(
    (e: AuditInput) => {
      updateWs((w) => ({
        ...w,
        audit: [...w.audit, { ...e, id: uid(), ts: Date.now() }].slice(-AUDIT_MAX),
      }));
    },
    [updateWs],
  );

  // Stop the running turn: abort the provider request. A native approval
  // dialog already on screen is answered by the user (or dismissed) — there
  // is no page-DOM queue to release. Side effects already applied are undone
  // via /undo, never automatically.
  // Returns true if a turn was stopped, false otherwise.
  const stopTurn = useCallback((id: string) => {
    if (stopTurnIdRef.current && stopTurnIdRef.current !== id) return false;
    turnAbort.current?.abort();
    turnAbort.current = null;
    stopTurnIdRef.current = "";
    return true;
  }, []);

  const flushStreamFrame = useCallback(() => {
    if (streamRaf.current != null) {
      cancelAnimationFrame(streamRaf.current);
      streamRaf.current = null;
    }
  }, []);

  return {
    ws,
    setWs,
    busy,
    setBusy,
    turnAbort,
    stopTurnIdRef,
    streamRaf,
    updateWs,
    logAudit,
    stopTurn,
    flushStreamFrame,
  };
}
