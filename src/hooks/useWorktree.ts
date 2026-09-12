import type { AuditInput, Lane } from "../types";
import { gitMerge, gitWorktreeRemove } from "../lib/tauri";
import { ptyWrite } from "../lib/pty";

// Per-lane git worktrees (filesystem isolation for parallel agents).
// Worktrees live at <workspace>/.nexa/worktrees/<lane> - inside the sandbox
// root by construction, so every existing path guard still applies. Each
// lane checks out its own branch; merges become plain `git merge`.
export function useWorktree(opts: {
  lane: Lane;
  workspaceRoot: string;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
  setCwdState: (v: string) => void;
  refreshFiles: (dir: string, laneId?: string) => Promise<void>;
  refreshGit: () => void;
  logAudit: (laneId: string, e: AuditInput) => void;
}) {
  async function leaveWorktree() {
    const l = opts.lane;
    const { workspaceRoot, updateLane, setCwdState, refreshFiles } = opts;
    if (!l.worktree) return;
    if (
      !window.confirm(
        `Leave worktree ${l.worktree.branch}?\n\nUncommitted changes inside it are DISCARDED (committed work stays on the branch - merge it first if unsure).`,
      )
    )
      return;
    try {
      // Remove from the main checkout: git refuses to remove the worktree
      // you are currently standing in.
      await gitWorktreeRemove(workspaceRoot, l.worktree.path);
      updateLane(l.id, (x) => ({ ...x, worktree: null, cwd: workspaceRoot }));
      setCwdState(workspaceRoot);
      refreshFiles(workspaceRoot, l.id);
      ptyWrite(l.id, `cd '${workspaceRoot.replace(/'/g, "'\\''")}'\n`).catch(() => {});
    } catch (e) {
      updateLane(l.id, (x) => ({ ...x, shellOut: x.shellOut + `\nworktree remove failed: ${e}` }));
    }
  }

  async function mergeWorktree() {
    const { lane, workspaceRoot, updateLane, refreshGit, logAudit } = opts;
    const wt = lane.worktree;
    if (!wt) return;
    if (!window.confirm(`Merge ${wt.branch} into the main checkout at ${workspaceRoot}?\n\nOnly committed work merges - stage & commit in this lane first if needed.`))
      return;
    const t0 = Date.now();
    try {
      // No shell interpolation: backend validates vtnexa/<lane> and runs git merge directly.
      const r = await gitMerge(workspaceRoot, wt.branch);
      updateLane(lane.id, (l) => ({
        ...l,
        shellOut: l.shellOut + `\n$ git merge --no-edit ${wt.branch}\n${r.output}\n`,
      }));
      logAudit(lane.id, {
        tool: "git_merge",
        args: wt.branch,
        decision: "approved",
        ok: true,
        ms: Date.now() - t0,
      });
    } catch (e) {
      updateLane(lane.id, (l) => ({ ...l, shellOut: l.shellOut + `\nmerge failed: ${e}` }));
      logAudit(lane.id, {
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

  return { leaveWorktree, mergeWorktree };
}
