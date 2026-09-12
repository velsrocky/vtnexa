import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, Lane } from "../types";
import { fsList } from "../lib/tauri";
import { ptyWrite } from "../lib/pty";
import { isWithin } from "../lib/utils";

export const WS_KEY = "vtai.workspaceRoot";

// Workspace root + cwd + file list: the sandbox core. refreshFiles lists a
// dir into the tree; setCwd clamps navigation inside the workspace and keeps
// the active lane's cwd and its PTY in lockstep.
// changeWorkspace/init orchestration (session/nexa/routines reloads) stays in
// App - it touches every domain.
export function useWorkspace(opts: {
  laneId: string;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
}) {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [cwd, setCwdState] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const wsCommitted = useRef("");
  const live = useRef(opts);
  live.current = opts;
  const rootRef = useRef("");
  rootRef.current = workspaceRoot;

  const refreshFiles = useCallback(async (dir: string, laneId?: string) => {
    if (!dir) return;
    try {
      setFiles(await fsList(dir));
    } catch (e) {
      setFiles([]);
      const target = laneId ?? live.current.laneId ?? "";
      if (target) {
        live.current.updateLane(target, (l) => ({
          ...l,
          shellOut: l.shellOut + `\nfs error: ${e}`,
        }));
      }
    }
  }, []);

  // Clamp navigation inside the workspace sandbox. Keeps the active lane's
  // cwd and the file-tree cwd in lockstep - the two sources were drifting.
  function setCwd(next: string) {
    const { laneId, updateLane } = live.current;
    const root = rootRef.current;
    if (next && root && !isWithin(root, next)) {
      updateLane(laneId, (l) => ({
        ...l,
        shellOut: l.shellOut + `\nblocked: ${next} is outside workspace ${root}`,
      }));
      return;
    }
    setCwdState(next);
    if (next) {
      updateLane(laneId, (l) => (l.cwd === next ? l : { ...l, cwd: next }));
      // Keep interactive PTY in sync - best-effort, no error surface.
      ptyWrite(laneId, `cd '${next.replace(/'/g, "'\\''")}'\n`).catch(() => {});
    }
  }

  return {
    workspaceRoot,
    setWorkspaceRoot,
    cwd,
    setCwdState,
    setCwd,
    files,
    setFiles,
    refreshFiles,
    wsCommitted,
  };
}

// Switching lanes follows the newly active lane's directory in the file
// tree and keeps its PTY in that directory. Guard the initial mount.
export function useLaneFollow(opts: {
  activeId: string;
  laneId: string;
  laneCwd: string;
  cwd: string;
  workspaceRoot: string;
  setCwdState: (v: string) => void;
}) {
  const prevId = useRef(opts.activeId);
  const live = useRef(opts);
  live.current = opts;
  useEffect(() => {
    const o = live.current;
    if (prevId.current === o.activeId) return;
    prevId.current = o.activeId;
    if (o.laneCwd && o.laneCwd !== o.cwd && isWithin(o.workspaceRoot, o.laneCwd)) {
      o.setCwdState(o.laneCwd);
      ptyWrite(o.laneId, `cd '${o.laneCwd.replace(/'/g, "'\\''")}'\n`).catch(() => {});
    }
  }, [opts.activeId, opts.laneCwd, opts.cwd, opts.workspaceRoot]);
}
