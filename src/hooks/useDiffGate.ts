import { useState } from "react";
import type { AuditInput, UndoEntry, Workspace } from "../types";
import { undoEntryLabel } from "../types";
import { fsDelete, fsRead, fsRename, fsWrite, gitCommit } from "../lib/tauri";
import { claimFor } from "../lib/approval";
import { baseName } from "../lib/utils";

// Undo boundaries (v1): approved Diff-gate writes + file renames/deletes.
// Shell/terminal side effects, directory deletes and binaries are NOT
// captured - undo says so when there is nothing (or nothing applicable).
const MAX_UNDO_ENTRIES = 20;
const MAX_UNDO_BYTES = 256 * 1024;

function entrySize(e: UndoEntry): number {
  switch (e.kind) {
    case "write":
      return e.before.length + e.after.length;
    case "delete":
      return e.content.length;
    case "rename":
      return 0;
  }
}

// Diff review gate: stage user edits as a pending diff (never direct
// writes), approve with drift guard, optionally commit. Composes on the
// tab/buffer state owned by useEditorTabs.
export function useDiffGate(opts: {
  ws: Workspace;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  workspaceRoot: string;
  cwd: string;
  openPath: string;
  editorText: string;
  originalText: string;
  setOriginals: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setBuffers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setOriginalText: (v: string) => void;
  setEditorText: (v: string) => void;
  refreshFiles: (dir: string) => Promise<void>;
  refreshGit: () => void;
  refreshSkills: () => void;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  logAudit: (e: AuditInput) => void;
  retargetTabs: (oldP: string, newP: string) => void;
  closeTab: (path: string) => void;
}) {
  const { ws, updateWs, openPath, editorText, originalText } = opts;
  const { setOriginals, setBuffers, setOriginalText, setEditorText } = opts;
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);

  function note(text: string) {
    updateWs((w) => ({ ...w, shellOut: w.shellOut + text }));
  }

  /** External capture (agent rename/delete via runTool, tree ops). */
  function pushUndo(e: UndoEntry) {
    if (entrySize(e) > MAX_UNDO_BYTES) {
      note(`\n↩ undo skipped ${undoEntryLabel(e)} (over 256KB - too large to snapshot)`);
      return;
    }
    setUndoStack((prev) => [...prev.slice(-(MAX_UNDO_ENTRIES - 1)), e]);
    setRedoStack([]);
  }
  async function saveFile() {
    if (!openPath) return;
    if (ws.pendingDiff && ws.pendingDiff.path !== openPath) {
      updateWs((w) => ({
        ...w,
        shellOut: w.shellOut + `\n⚠ gate holds ${w.pendingDiff!.path} - staging ${openPath} replaces it`,
      }));
    }
    // review gate: stage as pending diff instead of direct write
    updateWs((w) => ({
      ...w,
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
  // time. If the file changed since (another window applied something, an
  // external editor touched it), Approve would silently clobber - ask first.
  // Returns the pre-apply state too: undo restores what was REALLY there,
  // not the staging-time copy.
  async function driftRead(d: {
    path: string;
    original: string;
  }): Promise<{ proceed: boolean; current: string; existed: boolean }> {
    let current = "";
    let existed = true;
    try {
      current = await fsRead(d.path);
    } catch (e) {
      const msg = String(e);
      // File gone: safe to write (it's a new file). Permission/locked: warn.
      if (msg.includes("No such file or directory") || msg.includes("not exist")) {
        return { proceed: true, current: "", existed: false };
      }
      const ok = window.confirm(
        `${baseName(d.path)} could not be read (${msg}) — likely locked or permission-denied. Apply anyway and overwrite?`,
      );
      // Blind overwrite: best-effort undo seed (may be empty).
      return { proceed: ok, current: d.original, existed: d.original !== "" || existed };
    }
    if (current === d.original) return { proceed: true, current, existed: true };
    const ok = window.confirm(
      `${baseName(d.path)} changed on disk since this diff was staged (another window, the agent, or an external editor).\n\nApply anyway and overwrite those changes?`,
    );
    return { proceed: ok, current, existed: true };
  }

  // Verify pass: re-read after writing. A mismatch means the write didn't
  // stick or something rewrote the file in between - report it loudly
  // instead of claiming success.
  async function verifyApplied(path: string, expected: string): Promise<boolean> {
    try {
      return (await fsRead(path)) === expected;
    } catch {
      return false;
    }
  }

  function noteVerifyFailure(path: string) {
    updateWs((w) => ({
      ...w,
      shellOut: w.shellOut + `\n⚠ verify: ${path} differs on disk right after apply - re-read the file before trusting it`,
    }));
    opts.logAudit({
      tool: "fs_write",
      args: JSON.stringify({ path }).slice(0, 1000),
      decision: "approved",
      ok: false,
      ms: 0,
      note: "verify mismatch after apply",
    });
  }

  function noteApplyFailure(action: string, path: string, err: unknown, diag?: string) {
    const msg = String(err instanceof Error ? err.message : err);
    updateWs((w) => ({
      ...w,
      // Pending diff is KEPT so the user can retry after fixing the cause
      // (workspace root, stale window, backend error).
      shellOut: w.shellOut + `\n✗ ${action} failed for ${path}: ${msg.slice(0, 300)}${diag ? ` [${diag}]` : ""}`,
    }));
    opts.logAudit({
      tool: "fs_write",
      args: JSON.stringify({ path }).slice(0, 1000),
      decision: "approved",
      ok: false,
      ms: 0,
      note: `${action} failed: ${msg.slice(0, 200)}${diag ? ` [${diag}]` : ""}`,
    });
  }

  // Lengths only, never secret content: proves whether the token the claim
  // minted is the token the write sent.
  function approvalDiag(a: { token: string; detail: string } | undefined): string {
    return `frontend token_len=${a?.token?.length ?? -1} detail_len=${a?.detail?.length ?? -1}`;
  }

  async function approveDiff() {
    const d = ws.pendingDiff;
    if (!d) return;
    const drift = await driftRead(d);
    if (!drift.proceed) return;
    // The Approve click is the review; the claim token binds this exact path
    // backend-side so a compromised renderer cannot redirect the write.
    // Claim and write are diagnosed separately: an empty/missing token at the
    // write means the claim produced nothing (stale window, backend mismatch).
    let approval;
    try {
      approval = await claimFor("fs_write", { path: d.path });
    } catch (e) {
      noteApplyFailure("approve claim", d.path, e);
      return;
    }
    if (!approval?.token) {
      noteApplyFailure("approve claim", d.path, "claim returned no token (stale window? restart the app)");
      return;
    }
    try {
      await fsWrite(d.path, d.content, approval);
    } catch (e) {
      noteApplyFailure("approve write", d.path, e, approvalDiag(approval));
      return;
    }
    markApplied(d.path, d.content);
    pushUndo({ kind: "write", path: d.path, before: drift.current, after: d.content, existedBefore: drift.existed });
    const verified = await verifyApplied(d.path, d.content);
    updateWs((w) => ({
      ...w,
      pendingDiff: null,
      shellOut: w.shellOut + `\n✓ applied ${d.path}${verified ? "" : " (unverified - see warning)"}`,
    }));
    if (!verified) noteVerifyFailure(d.path);
    opts.refreshFiles(opts.cwd);
    opts.refreshGit();
    opts.refreshSkills();
  }

  // Approve + immediately commit that file. User-initiated (the click IS the
  // approval), so no extra dialog - but it is recorded in this window's audit trail.
  async function approveAndCommit() {
    const d = ws.pendingDiff;
    if (!d) return;
    const drift = await driftRead(d);
    if (!drift.proceed) return;

    let approval;
    try {
      approval = await claimFor("fs_write", { path: d.path });
    } catch (e) {
      noteApplyFailure("approve+commit claim", d.path, e);
      return;
    }
    if (!approval?.token) {
      noteApplyFailure("approve+commit claim", d.path, "claim returned no token (stale window? restart the app)");
      return;
    }
    try {
      await fsWrite(d.path, d.content, approval);
    } catch (e) {
      noteApplyFailure("approve+commit write", d.path, e, approvalDiag(approval));
      return;
    }
    markApplied(d.path, d.content);
    pushUndo({ kind: "write", path: d.path, before: drift.current, after: d.content, existedBefore: drift.existed });
    const verified = await verifyApplied(d.path, d.content);
    if (!verified) noteVerifyFailure(d.path);
    const msg = opts.commitMsg.trim() || `Update ${d.path.split("/").pop()}`;
    const t0 = Date.now();
    try {
      const r = await gitCommit(
        ws.cwd || opts.cwd,
        msg,
        [d.path],
        await claimFor("git_commit", { cwd: ws.cwd || opts.cwd, message: msg, files: [d.path] }),
      );
      updateWs((w) => ({
        ...w,
        pendingDiff: null,
        shellOut: w.shellOut + `\n✓ applied + committed ${d.path} (${r.hash.slice(0, 7)})`,
      }));
      opts.logAudit({
        tool: "git_commit",
        args: JSON.stringify({ files: [d.path], message: msg }).slice(0, 1000),
        decision: "approved",
        ok: true,
        ms: Date.now() - t0,
        note: "user-approved from Diff gate",
      });
    } catch (e) {
      updateWs((w) => ({
        ...w,
        pendingDiff: null,
        shellOut: w.shellOut + `\n✓ applied ${d.path} (commit failed: ${e})`,
      }));
      opts.logAudit({
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
  function auditUndoRedo(tool: "undo" | "redo", label: string, ok: boolean, ms: number, extraNote?: string) {
    opts.logAudit({
      tool,
      args: JSON.stringify({ label }).slice(0, 1000),
      decision: "approved",
      ok,
      ms,
      ...(extraNote ? { note: extraNote } : {}),
    });
  }

  // Apply one entry forward (redo) or backward (undo). Buffer state follows
  // the disk so open tabs never show stale content.
  async function applyEntry(e: UndoEntry, dir: "undo" | "redo"): Promise<void> {
    switch (e.kind) {
      case "write": {
        const content = dir === "undo" ? e.before : e.after;
        if (dir === "undo" && !e.existedBefore) {
          await fsDelete(e.path, false, await claimFor("fs_delete", { path: e.path }));
          setOriginals((o) => {
            const next = { ...o };
            delete next[e.path];
            return next;
          });
          setBuffers((b) => {
            const next = { ...b };
            delete next[e.path];
            return next;
          });
          if (e.path === openPath) {
            setOriginalText("");
            setEditorText("");
          }
          opts.closeTab(e.path);
        } else {
          await fsWrite(e.path, content, await claimFor("fs_write", { path: e.path }));
          markApplied(e.path, content);
        }
        break;
      }
      case "rename": {
        const from = dir === "undo" ? e.newPath : e.oldPath;
        const to = dir === "undo" ? e.oldPath : e.newPath;
        await fsRename(from, to, await claimFor("fs_rename", { old_path: from, new_path: to }));
        opts.retargetTabs(from, to);
        break;
      }
      case "delete": {
        if (dir === "undo") {
          await fsWrite(e.path, e.content, await claimFor("fs_write", { path: e.path }));
          markApplied(e.path, e.content);
        } else {
          await fsDelete(e.path, false, await claimFor("fs_delete", { path: e.path }));
          if (e.path === openPath) {
            setOriginalText("");
            setEditorText("");
          }
          opts.closeTab(e.path);
        }
        break;
      }
    }
  }

  async function undo() {
    const e = undoStack[undoStack.length - 1];
    if (!e) {
      note("\nnothing to undo (writes, renames and file deletes are captured; shell/terminal/directory ops are not)");
      return;
    }
    const label = undoEntryLabel(e);
    const t0 = Date.now();
    try {
      await applyEntry(e, "undo");
      setUndoStack((prev) => prev.slice(0, -1));
      setRedoStack((prev) => [...prev.slice(-(MAX_UNDO_ENTRIES - 1)), e]);
      note(`\n↩ undid ${label}`);
      auditUndoRedo("undo", label, true, Date.now() - t0);
    } catch (err) {
      note(`\n↩ undo failed for ${label}: ${err}`);
      auditUndoRedo("undo", label, false, Date.now() - t0, String(err).slice(0, 200));
    }
    opts.refreshFiles(opts.cwd);
    opts.refreshGit();
  }

  async function redo() {
    const e = redoStack[redoStack.length - 1];
    if (!e) {
      note("\nnothing to redo");
      return;
    }
    const label = undoEntryLabel(e);
    const t0 = Date.now();
    try {
      await applyEntry(e, "redo");
      setRedoStack((prev) => prev.slice(0, -1));
      setUndoStack((prev) => [...prev.slice(-(MAX_UNDO_ENTRIES - 1)), e]);
      note(`\n↪ redid ${label}`);
      auditUndoRedo("redo", label, true, Date.now() - t0);
    } catch (err) {
      note(`\n↪ redo failed for ${label}: ${err}`);
      auditUndoRedo("redo", label, false, Date.now() - t0, String(err).slice(0, 200));
    }
    opts.refreshFiles(opts.cwd);
    opts.refreshGit();
  }

  return {
    saveFile,
    approveDiff,
    approveAndCommit,
    pushUndo,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.length ? undoEntryLabel(undoStack[undoStack.length - 1]) : "",
  };
}

