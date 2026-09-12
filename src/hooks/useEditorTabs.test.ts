// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEditorTabs } from "./useEditorTabs";
import { newWorkspace } from "../lib/utils";
import type { CenterTab, Workspace } from "../types";

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

function setup(initial?: Partial<Workspace>) {
  let ws: Workspace = { ...newWorkspace("main:ws", "/w"), id: "main:ws", ...initial };
  const setWs: any = (u: any) => {
    ws = typeof u === "function" ? u(ws) : u;
  };
  const calls = { centerTab: [] as CenterTab[] };
  const hook = renderHook(() =>
    useEditorTabs({
      ws,
      setWs,
      updateWs: (fn) => {
        ws = fn(ws);
      },
      workspaceRoot: "/w",
      setCenterTab: (t) => calls.centerTab.push(t),
    }),
  );
  return { ...hook, calls, wsOf: () => ws };
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
    expect(h.wsOf().tabs).toEqual(["/w/a.txt"]);
    expect(h.wsOf().buffers["/w/a.txt"]).toBe("file text");
    expect(h.wsOf().openPath).toBe("/w/a.txt");
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
    expect(h.wsOf().shellOut).toMatch(/outside workspace/);
  });

  it("activates already-open files without re-reading", async () => {
    let reads = 0;
    setInvokeImpl(async () => {
      reads++;
      return "x";
    });
    const h = setup({
      tabs: ["/w/a.txt"],
      buffers: { "/w/a.txt": "buf" },
      originals: { "/w/a.txt": "orig" },
    });
    await act(async () => {
      await h.result.current.openFile("/w/a.txt");
    });
    expect(reads).toBe(0);
    expect(h.wsOf().openPath).toBe("/w/a.txt");
  });
});

describe("useEditorTabs.closeTab", () => {
  it("drops clean tabs and follows neighbors", () => {
    setInvokeImpl(async () => "");
    const h = setup({
      tabs: ["/w/a.txt", "/w/b.txt"],
      buffers: { "/w/a.txt": "x", "/w/b.txt": "y" },
      originals: { "/w/a.txt": "x", "/w/b.txt": "y" },
      openPath: "/w/a.txt",
    });
    act(() => {
      h.result.current.closeTab("/w/a.txt");
    });
    expect(h.wsOf().tabs).toEqual(["/w/b.txt"]);
    expect(h.wsOf().openPath).toBe("/w/b.txt");
  });

  it("asks before discarding dirty tabs", () => {
    setInvokeImpl(async () => "");
    (window as any).confirm = vi.fn(() => false);
    const h = setup({
      tabs: ["/w/a.txt"],
      buffers: { "/w/a.txt": "edited" },
      originals: { "/w/a.txt": "orig" },
      openPath: "/w/a.txt",
    });
    act(() => {
      h.result.current.closeTab("/w/a.txt");
    });
    expect(h.wsOf().tabs).toEqual(["/w/a.txt"]);
    (window as any).confirm = vi.fn(() => true);
    act(() => {
      h.result.current.closeTab("/w/a.txt");
    });
    expect(h.wsOf().tabs).toEqual([]);
  });
});

describe("useEditorTabs retargeting", () => {
  it("retargetTabs follows renames incl. pending diffs", () => {
    setInvokeImpl(async () => "");
    const h = setup({
      tabs: ["/w/dir/a.txt"],
      buffers: { "/w/dir/a.txt": "b" },
      originals: { "/w/dir/a.txt": "b" },
      openPath: "/w/dir/a.txt",
      pendingDiff: { path: "/w/dir/a.txt", content: "c", original: "b" },
    });
    act(() => {
      h.result.current.retargetTabs("/w/dir", "/w/renamed");
    });
    expect(h.wsOf().tabs).toEqual(["/w/renamed/a.txt"]);
    expect(h.wsOf().openPath).toBe("/w/renamed/a.txt");
    expect(h.wsOf().pendingDiff?.path).toBe("/w/renamed/a.txt");
  });

  it("dropTabsUnder clears tabs and dangling diffs", () => {
    setInvokeImpl(async () => "");
    const h = setup({
      tabs: ["/w/dir/a.txt", "/w/keep.txt"],
      buffers: { "/w/dir/a.txt": "x", "/w/keep.txt": "y" },
      originals: { "/w/dir/a.txt": "x", "/w/keep.txt": "y" },
      openPath: "/w/dir/a.txt",
      pendingDiff: { path: "/w/dir/a.txt", content: "z", original: "x" },
    });
    act(() => {
      h.result.current.dropTabsUnder("/w/dir");
    });
    expect(h.wsOf().tabs).toEqual(["/w/keep.txt"]);
    expect(h.wsOf().pendingDiff).toBeNull();
  });
});
