// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEditorTabs } from "./useEditorTabs";
import { newLane } from "../lib/utils";
import type { Lane } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

const realConfirm = (window as any).confirm;

afterEach(() => {
  (window as any).confirm = realConfirm;
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup(initialLane?: Lane) {
  let store: Lane[] = [initialLane ?? newLane("L", "/w")];
  const setLanes: any = (u: any) => {
    store = typeof u === "function" ? u(store) : u;
  };
  const calls = {
    centerTab: [] as string[],
  };
  const hook = renderHook(() =>
    useEditorTabs({
      lane: store[0],
      setLanes,
      updateLane: (id, fn) => setLanes((ls: Lane[]) => ls.map((l) => (l.id === id ? fn(l) : l))),
      workspaceRoot: "/w",
      setCenterTab: (t) => calls.centerTab.push(t),
    }),
  );
  const lane = () => store[0];
  const refresh = () => hook.rerender();
  return { ...hook, calls, lane, refresh, store: () => store };
}
function laneWith(over: Partial<Lane>): Lane {
  return { ...newLane("L", "/w"), id: "lane1", ...over };
}
describe("useEditorTabs.openFile", () => {
  it("loads text into a new tab and activates it", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("fs_read");
      return "file text";
    });
    const h = setup();
    await act(async () => {
      await h.result.current.openFile("/w/a.txt");
    });
    expect(h.lane().tabs).toEqual(["/w/a.txt"]);
    expect(h.lane().buffers["/w/a.txt"]).toBe("file text");
    expect(h.lane().openPath).toBe("/w/a.txt");
    expect(h.calls.centerTab).toEqual(["edit"]);
  });

  it("blocks paths outside the workspace without reading", async () => {
    let reads = 0;
    setInvokeImpl(async () => {
      reads++;
      return "";
    });
    const h = setup();
    await act(async () => {
      await h.result.current.openFile("/etc/passwd");
    });
    expect(reads).toBe(0);
    expect(h.lane().tabs).toEqual([]);
    expect(h.lane().shellOut).toMatch(/outside workspace/);
  });

  it("activates already-open files without re-reading", async () => {
    let reads = 0;
    setInvokeImpl(async () => {
      reads++;
      return "x";
    });
    const h = setup(
      laneWith({ tabs: ["/w/a.txt"], buffers: { "/w/a.txt": "buf" }, originals: { "/w/a.txt": "orig" } }),
    );
    await act(async () => {
      await h.result.current.openFile("/w/a.txt");
    });
    expect(reads).toBe(0);
    expect(h.lane().openPath).toBe("/w/a.txt");
  });
});
describe("useEditorTabs.closeTab", () => {
  it("drops clean tabs and follows neighbors", () => {
    setInvokeImpl(async () => "");
    const h = setup(
      laneWith({
        tabs: ["/w/a.txt", "/w/b.txt"],
        buffers: { "/w/a.txt": "x", "/w/b.txt": "y" },
        originals: { "/w/a.txt": "x", "/w/b.txt": "y" },
        openPath: "/w/a.txt",
      }),
    );
    act(() => {
      h.result.current.closeTab("/w/a.txt");
    });
    expect(h.lane().tabs).toEqual(["/w/b.txt"]);
    expect(h.lane().openPath).toBe("/w/b.txt");
    expect(h.lane().buffers["/w/a.txt"]).toBeUndefined();
  });

  it("asks before discarding dirty tabs", () => {
    setInvokeImpl(async () => "");
    (window as any).confirm = vi.fn(() => false);
    const dirty = laneWith({
      tabs: ["/w/a.txt"],
      buffers: { "/w/a.txt": "edited" },
      originals: { "/w/a.txt": "orig" },
      openPath: "/w/a.txt",
    });
    const h = setup(dirty);
    act(() => {
      h.result.current.closeTab("/w/a.txt");
    });
    expect(h.lane().tabs).toEqual(["/w/a.txt"]);

    (window as any).confirm = vi.fn(() => true);
    act(() => {
      h.result.current.closeTab("/w/a.txt");
    });
    expect(h.lane().tabs).toEqual([]);
  });
});
describe("useEditorTabs retargeting", () => {
  it("retargetTabs follows renames incl. pending diffs", () => {
    setInvokeImpl(async () => "");
    const h = setup(
      laneWith({
        tabs: ["/w/dir/a.txt"],
        buffers: { "/w/dir/a.txt": "b" },
        originals: { "/w/dir/a.txt": "b" },
        openPath: "/w/dir/a.txt",
        pendingDiff: { path: "/w/dir/a.txt", content: "c", original: "b" },
      }),
    );
    act(() => {
      h.result.current.retargetTabs("/w/dir", "/w/renamed");
    });
    expect(h.lane().tabs).toEqual(["/w/renamed/a.txt"]);
    expect(h.lane().buffers["/w/renamed/a.txt"]).toBe("b");
    expect(h.lane().openPath).toBe("/w/renamed/a.txt");
    expect(h.lane().pendingDiff?.path).toBe("/w/renamed/a.txt");
  });

  it("dropTabsUnder clears tabs and dangling diffs", () => {
    setInvokeImpl(async () => "");
    const h = setup(
      laneWith({
        tabs: ["/w/dir/a.txt", "/w/keep.txt"],
        buffers: { "/w/dir/a.txt": "x", "/w/keep.txt": "y" },
        originals: { "/w/dir/a.txt": "x", "/w/keep.txt": "y" },
        openPath: "/w/dir/a.txt",
        pendingDiff: { path: "/w/dir/a.txt", content: "z", original: "x" },
      }),
    );
    act(() => {
      h.result.current.dropTabsUnder("/w/dir");
    });
    expect(h.lane().tabs).toEqual(["/w/keep.txt"]);
    expect(h.lane().pendingDiff).toBeNull();
  });
});
