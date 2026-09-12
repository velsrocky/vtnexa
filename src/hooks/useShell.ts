import { useState } from "react";
import type { Workspace } from "../types";
import { shellRun } from "../lib/tauri";

// One-shot shell (agent tool parity): runs a command in the window's cwd
// and appends output to its shell log. User-initiated, no approval gate -
// the click IS the approval. The interactive PTY stays in TerminalPane.
export function useShell(opts: {
  ws: Workspace;
  cwd: string;
  setBusy: (v: boolean) => void;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
}) {
  const [shellCmd, setShellCmd] = useState("ls -la");

  async function runShell() {
    const { ws, cwd, setBusy, updateWs } = opts;
    const cmd = shellCmd.trim();
    if (!cmd) return;
    setBusy(true);
    try {
      const r = await shellRun(ws.cwd || cwd, cmd);
      updateWs((w) => ({
        ...w,
        shellOut: w.shellOut + `\n$ ${cmd}\n${r.stdout}${r.stderr}(exit ${r.code})\n`,
      }));
    } catch (e) {
      updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nshell error: ${e}` }));
    } finally {
      setBusy(false);
    }
  }

  return { shellCmd, onShellCmdChange: setShellCmd, runShell };
}
