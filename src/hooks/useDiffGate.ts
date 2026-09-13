import type { AuditInput, Workspace } from "../types";
import { fsRead, fsWrite, gitCommit } from "../lib/tauri";
import { baseName } from "../lib/utils";

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
}) {
  const { ws, updateWs, openPath, editorText, originalText } = opts;
  const { setOriginals, setBuffers, setOriginalText, setEditorText } = opts;
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
  async function driftOk(d: { path: string; original: string }): Promise<boolean> {
    let current = "";
    try {
      current = await fsRead(d.path);
    } catch (e) {
      const msg = String(e);
      // File gone: safe to write (it's a new file). Permission/locked: warn.
      if (msg.includes("No such file or directory") || msg.includes("not exist")) {
        current = ""; // gone or new file
      } else {
        return window.confirm(
          `${baseName(d.path)} could not be read (${msg}) — likely locked or permission-denied. Apply anyway and overwrite?`,
        );
      }
    }
    if (current === d.original) return true;
    return window.confirm(
      `${baseName(d.path)} changed on disk since this diff was staged (another window, the agent, or an external editor).\n\nApply anyway and overwrite those changes?`,
    );
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

  async function approveDiff() {
    const d = ws.pendingDiff;
    if (!d) return;
    if (!(await driftOk(d))) return;
    await fsWrite(d.path, d.content);
    markApplied(d.path, d.content);
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
  // approval), so no popup - but it is recorded in this window's audit trail.
  async function approveAndCommit() {
    const d = ws.pendingDiff;
    if (!d) return;
    if (!(await driftOk(d))) return;
    
    await fsWrite(d.path, d.content);
    markApplied(d.path, d.content);
    const verified = await verifyApplied(d.path, d.content);
    if (!verified) noteVerifyFailure(d.path);
    const msg = opts.commitMsg.trim() || `Update ${d.path.split("/").pop()}`;
    const t0 = Date.now();
    try {
      const r = await gitCommit(ws.cwd || opts.cwd, msg, [d.path]);
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
  return { saveFile, approveDiff, approveAndCommit };
}

