import type { CenterTab, Lane } from "../types";
import { fsRead } from "../lib/tauri";
import { baseName, isWithin } from "../lib/utils";

// Per-lane tabs and buffers: open/close files, rename/delete retargeting,
// shell/PTY heights. Lane-patching state lives here; the Diff gate and
// preview compose on top (see useDiffGate, useEditor).
export function useEditorTabs(opts: {
  lane: Lane;
  setLanes: React.Dispatch<React.SetStateAction<Lane[]>>;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
  workspaceRoot: string;
  setCenterTab: (t: CenterTab) => void;
}) {
  const { lane, setLanes, updateLane, workspaceRoot } = opts;
  const openPath = lane.openPath ?? "";
  const tabs = lane.tabs ?? [];
  const buffers = lane.buffers ?? {};
  const originals = lane.originals ?? {};
  const editorText = openPath ? (buffers[openPath] ?? "") : "// open a file from the tree";
  const originalText = openPath ? (originals[openPath] ?? "") : "// open a file from the tree";
  const shellH = lane.shellH ?? 80;
  const ptyH = lane.ptyH ?? 220;
  const previewUrl = lane.previewUrl ?? "";
  const setPreviewUrl = (v: string) =>
    setLanes((ls) =>
      ls.map((l) => (l.id === lane.id ? { ...l, previewUrl: v } : l)),
    );

  const setOpenPath = (v: string | ((p: string) => string)) => {
    const next = typeof v === "function" ? (v as (p: string) => string)(openPath) : v;
    setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, openPath: next } : l)));
  };
  const setEditorText = (v: string | ((p: string) => string)) => {
    if (!openPath) return;
    const next = typeof v === "function" ? (v as (p: string) => string)(editorText) : v;
    setLanes((ls) =>
      ls.map((l) => (l.id === lane.id ? { ...l, buffers: { ...(l.buffers ?? {}), [openPath]: next } } : l)),
    );
  };
  const setOriginalText = (v: string | ((p: string) => string)) => {
    if (!openPath) return;
    const next = typeof v === "function" ? (v as (p: string) => string)(originalText) : v;
    setLanes((ls) =>
      ls.map((l) => (l.id === lane.id ? { ...l, originals: { ...(l.originals ?? {}), [openPath]: next } } : l)),
    );
  };
  const setTabs: React.Dispatch<React.SetStateAction<string[]>> = (v) => {
    const next = typeof v === "function" ? (v as (p: string[]) => string[])(tabs) : v;
    setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, tabs: next } : l)));
  };
  const setBuffers: React.Dispatch<React.SetStateAction<Record<string, string>>> = (v) => {
    const next = typeof v === "function" ? (v as (p: Record<string, string>) => Record<string, string>)(buffers) : v;
    setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, buffers: next } : l)));
  };
  const setOriginals: React.Dispatch<React.SetStateAction<Record<string, string>>> = (v) => {
    const next = typeof v === "function" ? (v as (p: Record<string, string>) => Record<string, string>)(originals) : v;
    setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, originals: next } : l)));
  };
  const setShellH: React.Dispatch<React.SetStateAction<number>> = (v) => {
    const next = typeof v === "function" ? (v as (p: number) => number)(shellH) : v;
    setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, shellH: next } : l)));
    try {
      localStorage.setItem("vtai.shellH", String(next));
    } catch {
      /* ignore */
    }
  };
  const setPtyH: React.Dispatch<React.SetStateAction<number>> = (v) => {
    const next = typeof v === "function" ? (v as (p: number) => number)(ptyH) : v;
    setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, ptyH: next } : l)));
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
      updateLane(lane.id, (l) => ({ ...l, shellOut: l.shellOut + `\nblocked: outside workspace` }));
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
      updateLane(lane.id, (l) => ({ ...l, shellOut: l.shellOut + `\nopen failed: ${e}` }));
    }
  }

  function closeTab(path: string) {
    if ((buffers[path] ?? "") !== (originals[path] ?? "")) {
      if (!window.confirm(`Close ${baseName(path)} with unsaved changes?`)) return;
    }
    const idx = tabs.indexOf(path);
    const next = tabs.filter((p) => p !== path);
    const closingActive = openPath === path;
    const nxt = closingActive ? next[Math.min(idx, next.length - 1)] ?? "" : openPath;
    setLanes((ls) =>
      ls.map((l) => {
        if (l.id !== lane.id) return l;
        const b = { ...(l.buffers ?? {}) };
        const o = { ...(l.originals ?? {}) };
        delete b[path];
        delete o[path];
        return { ...l, tabs: next, buffers: b, originals: o, openPath: nxt };
      }),
    );
  }

  // After a rename, retarget every tab/buffer under the old path (handles
  // renamed directories containing open files) and every lane's pending diff.
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
    setLanes((ls) =>
      ls.map((l) =>
        l.pendingDiff && (l.pendingDiff.path === oldP || l.pendingDiff.path.startsWith(oldP + "/"))
          ? { ...l, pendingDiff: { ...l.pendingDiff, path: swap(l.pendingDiff.path) } }
          : l,
      ),
    );
  }

  // After a delete, drop any tabs under the deleted path and clear any
  // lane's pending diff that is now dangling.
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
    setLanes((ls) => ls.map((l) => (l.pendingDiff && under(l.pendingDiff.path) ? { ...l, pendingDiff: null } : l)));
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

