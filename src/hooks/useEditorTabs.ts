import type { CenterTab, Workspace } from "../types";
import { fsRead } from "../lib/tauri";
import { baseName, isWithin } from "../lib/utils";
import { useConfirm } from "../context/ConfirmContext";

// Per-window tabs and buffers: open/close files, rename/delete retargeting,
// shell/PTY heights. Window-state patching lives here; the Diff gate and
// preview compose on top (see useDiffGate, useEditor).
export function useEditorTabs(opts: {
  ws: Workspace;
  setWs: React.Dispatch<React.SetStateAction<Workspace>>;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  workspaceRoot: string;
  setCenterTab: (t: CenterTab) => void;
}) {
  const { ws, setWs, updateWs, workspaceRoot } = opts;
  const confirm = useConfirm();
  const openPath = ws.openPath ?? "";
  const tabs = ws.tabs ?? [];
  const buffers = ws.buffers ?? {};
  const originals = ws.originals ?? {};
  const editorText = openPath ? (buffers[openPath] ?? "") : "// open a file from the tree";
  const originalText = openPath ? (originals[openPath] ?? "") : "// open a file from the tree";
  const shellH = ws.shellH ?? 80;
  const ptyH = ws.ptyH ?? 220;
  const previewUrl = ws.previewUrl ?? "";
  const setPreviewUrl = (v: string) =>
    setWs((w) => ({ ...w, previewUrl: v }));

  const setOpenPath = (v: string | ((p: string) => string)) => {
    const next = typeof v === "function" ? (v as (p: string) => string)(openPath) : v;
    setWs((w) => ({ ...w, openPath: next }));
  };
  const setEditorText = (v: string | ((p: string) => string)) => {
    if (!openPath) return;
    const next = typeof v === "function" ? (v as (p: string) => string)(editorText) : v;
    setWs((w) => ({ ...w, buffers: { ...(w.buffers ?? {}), [openPath]: next } }));
  };
  const setOriginalText = (v: string | ((p: string) => string)) => {
    if (!openPath) return;
    const next = typeof v === "function" ? (v as (p: string) => string)(originalText) : v;
    setWs((w) => ({ ...w, originals: { ...(w.originals ?? {}), [openPath]: next } }));
  };
  const setTabs: React.Dispatch<React.SetStateAction<string[]>> = (v) => {
    const next = typeof v === "function" ? (v as (p: string[]) => string[])(tabs) : v;
    setWs((w) => ({ ...w, tabs: next }));
  };
  const setBuffers: React.Dispatch<React.SetStateAction<Record<string, string>>> = (v) => {
    const next = typeof v === "function" ? (v as (p: Record<string, string>) => Record<string, string>)(buffers) : v;
    setWs((w) => ({ ...w, buffers: next }));
  };
  const setOriginals: React.Dispatch<React.SetStateAction<Record<string, string>>> = (v) => {
    const next = typeof v === "function" ? (v as (p: Record<string, string>) => Record<string, string>)(originals) : v;
    setWs((w) => ({ ...w, originals: next }));
  };
  const setShellH: React.Dispatch<React.SetStateAction<number>> = (v) => {
    const next = typeof v === "function" ? (v as (p: number) => number)(shellH) : v;
    setWs((w) => ({ ...w, shellH: next }));
    try {
      localStorage.setItem("vtai.shellH", String(next));
    } catch {
      /* ignore */
    }
  };
  const setPtyH: React.Dispatch<React.SetStateAction<number>> = (v) => {
    const next = typeof v === "function" ? (v as (p: number) => number)(ptyH) : v;
    setWs((w) => ({ ...w, ptyH: next }));
    try {
      localStorage.setItem("vtai.ptyH", String(next));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("resize"));
  };

  // Horizontal (row) resizer for stacked heights in the editor column.
  // Dragging up grows the region below the bar.
  function onHResizerDown(which: "shell" | "pty") {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = which === "shell" ? shellH : ptyH;
      const [lo, hi, key] =
        which === "shell" ? [40, 300, "vtai.shellH"] : [100, 600, "vtai.ptyH"];
      const move = (ev: MouseEvent) => {
        const h = Math.round(Math.min(hi, Math.max(lo, startH - (ev.clientY - startY))));
        if (which === "shell") setShellH(h);
        else setPtyH(h);
        try {
          localStorage.setItem(key, String(h));
        } catch {
          /* ignore */
        }
        // Nudge xterm to refit to its new box (TerminalPane listens).
        window.dispatchEvent(new Event("resize"));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.dispatchEvent(new Event("resize"));
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };
  }
  async function openFile(path: string) {
    if (workspaceRoot && !isWithin(workspaceRoot, path)) {
      updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nblocked: outside workspace` }));
      return;
    }
    // Already open → just activate (buffer preserved, edits intact).
    if (tabs.includes(path)) {
      setOpenPath(path);
      setEditorText(buffers[path] ?? "");
      setOriginalText(originals[path] ?? "");
      opts.setCenterTab("edit");
      return;
    }
    try {
      const text = await fsRead(path);
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setBuffers((b) => ({ ...b, [path]: text }));
      setOriginals((o) => ({ ...o, [path]: text }));
      setOpenPath(path);
      setEditorText(text);
      setOriginalText(text);
      opts.setCenterTab("edit");
    } catch (e) {
      updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nopen failed: ${e}` }));
    }
  }

  async function closeTab(path: string) {
    if ((buffers[path] ?? "") !== (originals[path] ?? "")) {
      if (!(await confirm(`Close ${baseName(path)} with unsaved changes?`))) return;
    }
    const idx = tabs.indexOf(path);
    const next = tabs.filter((p) => p !== path);
    const closingActive = openPath === path;
    const nxt = closingActive ? next[Math.min(idx, next.length - 1)] ?? "" : openPath;
    setWs((w) => {
      const b = { ...(w.buffers ?? {}) };
      const o = { ...(w.originals ?? {}) };
      delete b[path];
      delete o[path];
      return { ...w, tabs: next, buffers: b, originals: o, openPath: nxt };
    });
  }

  // After a rename, retarget every tab/buffer under the old path (handles
  // renamed directories containing open files) and the pending diff.
  function retargetTabs(oldP: string, newP: string) {
    const swap = (p: string) => (p === oldP ? newP : p.startsWith(oldP + "/") ? newP + p.slice(oldP.length) : p);
    const rekey = (m: Record<string, string>) => {
      const n: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) n[swap(k)] = v;
      return n;
    };
    setTabs((t) => t.map(swap));
    setBuffers(rekey);
    setOriginals(rekey);
    if (openPath === oldP || openPath.startsWith(oldP + "/")) setOpenPath(swap(openPath));
    setWs((w) =>
      w.pendingDiff && (w.pendingDiff.path === oldP || w.pendingDiff.path.startsWith(oldP + "/"))
        ? { ...w, pendingDiff: { ...w.pendingDiff, path: swap(w.pendingDiff.path) } }
        : w,
    );
  }

  // After a delete, drop any tabs under the deleted path and clear a
  // dangling pending diff.
  function dropTabsUnder(path: string) {
    const under = (p: string) => p === path || p.startsWith(path + "/");
    const next = tabs.filter((p) => !under(p));
    setTabs(next);
    setBuffers((b) => {
      const n: Record<string, string> = {};
      for (const [k, v] of Object.entries(b)) if (!under(k)) n[k] = v;
      return n;
    });
    setOriginals((o) => {
      const n: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if (!under(k)) n[k] = v;
      return n;
    });
    if (openPath && under(openPath)) {
      setOpenPath("");
      setEditorText("// open a file from the tree");
      setOriginalText("// open a file from the tree");
    }
    setWs((w) => (w.pendingDiff && under(w.pendingDiff.path) ? { ...w, pendingDiff: null } : w));
  }

  return {
    openPath,
    setOpenPath,
    tabs,
    buffers,
    originals,
    editorText,
    originalText,
    setEditorText,
    setOriginalText,
    setTabs,
    setBuffers,
    setOriginals,
    shellH,
    ptyH,
    onHResizerDown,
    previewUrl,
    setPreviewUrl,
    openFile,
    closeTab,
    retargetTabs,
    dropTabsUnder,
  };
}

