import { useEffect } from "react";
import type { Workspace } from "../types";
import {
  setWorkspaceRoot as setWsRootBackend,
  workspaceRoot as getWsRoot,
} from "../lib/tauri";
import { isWithin } from "../lib/utils";
import { WS_KEY } from "./useWorkspace";

// Workspace lifecycle: boot init (localStorage → backend $HOME default, no
// hardcoded user path), folder switching (save old session, reload every
// per-project domain), and the native picker. The sequencing that used to
// live inline in App - and that no test could reach - lives here.
export function useInit(opts: {
  workspaceRoot: string;
  wsCommitted: React.MutableRefObject<string>;
  nexaReady: React.MutableRefObject<boolean>;
  sessionReady: React.MutableRefObject<boolean>;
  routinesReady: React.MutableRefObject<boolean>;
  setWorkspaceRoot: (v: string) => void;
  setCwdState: React.Dispatch<React.SetStateAction<string>>;
  setWs: React.Dispatch<React.SetStateAction<Workspace>>;
  setOpenPath: (v: string) => void;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  saveSessionNow: () => Promise<void>;
  loadSession: () => Promise<void>;
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
      opts.sessionReady.current = false;
      await opts.loadSession();
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
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ directory: true, multiple: false, defaultPath: opts.workspaceRoot || undefined });
      if (typeof sel === "string" && sel) await changeWorkspace(sel);
    } catch (e) {
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nbrowse failed: ${e}` }));
    }
  }

  // Init: localStorage → backend ($HOME default). The PTY must start in the
  // project, not $HOME: defer the empty-cwd fix until canon is known, and
  // don't overwrite a restored cwd.
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
        await opts.loadSession();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { changeWorkspace, browseWorkspace };
}
