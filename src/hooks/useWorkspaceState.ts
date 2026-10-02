import { useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AuditInput, OperationState, Workspace } from "../types";
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

export function useWorkspaceState() {
  const [ws, setWs] = useState<Workspace>(() => newWorkspace(wsId, "", loadLastUsed()));
  const [agentOperation, setAgentOperation] = useState<OperationState>({ status: "idle" });
  const agentActiveRef = useRef(false);
  const agentSequenceRef = useRef(0);
  const activeAgentSequenceRef = useRef<number | null>(null);
  const workspaceGenerationRef = useRef(0);
  const turnAbort = useRef<AbortController | null>(null);
  const streamRaf = useRef<number | null>(null);
  const stopTurnIdRef = useRef<string>("");

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

  const startAgentTurn = useCallback(() => {
    const sequence = ++agentSequenceRef.current;
    activeAgentSequenceRef.current = sequence;
    agentActiveRef.current = true;
    setAgentOperation({ status: "pending", message: "Commander is working…" });
    return sequence;
  }, []);

  const finishAgentTurn = useCallback((sequence: number, status: "success" | "error", message: string) => {
    if (activeAgentSequenceRef.current !== sequence) return;
    activeAgentSequenceRef.current = null;
    agentActiveRef.current = false;
    setAgentOperation({ status, message });
  }, []);

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
    agentOperation,
    agentActive: agentOperation.status === "pending",
    agentActiveRef,
    startAgentTurn,
    finishAgentTurn,
    workspaceGenerationRef,
    turnAbort,
    stopTurnIdRef,
    streamRaf,
    updateWs,
    logAudit,
    stopTurn,
    flushStreamFrame,
  };
}
