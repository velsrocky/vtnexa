// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLanes } from "./useLanes";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

afterEach(() => {
  setInvokeImpl(async () => ({}));
});

describe("useLanes basics", () => {
  it("starts with one lane and auto-selects it", () => {
    const { result } = renderHook(() => useLanes());
    expect(result.current.lanes).toHaveLength(1);
    expect(result.current.lanes[0].name).toBe("Lane 1");
    expect(result.current.activeId).toBe(result.current.lanes[0].id);
    expect(result.current.lane.id).toBe(result.current.activeId);
    expect(result.current.laneBusy).toBe(false);
  });

  it("addLane numbers sequentially and activates", () => {
    const { result } = renderHook(() => useLanes());
    act(() => {
      result.current.addLane("/w", "/w");
    });
    expect(result.current.lanes.map((l) => l.name)).toEqual(["Lane 1", "Lane 2"]);
    expect(result.current.activeId).toBe(result.current.lanes[1].id);
    expect(result.current.lanes[1].cwd).toBe("/w");
  });

  it("laneName falls back for unknown ids", () => {
    const { result } = renderHook(() => useLanes());
    expect(result.current.laneName("nope")).toBe("lane");
    expect(result.current.laneName(result.current.lanes[0].id)).toBe("Lane 1");
  });
});

describe("useLanes.closeLane", () => {
  it("refuses to close the last lane without touching the backend", async () => {
    let invoked = false;
    setInvokeImpl(async () => {
      invoked = true;
      return {};
    });
    const { result } = renderHook(() => useLanes());
    const id = result.current.lanes[0].id;
    await act(async () => {
      await result.current.closeLane(id, "/w");
    });
    expect(result.current.lanes).toHaveLength(1);
    expect(invoked).toBe(false);
  });

  it("kills the PTY, drops the lane and follows selection", async () => {
    const kills: any[] = [];
    setInvokeImpl(async (cmd, args) => {
      if (cmd === "pty_kill") kills.push(args);
      return {};
    });
    const { result } = renderHook(() => useLanes());
    act(() => {
      result.current.addLane("/w", "/w");
    });
    const [first, second] = result.current.lanes;
    expect(result.current.activeId).toBe(second.id);
    await act(async () => {
      await result.current.closeLane(first.id, "/w");
    });
    expect(kills).toEqual([{ id: first.id }]);
    expect(result.current.lanes.map((l) => l.id)).toEqual([second.id]);
    expect(result.current.activeId).toBe(second.id);
  });
});

describe("useLanes.stopTurn / flushStreamFrame", () => {
  it("aborts the in-flight turn", () => {
    const { result } = renderHook(() => useLanes());
    const ac = new AbortController();
    act(() => {
      result.current.turnAborts.current.set("lane1", ac);
    });
    act(() => {
      result.current.stopTurn("lane1");
    });
    expect(ac.signal.aborted).toBe(true);
    expect(result.current.turnAborts.current.has("lane1")).toBe(false);
  });

  it("releases a coalescing frame", () => {
    const { result } = renderHook(() => useLanes());
    act(() => {
      result.current.streamRafs.current.set("lane1", 999999);
    });
    act(() => {
      result.current.flushStreamFrame("lane1");
    });
    expect(result.current.streamRafs.current.has("lane1")).toBe(false);
  });
});

describe("useLanes approval queue", () => {
  it("resolveHead settles the head tool", () => {
    const { result } = renderHook(() => useLanes());
    const resolve = vi.fn();
    act(() => {
      result.current.setPendingTools([{ laneId: "l1", tool: "shell_run", args: { cmd: "ls" }, resolve }]);
    });
    act(() => {
      result.current.resolveHead(true);
    });
    expect(resolve).toHaveBeenCalledWith(true);
    expect(result.current.pendingTools).toHaveLength(0);
  });

  it("resolveHead on an empty queue is a no-op", () => {
    const { result } = renderHook(() => useLanes());
    expect(() => {
      act(() => {
        result.current.resolveHead(false);
      });
    }).not.toThrow();
  });
});

describe("useLanes audit + unseen", () => {
  it("logAudit appends and caps at 100", () => {
    const { result } = renderHook(() => useLanes());
    const id = result.current.lanes[0].id;
    act(() => {
      for (let i = 0; i < 105; i++) {
        result.current.logAudit(id, { tool: "fs_read", args: "{}", decision: "auto", ok: true, ms: 1 });
      }
    });
    const audit = result.current.lane.audit;
    expect(audit).toHaveLength(100);
    expect(audit[0].tool).toBe("fs_read");
    expect(audit[0].id).toBeTruthy();
  });

  it("activating a lane clears its review dot", () => {
    const { result } = renderHook(() => useLanes());
    act(() => {
      result.current.setUnseen({ abc: true });
    });
    expect(result.current.unseen).toEqual({ abc: true });
    act(() => {
      result.current.setActiveId("abc");
    });
    expect(result.current.unseen).toEqual({});
  });
});

describe("useLanes per-lane separation", () => {
  const PROVIDER = { baseUrl: "https://x.test", apiKey: "S", model: "m", kind: "auto" as const };

  it("addLane copies the given provider and isolates on demand", async () => {
    const added: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "git_worktree_add") {
        added.push(args);
        return { path: "/w/.nexa/worktrees/lane-2-ab12", branch: "vtnexa/lane-2-ab12" };
      }
      return {};
    });
    const { result } = renderHook(() => useLanes());
    let id = "";
    act(() => {
      id = result.current.addLane("/w", "/w", PROVIDER, { activate: false });
    });
    const created = result.current.lanes.find((l) => l.id === id);
    expect(created?.provider).toMatchObject({ baseUrl: "https://x.test", model: "m" });
    expect(created?.worktree).toBeFalsy();
    expect(result.current.activeId).not.toBe(id);

    await act(async () => {
      await result.current.isolateLane(id, "/w");
    });
    const isolated = result.current.lanes.find((l) => l.id === id);
    expect(added).toHaveLength(1);
    expect(isolated?.worktree).toEqual({ path: "/w/.nexa/worktrees/lane-2-ab12", branch: "vtnexa/lane-2-ab12" });
    expect(isolated?.cwd).toBe("/w/.nexa/worktrees/lane-2-ab12");
  });

  it("isolateLane degrades to shared workspace without git", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "git_worktree_add") throw new Error("not a git repo");
      return {};
    });
    const { result } = renderHook(() => useLanes());
    let id = "";
    act(() => {
      id = result.current.addLane("/w", "/w", PROVIDER, { activate: false });
    });
    await act(async () => {
      await result.current.isolateLane(id, "/w");
    });
    const lane = result.current.lanes.find((l) => l.id === id);
    expect(lane?.worktree).toBeFalsy();
    expect(lane?.shellOut).toMatch(/shares the workspace/);
  });

  it("closeLane removes the worktree so branches do not litter", async () => {
    const removed: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "git_worktree_add") return { path: "/w/.nexa/worktrees/x", branch: "vtnexa/x" };
      if (cmd === "git_worktree_remove") {
        removed.push(args);
        return {};
      }
      return {};
    });
    const { result } = renderHook(() => useLanes());
    let id = "";
    act(() => {
      id = result.current.addLane("/w", "/w", PROVIDER, { activate: false });
    });
    await act(async () => {
      await result.current.isolateLane(id, "/w");
    });
    await act(async () => {
      await result.current.closeLane(id, "/w");
    });
    expect(removed).toEqual([{ cwd: "/w", path: "/w/.nexa/worktrees/x" }]);
    expect(result.current.lanes.some((l) => l.id === id)).toBe(false);
  });
});
