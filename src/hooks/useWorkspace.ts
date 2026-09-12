import { useCallback, useRef, useState } from "react";
import type { FileEntry, Workspace } from "../types";
import { fsList } from "../lib/tauri";
import { ptyWrite } from "../lib/pty";
import { isWithin } from "../lib/utils";

export const WS_KEY = "vtai.workspaceRoot";

// Workspace root + cwd + file list: this window's sandbox core. refreshFiles
// lists a dir into the tree; setCwd clamps navigation inside the workspace
// and keeps the workspace cwd and this window's PTY in lockstep.
// changeWorkspace/init orchestration lives in useInit - it touches every
// domain.
export function useWorkspace(opts: {
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  ptyId: string;
}) {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [cwd, setCwdState] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const wsCommitted = useRef("");
  const live = useRef(opts);
  live.current = opts;
  const rootRef = useRef("");
  rootRef.current = workspaceRoot;

  const refreshFiles = useCallback(async (dir: string) => {
    if (!dir) return;
    try {
      setFiles(await fsList(dir));
    } catch (e) {
      setFiles([]);
      live.current.updateWs((w) => ({
        ...w,
        shellOut: w.shellOut + `\nfs error: ${e}`,
      }));
    }
  }, []);

  // Clamp navigation inside the workspace sandbox. Keeps the workspace cwd
  // and the file-tree cwd in lockstep - the two sources were drifting.
  function setCwd(next: string) {
    const { updateWs, ptyId } = live.current;
    const root = rootRef.current;
    if (next && root && !isWithin(root, next)) {
      updateWs((w) => ({
        ...w,
        shellOut: w.shellOut + `\nblocked: ${next} is outside workspace ${root}`,
      }));
      return;
    }
    setCwdState(next);
    if (next) {
      updateWs((w) => (w.cwd === next ? w : { ...w, cwd: next }));
      // Keep interactive PTY in sync - best-effort, no error surface.
      ptyWrite(ptyId, `cd '${next.replace(/'/g, "'\\''")}'\n`).catch(() => {});
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
