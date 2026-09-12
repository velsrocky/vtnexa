import { useRef } from "react";
import type { Lane } from "../types";
import { shellRun } from "../lib/tauri";

// One-shot shell (agent tool parity): runs a command in the lane's cwd and
// appends output to the lane's shell log. User-initiated, no approval gate -
// the click IS the approval. The interactive PTY stays in TerminalPane.
export function useShell(opts: {
  lane: Lane;
  cwd: string;
  setLanes: React.Dispatch<React.SetStateAction<Lane[]>>;
  setLaneBusy: (id: string, v: boolean) => void;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
}) {
  const shellCmdByLane = useRef<Record<string, string>>({ ls: "ls -la" });
  const shellCmd = shellCmdByLane.current[opts.lane.id] ?? "ls -la";

  function onShellCmdChange(v: string) {
    shellCmdByLane.current[opts.lane.id] = v;
    // Nudge a re-render for this lane's input value.
    opts.setLanes((ls) => [...ls]);
  }

  async function runShell() {
    const { lane, cwd, setLaneBusy, updateLane } = opts;
    const laneId = lane.id;
    const laneCwd = lane.cwd;
    const cmd = (shellCmdByLane.current[laneId] ?? "ls -la").trim();
    if (!cmd) return;
    setLaneBusy(laneId, true);
    try {
      const r = await shellRun(laneCwd || cwd, cmd);
      updateLane(laneId, (l) => ({
        ...l,
        shellOut: l.shellOut + `\n$ ${cmd}\n${r.stdout}${r.stderr}(exit ${r.code})\n`,
      }));
    } catch (e) {
      updateLane(laneId, (l) => ({ ...l, shellOut: l.shellOut + `\nshell error: ${e}` }));
    } finally {
      setLaneBusy(laneId, false);
    }
  }

  return { shellCmd, onShellCmdChange, runShell };
}
