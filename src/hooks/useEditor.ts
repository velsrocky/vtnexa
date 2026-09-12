import { useEffect, useState } from "react";
import type { CenterTab, Lane } from "../types";
import { fsRead, fsWrite, gitCommit } from "../lib/tauri";
import { isHtmlPreview, isMarkdownPreview, markdownToHtmlSrcDoc, textToHtmlSrcDoc } from "../lib/preview";
import { baseName, isWithin } from "../lib/utils";

export interface AuditInput {
  tool: string;
  args: string;
  decision: "auto" | "approved" | "rejected";
  ok: boolean;
  ms: number;
  note?: string;
}

// Per-lane editor: tabs/buffers/openPath live on the lane so lanes are truly
// isolated workspaces. Owns open/close, rename/delete tab retargeting, the
// Diff review gate (stage/approve/drift-guard), live preview, and the
// shell/PTY stack heights.
export function useEditor(opts: {
  lane: Lane;
  setLanes: React.Dispatch<React.SetStateAction<Lane[]>>;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
  workspaceRoot: string;
  cwd: string;
  centerTab: CenterTab;
  setCenterTab: (t: CenterTab) => void;
  refreshFiles: (dir: string, laneId?: string) => Promise<void>;
  refreshGit: () => void;
  refreshSkills: () => void;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  logAudit: (laneId: string, e: AuditInput) => void;
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
  const [previewDoc, setPreviewDoc] = useState("");
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

  // Live preview doc: recompute when file text / tab changes
  useEffect(() => {
    if (opts.centerTab !== "preview") return;
    let cancelled = false;
    (async () => {
      if (!openPath) {
        if (!cancelled) setPreviewDoc(textToHtmlSrcDoc("(no file)", editorText));
        return;
      }
      if (isHtmlPreview(openPath)) {
        if (!cancelled) setPreviewDoc(editorText);
      } else if (isMarkdownPreview(openPath)) {
        const doc = await markdownToHtmlSrcDoc(editorText);
        if (!cancelled) setPreviewDoc(doc);
      } else {
        if (!cancelled) setPreviewDoc(textToHtmlSrcDoc(openPath, editorText));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opts.centerTab, editorText, openPath]);

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

  async function saveFile() {
    if (!openPath) return;
    if (lane.pendingDiff && lane.pendingDiff.path !== openPath) {
      updateLane(lane.id, (l) => ({
        ...l,
        shellOut: l.shellOut + `\n⚠ gate holds ${l.pendingDiff!.path} - staging ${openPath} replaces it`,
      }));
    }
    // review gate: stage as pending diff instead of direct write
    updateLane(lane.id, (l) => ({
      ...l,
      pendingDiff: { path: openPath, content: editorText, original: originalText },
    }));
  }

  function markApplied(path: string, content: string) {
    setOriginals((o) => ({ ...o, [path]: content }));
    setBuffers((b) => ({ ...b, [path]: content }));
    if (path === openPath) {
      setOriginalText(content);
      setEditorText(content);
    }
  }

  // Drift guard: the staged diff carries the on-disk original from staging
  // time. If the file changed since (another lane applied something, an
  // external editor touched it), Approve would silently clobber - ask first.
  async function driftOk(d: { path: string; original: string }): Promise<boolean> {
    let current = "";
    try {
      current = await fsRead(d.path);
    } catch {
      current = ""; // gone or unreadable - treat as new-file write
    }
    if (current === d.original) return true;
    return window.confirm(
      `${baseName(d.path)} changed on disk since this diff was staged (another lane, the agent, or an external editor).\n\nApply anyway and overwrite those changes?`,
    );
  }

  async function approveDiff() {
    const d = lane.pendingDiff;
    if (!d) return;
    if (!(await driftOk(d))) return;
    await fsWrite(d.path, d.content);
    markApplied(d.path, d.content);
    updateLane(lane.id, (l) => ({
      ...l,
      pendingDiff: null,
      shellOut: l.shellOut + `\n✓ applied ${d.path}`,
    }));
    opts.refreshFiles(opts.cwd);
    opts.refreshGit();
    opts.refreshSkills();
  }

  // Approve + immediately commit that file. User-initiated (the click IS the
  // approval), so no popup - but it is recorded in the lane audit trail.
  async function approveAndCommit() {
    const d = lane.pendingDiff;
    if (!d) return;
    if (!(await driftOk(d))) return;
    const laneId = lane.id;
    await fsWrite(d.path, d.content);
    markApplied(d.path, d.content);
    const msg = opts.commitMsg.trim() || `Update ${d.path.split("/").pop()}`;
    const t0 = Date.now();
    try {
      const r = await gitCommit(lane.cwd || opts.cwd, msg, [d.path]);
      updateLane(laneId, (l) => ({
        ...l,
        pendingDiff: null,
        shellOut: l.shellOut + `\n✓ applied + committed ${d.path} (${r.hash.slice(0, 7)})`,
      }));
      opts.logAudit(laneId, {
        tool: "git_commit",
        args: JSON.stringify({ files: [d.path], message: msg }).slice(0, 1000),
        decision: "approved",
        ok: true,
        ms: Date.now() - t0,
        note: "user-approved from Diff gate",
      });
    } catch (e) {
      updateLane(laneId, (l) => ({
        ...l,
        pendingDiff: null,
        shellOut: l.shellOut + `\n✓ applied ${d.path} (commit failed: ${e})`,
      }));
      opts.logAudit(laneId, {
        tool: "git_commit",
        args: JSON.stringify({ files: [d.path], message: msg }).slice(0, 1000),
        decision: "approved",
        ok: false,
        ms: Date.now() - t0,
        note: String(e).slice(0, 200),
      });
    }
    opts.setCommitMsg("");
    opts.refreshFiles(opts.cwd);
    opts.refreshGit();
    opts.refreshSkills();
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
    shellH,
    ptyH,
    setShellH,
    setPtyH,
    onHResizerDown,
    previewDoc,
    previewUrl,
    setPreviewUrl,
    openFile,
    closeTab,
    retargetTabs,
    dropTabsUnder,
    saveFile,
    approveDiff,
    approveAndCommit,
  };
}
