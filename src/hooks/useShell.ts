import { useState } from "react";
import type { Workspace } from "../types";
import { claimFor } from "../lib/approval";
import { shellRun } from "../lib/tauri";

// One-shot shell (agent tool parity): runs a command in the window's cwd
// and appends output to its shell log. User-initiated — the typed command +
// Run click is the intent, claimed backend-side (no extra dialog). The
// interactive PTY stays in TerminalPane.
export function useShell(opts: {
  ws: Workspace;
  cwd: string;
  setBusy: (v: boolean) => void;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
}) {
  const [shellCmd, setShellCmd] = useState("ls -la");

  async function runShell() {
    const { ws, setBusy, updateWs } = opts;
    const cmd = shellCmd.trim();
    if (!cmd) return;
    setBusy(true);
    try {
      const cwd = ws.cwd || opts.cwd;
      const r = await shellRun(cwd, cmd, await claimFor("shell_run", { cwd, cmd }));
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
