// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLaneFollow, useWorkspace } from "./useWorkspace";
import { newLane } from "../lib/utils";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

afterEach(() => {
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup() {
  const updates: { id: string; fn: (l: any) => any }[] = [];
  const hook = renderHook(() =>
    useWorkspace({ laneId: "lane1", updateLane: (id, fn) => updates.push({ id, fn }) }),
  );
  return { ...hook, updates };
}

describe("useWorkspace.refreshFiles", () => {
  it("lists entries into the tree", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("fs_list");
      return [{ name: "a.txt", path: "/w/a.txt", is_dir: false }];
    });
    const { result } = setup();
    await act(async () => {
      await result.current.refreshFiles("/w", "lane1");
    });
    expect(result.current.files).toEqual([{ name: "a.txt", path: "/w/a.txt", is_dir: false }]);
  });

  it("clears the tree and logs fs errors to the lane", async () => {
    setInvokeImpl(async () => {
      throw new Error("denied");
    });
    const { result, updates } = setup();
    await act(async () => {
      await result.current.refreshFiles("/w", "lane1");
    });
    expect(result.current.files).toEqual([]);
    expect(updates).toHaveLength(1);
    const lane = updates[0].fn(newLane("L", "/w"));
    expect(lane.shellOut).toMatch(/fs error/);
  });

  it("ignores empty dirs without touching the backend", async () => {
    let called = false;
    setInvokeImpl(async () => {
      called = true;
      return [];
    });
    const { result } = setup();
    await act(async () => {
      await result.current.refreshFiles("");
    });
    expect(called).toBe(false);
  });
});

describe("per-lane folder memory", () => {
  function twoLanes() {
    let store = [
      { ...newLane("Lane 1", "/w"), id: "lane1" },
      { ...newLane("Lane 2", "/w"), id: "lane2" },
    ];
    const updateLane = (id: string, fn: (l: any) => any) => {
      store = store.map((l) => (l.id === id ? fn(l) : l));
    };
    const hook = renderHook(
      (props: { activeId: string; laneId: string; laneCwd: string }) => {
        const ws = useWorkspace({ laneId: props.laneId, updateLane });
        useLaneFollow({
          activeId: props.activeId,
          laneId: props.laneId,
          laneCwd: props.laneCwd,
          cwd: ws.cwd,
          workspaceRoot: ws.workspaceRoot,
          setCwdState: ws.setCwdState,
        });
        return ws;
      },
      { initialProps: { activeId: "lane1", laneId: "lane1", laneCwd: "/w" } },
    );
    const cwdOf = (id: string) => store.find((l) => l.id === id)?.cwd;
    return { ...hook, cwdOf, store: () => store };
  }

  it("selecting a folder touches only the active lane", () => {
    setInvokeImpl(async () => ({}));
    const h = twoLanes();
    act(() => {
      h.result.current.setWorkspaceRoot("/w");
    });
    act(() => {
      h.result.current.setCwd("/w/src");
    });
    expect(h.cwdOf("lane1")).toBe("/w/src");
    expect(h.cwdOf("lane2")).toBe("/w");
    expect(h.result.current.cwd).toBe("/w/src");
  });

  it("switching lanes restores each lane's own folder", () => {
    setInvokeImpl(async () => ({}));
    const h = twoLanes();
    act(() => {
      h.result.current.setWorkspaceRoot("/w");
    });
    // Lane 1 selects src.
    act(() => {
      h.result.current.setCwd("/w/src");
    });
    expect(h.cwdOf("lane1")).toBe("/w/src");

    // Switch to lane 2: tree follows lane 2's folder.
    h.rerender({ activeId: "lane2", laneId: "lane2", laneCwd: "/w" });
    expect(h.result.current.cwd).toBe("/w");

    // Lane 2 selects tests; lane 1 must be untouched.
    act(() => {
      h.result.current.setCwd("/w/tests");
    });
    expect(h.cwdOf("lane2")).toBe("/w/tests");
    expect(h.cwdOf("lane1")).toBe("/w/src");

    // Switch back: lane 1's folder restored, lane 2 intact.
    h.rerender({ activeId: "lane1", laneId: "lane1", laneCwd: "/w/src" });
    expect(h.result.current.cwd).toBe("/w/src");
    expect(h.cwdOf("lane1")).toBe("/w/src");
    expect(h.cwdOf("lane2")).toBe("/w/tests");
  });
});
describe("useWorkspace.setCwd", () => {
  it("blocks navigation outside the workspace", () => {
    setInvokeImpl(async () => []);
    const { result, updates } = setup();
    act(() => {
      result.current.setWorkspaceRoot("/w");
    });
    act(() => {
      result.current.setCwd("/etc");
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("lane1");
    const lane = updates[0].fn(newLane("L", "/w"));
    expect(lane.shellOut).toMatch(/outside workspace/);
    expect(lane.cwd).toBe("/w");
  });

  it("accepts inside paths (lane + PTY follow)", () => {
    setInvokeImpl(async () => []);
    const { result, updates } = setup();
    act(() => {
      result.current.setWorkspaceRoot("/w");
    });
    act(() => {
      result.current.setCwd("/w/sub");
    });
    expect(result.current.cwd).toBe("/w/sub");
    const lane = updates[0].fn(newLane("L", "/w"));
    expect(lane.cwd).toBe("/w/sub");
  });
});
