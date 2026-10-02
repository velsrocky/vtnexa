import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { OperationState, Workspace } from "../types";
import { claimFor } from "../lib/approval";
import { shellRun } from "../lib/tauri";

// One-shot shell (agent tool parity): runs a command in the window's cwd
// and appends output to its shell log. User-initiated — the typed command +
// Run click is the intent, claimed backend-side (no extra dialog). The
// interactive PTY stays in TerminalPane.
export function useShell(opts: {
  ws: Workspace;
  cwd: string;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  workspaceGenerationRef?: MutableRefObject<number>;
  sessionEpochRef?: MutableRefObject<number>;
}) {
  const [shellCmd, setShellCmd] = useState("");
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const activeRef = useRef(false);
  const sequenceRef = useRef(0);

  async function runShell(): Promise<boolean> {
    const cmd = shellCmd.trim();
    if (!cmd || activeRef.current) return false;
    activeRef.current = true;
    const sequence = ++sequenceRef.current;
    const targetGeneration = opts.workspaceGenerationRef?.current;
    const targetSessionEpoch = opts.sessionEpochRef?.current;
    const targetWorkspace = opts.ws;
    const targetCwd = targetWorkspace.cwd || opts.cwd;
    setOperation({ status: "pending", message: "Running shell command…" });
    const stillCurrent = () =>
      (targetGeneration == null || opts.workspaceGenerationRef?.current === targetGeneration) &&
      (targetSessionEpoch == null || opts.sessionEpochRef?.current === targetSessionEpoch);
    try {
      const result = await shellRun(targetCwd, cmd, await claimFor("shell_run", { cwd: targetCwd, cmd }));
      if (stillCurrent()) {
        opts.updateWs((w) => ({
          ...w,
          shellOut: w.shellOut + `\n$ ${cmd}\n${result.stdout}${result.stderr}(exit ${result.code})\n`,
        }));
      }
      setOperation({ status: "success", message: `Shell command finished (exit ${result.code}).` });
      return true;
    } catch (error) {
      if (stillCurrent()) {
        opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nshell error: ${error}` }));
      }
      setOperation({ status: "error", message: `Shell command failed: ${error}` });
      return false;
    } finally {
       if (sequenceRef.current === sequence) {
         activeRef.current = false;
       }
    }
  }

  return { shellCmd, onShellCmdChange: setShellCmd, runShell, operation, pending: operation.status === "pending" };
}
