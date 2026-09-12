import type { AuditInput, Workspace } from "../types";
import { gitMerge, gitWorktreeAdd, gitWorktreeRemove } from "../lib/tauri";
import { ptyWrite } from "../lib/pty";

// Per-window git worktree: isolate this window into its own branch +
// checkout under <workspace>/.nexa/worktrees/<label> so parallel windows
// never edit the same files. Manual: isolate, merge to main, leave.
export function useWorktree(opts: {
  ws: Workspace;
  workspaceRoot: string;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  setCwdState: (v: string) => void;
  refreshFiles: (dir: string) => Promise<void>;
  refreshGit: () => void;
  logAudit: (e: AuditInput) => void;
  ptyId: string;
}) {
  async function isolateWorktree() {
    const { ws, workspaceRoot, updateWs, setCwdState, refreshFiles, ptyId } = opts;
    if (ws.worktree) return;
    try {
      const wt = await gitWorktreeAdd(
        ws.cwd || workspaceRoot,
        ws.id.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase(),
      );
      updateWs((w) => ({
        ...w,
        worktree: { path: wt.path, branch: wt.branch },
        cwd: wt.path,
        shellOut:
          w.shellOut +
          `\n✓ window isolated in worktree ${wt.path}\n  branch ${wt.branch} - merge later with "⇣ merge to main" or: git merge ${wt.branch}`,
      }));
      setCwdState(wt.path);
      refreshFiles(wt.path);
      ptyWrite(ptyId, `cd '${wt.path.replace(/'/g, "'\\''")}'\n`).catch(() => {});
    } catch (e) {
      updateWs((w) => ({
        ...w,
        shellOut:
          w.shellOut +
          `\nworktree add failed: ${e}\n(needs a git repo at the workspace root - init one in the Git tab first)`,
      }));
    }
  }

  async function leaveWorktree() {
    const { ws, workspaceRoot, updateWs, setCwdState, refreshFiles, ptyId } = opts;
    if (!ws.worktree) return;
    if (
      !window.confirm(
        `Leave worktree ${ws.worktree.branch}?\n\nUncommitted changes inside it are DISCARDED (committed work stays on the branch - merge it first if unsure).`,
      )
    )
      return;
    try {
      // Remove from the main checkout: git refuses to remove the worktree
      // you are currently standing in.
      await gitWorktreeRemove(workspaceRoot, ws.worktree.path);
      updateWs((w) => ({ ...w, worktree: null, cwd: workspaceRoot }));
      setCwdState(workspaceRoot);
      refreshFiles(workspaceRoot);
      ptyWrite(ptyId, `cd '${workspaceRoot.replace(/'/g, "'\\''")}'\n`).catch(() => {});
    } catch (e) {
      updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nworktree remove failed: ${e}` }));
    }
  }

  async function mergeWorktree() {
    const { ws, workspaceRoot, updateWs, refreshGit, logAudit } = opts;
    const wt = ws.worktree;
    if (!wt) return;
    if (
      !window.confirm(
        `Merge ${wt.branch} into the main checkout at ${workspaceRoot}?\n\nOnly committed work merges - stage & commit in this window first if needed.`,
      )
    )
      return;
    const t0 = Date.now();
    try {
      // No shell interpolation: backend validates vtnexa/<id> and runs git merge directly.
      const r = await gitMerge(workspaceRoot, wt.branch);
      updateWs((w) => ({
        ...w,
        shellOut: w.shellOut + `\n$ git merge --no-edit ${wt.branch}\n${r.output}\n`,
      }));
      logAudit({
        tool: "git_merge",
        args: wt.branch,
        decision: "approved",
        ok: true,
        ms: Date.now() - t0,
      });
    } catch (e) {
      updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nmerge failed: ${e}` }));
      logAudit({
        tool: "git_merge",
        args: wt.branch,
        decision: "approved",
        ok: false,
        ms: Date.now() - t0,
        note: String(e).slice(0, 200),
      });
    }
    refreshGit();
  }

  return { isolateWorktree, leaveWorktree, mergeWorktree };
}
