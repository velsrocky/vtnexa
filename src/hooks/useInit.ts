import { useEffect } from "react";
import type { Workspace } from "../types";
import {
  setWorkspaceRoot as setWsRootBackend,
  workspaceRoot as getWsRoot,
  isTauri,
} from "../lib/tauri";
import { isWithin } from "../lib/utils";
import { WS_KEY } from "./useWorkspace";

// Workspace lifecycle: boot init (localStorage → backend $HOME default, no
// hardcoded user path), folder switching (save old session, reload every
// per-project domain), and the native picker.
//
// Sessions are OpenCode-style: the app ALWAYS boots a fresh session per
// folder. Previous sessions live in `<workspace>/.nexa/sessions/` and are
// resumed explicitly from the SessionBar dropdown. The legacy single
// `.nexa/session.json` is left untouched as a backup.
export function useInit(opts: {
  workspaceRoot: string;
  wsCommitted: React.MutableRefObject<string>;
  nexaReady: React.MutableRefObject<boolean>;
  sessionsReady: React.MutableRefObject<boolean>;
  routinesReady: React.MutableRefObject<boolean>;
  setWorkspaceRoot: (v: string) => void;
  setCwdState: React.Dispatch<React.SetStateAction<string>>;
  setWs: React.Dispatch<React.SetStateAction<Workspace>>;
  setOpenPath: (v: string) => void;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  saveSessionNow: () => Promise<void>;
  bootFresh: (root: string, cwd: string) => Promise<void>;
  loadNexa: () => Promise<void>;
  loadRoutines: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  loadConventions: (root: string) => Promise<void>;
}) {
  async function changeWorkspace(next: string) {
    const target = next.trim();
    if (!target || target === opts.wsCommitted.current) return;
    opts.wsCommitted.current = target;
    try {
      await opts.saveSessionNow();
      const canon = await setWsRootBackend(target);
      opts.wsCommitted.current = canon;
      opts.setWorkspaceRoot(canon);
      localStorage.setItem(WS_KEY, canon);
      opts.setCwdState(canon);
      opts.setWs((w) => ({ ...w, cwd: isWithin(canon, w.cwd) && w.cwd ? w.cwd : canon }));
      opts.setOpenPath("");
      opts.nexaReady.current = false;
      await opts.loadNexa();
      opts.sessionsReady.current = false;
      await opts.bootFresh(canon, canon);
      opts.routinesReady.current = false;
      await opts.loadRoutines();
      await opts.refreshSkills();
      await opts.loadConventions(canon);
    } catch (e) {
      opts.wsCommitted.current = "";
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nworkspace change failed: ${e}` }));
    }
  }

  async function browseWorkspace() {
    if (!isTauri()) {
      opts.updateWs((w) => ({
        ...w,
        shellOut: w.shellOut + `\nbrowse unavailable: the folder picker needs the desktop app window (this looks like a plain browser tab) — open VTNexa itself, or type the path directly`,
      }));
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ directory: true, multiple: false, defaultPath: opts.workspaceRoot || undefined });
      if (typeof sel === "string" && sel) await changeWorkspace(sel);
    } catch (e) {
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nbrowse failed: ${e}` }));
    }
  }

  // Init: localStorage → backend ($HOME default). Always boots a FRESH
  // session; previous sessions are resumed explicitly from the dropdown.
  useEffect(() => {
    (async () => {
      try {
        const stored = localStorage.getItem(WS_KEY);
        const initial = stored || (await getWsRoot());
        const canon = await setWsRootBackend(initial);
        opts.wsCommitted.current = canon;
        opts.setWorkspaceRoot(canon);
        localStorage.setItem(WS_KEY, canon);
        opts.setCwdState((c) => c || canon);
        opts.setWs((w) => (w.cwd ? w : { ...w, cwd: canon }));
        await opts.loadNexa();
        await opts.bootFresh(canon, canon);
        await opts.loadRoutines();
        await opts.refreshSkills();
        await opts.loadConventions(canon);
        // A restored workspace may still carry an empty/outside cwd - clamp
        // it without clobbering a real directory.
        opts.setWs((w) => (!w.cwd || !isWithin(canon, w.cwd) ? { ...w, cwd: canon } : w));
      } catch (e) {
        console.warn("workspace init failed", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot-once: opts identity changes every render, effect must run a single time
  }, []);

  return { changeWorkspace, browseWorkspace };
}
