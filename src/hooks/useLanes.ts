import { useEffect, useRef, useState } from "react";
import { type Lane, type ProviderConfig } from "../types";
import { newLane, uid } from "../lib/utils";
import { ptyKill } from "../lib/pty";
import { gitWorktreeAdd, gitWorktreeRemove } from "../lib/tauri";
import { loadLastUsed } from "./useProvider";
import type { PendingTool } from "../components/ApprovalModal";

const AUDIT_MAX = 100;

export interface AuditInput {
  tool: string;
  args: string;
  decision: "auto" | "approved" | "rejected";
  ok: boolean;
  ms: number;
  note?: string;
}

// Lanes: each lane is its own app instance - own provider copy, own
// worktree, own UI. Owns lane list + selection, per-lane busy/unseen
// flags, in-flight abort controllers, stream-coalescing frames, the
// approval queue, and all lane-patching helpers.
export function useLanes() {
  const [lanes, setLanes] = useState<Lane[]>(() => [newLane("Lane 1", "", loadLastUsed())]);
  const [activeId, setActiveId] = useState<string>("");
  // Per-lane busy: lanes run concurrently (background agents).
  const [busyLanes, setBusyLanes] = useState<Record<string, boolean>>({});
  // In-flight agent turns per lane - the Stop button aborts the fetch/loop.
  const turnAborts = useRef(new Map<string, AbortController>());
  // Lanes that finished while in the background - review-later dot.
  const [unseen, setUnseen] = useState<Record<string, boolean>>({});
  // One coalescing frame per lane - a shared slot would drop a background
  // lane's live updates (or cancel them when another lane finishes).
  const streamRafs = useRef(new Map<string, number>());
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // Approval queue (tagged by lane): concurrent lanes may ask at once; the
  // modal shows the head, the rest wait in order.
  const [pendingTools, setPendingTools] = useState<PendingTool[]>([]);

  const lane = lanes.find((l) => l.id === activeId) ?? lanes[0];
  const laneBusy = !!busyLanes[lane.id];

  function updateLane(id: string, fn: (l: Lane) => Lane) {
    setLanes((ls) => ls.map((l) => (l.id === id ? fn(l) : l)));
  }

  function setLaneBusy(id: string, v: boolean) {
    setBusyLanes((m) => ({ ...m, [id]: v }));
  }

  function logAudit(laneId: string, e: AuditInput) {
    updateLane(laneId, (l) => ({
      ...l,
      audit: [...l.audit, { ...e, id: uid(), ts: Date.now() }].slice(-AUDIT_MAX),
    }));
  }

  // Stop a running turn: abort the provider request and release any approval
  // popup the lane is waiting on. Side effects that already ran are not undone.
  function stopTurn(id: string) {
    turnAborts.current.get(id)?.abort();
    turnAborts.current.delete(id);
    setPendingTools((q) => {
      for (const p of q) if (p.laneId === id) p.resolve(false);
      return q.filter((p) => p.laneId !== id);
    });
  }

  function flushStreamFrame(laneId: string) {
    const raf = streamRafs.current.get(laneId);
    if (raf != null) {
      cancelAnimationFrame(raf);
      streamRafs.current.delete(laneId);
    }
  }

  function laneName(id: string): string {
    return lanes.find((l) => l.id === id)?.name ?? "lane";
  }

  function resolveHead(ok: boolean) {
    const [head, ...rest] = pendingTools;
    if (!head) return;
    head.resolve(ok);
    setPendingTools(rest);
  }

  function addLane(
    workspaceRoot: string,
    cwd: string,
    provider: ProviderConfig = loadLastUsed(),
    opts?: { name?: string; activate?: boolean },
  ): string {
    const name =
      opts?.name ??
      (() => {
        const nextNum =
          Math.max(0, ...lanes.map((l) => Number.parseInt(l.name.replace(/^Lane\s+/, ""), 10) || 0)) + 1;
        return `Lane ${nextNum}`;
      })();
    const l = newLane(name, workspaceRoot || cwd, provider);
    setLanes((ls) => [...ls, l]);
    if (opts?.activate !== false) setActiveId(l.id);
    return l.id;
  }

  // Isolate a lane in its own git worktree + branch so parallel lanes never
  // edit the same files. Best-effort: without a git repo the lane simply
  // shares the workspace (with a note explaining why).
  async function isolateLane(id: string, workspaceRoot: string): Promise<void> {
    const target = lanes.find((l) => l.id === id);
    if (!target || target.worktree) return;
    try {
      const wt = await gitWorktreeAdd(
        target.cwd || workspaceRoot,
        `${target.name}-${target.id.slice(0, 4)}`,
      );
      updateLane(id, (x) => ({
        ...x,
        worktree: { path: wt.path, branch: wt.branch },
        cwd: wt.path,
        shellOut:
          x.shellOut +
          `\n✓ lane isolated in worktree ${wt.path}\n  branch ${wt.branch} - merge later with "⇣ merge to main" or: git merge ${wt.branch}`,
      }));
    } catch (e) {
      updateLane(id, (x) => ({
        ...x,
        shellOut:
          x.shellOut +
          `\nlane shares the workspace (automatic isolation needs a git repo - init one in the Git tab, new lanes isolate themselves)`,
      }));
    }
  }

  async function closeLane(id: string, workspaceRoot: string) {
    if (lanes.length <= 1) return;
    const idx = lanes.findIndex((l) => l.id === id);
    const doomed = lanes[idx];
    try {
      await ptyKill(id);
    } catch {
      /* ignore */
    }
    // Remove the lane's worktree so closed lanes don't litter branches.
    // Best-effort: the branch keeps committed work regardless. Runs from
    // the main checkout - git refuses removals from inside the worktree.
    if (doomed?.worktree) {
      try {
        await gitWorktreeRemove(workspaceRoot, doomed.worktree.path);
      } catch {
        /* already gone */
      }
    }
    turnAborts.current.get(id)?.abort();
    turnAborts.current.delete(id);
    flushStreamFrame(id);
    streamRafs.current.delete(id);
    // Release approvals waiting on this lane so its agent stops
    // instead of hanging forever.
    setPendingTools((q) => {
      for (const p of q) if (p.laneId === id) p.resolve(false);
      return q.filter((p) => p.laneId !== id);
    });
    setLaneBusy(id, false);
    setUnseen((u) => {
      if (!u[id]) return u;
      const n = { ...u };
      delete n[id];
      return n;
    });
    const rest = lanes.filter((l) => l.id !== id);
    setLanes(rest);
    // Stay on current lane if we closed a background lane.
    if (id === activeIdRef.current) {
      const nextIdx = Math.min(Math.max(0, idx), rest.length - 1);
      setActiveId(rest[nextIdx]?.id ?? rest[0].id);
    }
  }

  // Default selection once lanes exist.
  useEffect(() => {
    if (!activeId && lanes.length) setActiveId(lanes[0].id);
  }, [lanes, activeId]);

  // Activating a lane clears its review-later dot.
  useEffect(() => {
    setUnseen((u) => {
      if (!u[activeId]) return u;
      const n = { ...u };
      delete n[activeId];
      return n;
    });
  }, [activeId]);

  return {
    lanes,
    setLanes,
    activeId,
    setActiveId,
    activeIdRef,
    lane,
    laneBusy,
    busyLanes,
    setLaneBusy,
    unseen,
    setUnseen,
    turnAborts,
    streamRafs,
    pendingTools,
    setPendingTools,
    resolveHead,
    updateLane,
    logAudit,
    stopTurn,
    flushStreamFrame,
    laneName,
    addLane,
    isolateLane,
    closeLane,
  };
}
