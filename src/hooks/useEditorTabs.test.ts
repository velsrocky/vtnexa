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
  it("drops clean tabs and follows neighbors", async () => {
    setInvokeImpl(async () => "");
    const h = setup({
      tabs: ["/w/a.txt", "/w/b.txt"],
      buffers: { "/w/a.txt": "x", "/w/b.txt": "y" },
      originals: { "/w/a.txt": "x", "/w/b.txt": "y" },
      openPath: "/w/a.txt",
    });
    await act(async () => {
      await h.result.current.closeTab("/w/a.txt");
    });
    expect(h.wsOf().tabs).toEqual(["/w/b.txt"]);
    expect(h.wsOf().openPath).toBe("/w/b.txt");
  });

  it("asks before discarding dirty tabs", async () => {
    setInvokeImpl(async () => "");
    (window as any).confirm = vi.fn(() => false);
    const h = setup({
      tabs: ["/w/a.txt"],
      buffers: { "/w/a.txt": "edited" },
      originals: { "/w/a.txt": "orig" },
      openPath: "/w/a.txt",
    });
    await act(async () => {
      await h.result.current.closeTab("/w/a.txt");
    });
    expect(h.wsOf().tabs).toEqual(["/w/a.txt"]);
    (window as any).confirm = vi.fn(() => true);
    await act(async () => {
      await h.result.current.closeTab("/w/a.txt");
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

describe("useEditorTabs.openFile branches", () => {
  it("blocks paths outside the workspace", async () => {
    const h = setup();
    await act(async () => {
      await h.result.current.openFile("/etc/passwd");
    });
    expect(h.wsOf().tabs).toEqual([]);
    expect(h.wsOf().shellOut).toContain("blocked: outside workspace");
  });

  it("re-activates an open tab preserving the live buffer (no re-read)", async () => {
    let reads = 0;
    setInvokeImpl(async () => {
      reads++;
      return "fresh";
    });
    const h = setup({
      tabs: ["/w/a.txt"],
      buffers: { "/w/a.txt": "edited locally" },
      originals: { "/w/a.txt": "fresh" },
      openPath: "",
    });
    await act(async () => {
      await h.result.current.openFile("/w/a.txt");
    });
    expect(reads).toBe(0);
    expect(h.wsOf().openPath).toBe("/w/a.txt");
    h.rerender();
    expect(h.result.current.editorText).toBe("edited locally");
    expect(h.calls.centerTab).toEqual(["edit"]);
  });

  it("surfaces read failures into the shell log", async () => {
    setInvokeImpl(() => Promise.reject(new Error("permission denied")));
    const h = setup();
    await act(async () => {
      await h.result.current.openFile("/w/locked.txt");
    });
    expect(h.wsOf().shellOut).toContain("open failed: Error: permission denied");
    expect(h.wsOf().tabs).toEqual([]);
  });
});

describe("useEditorTabs.closeTab", () => {
  it("asks before closing a dirty ACTIVE tab and keeps everything on decline", async () => {
    (window as any).confirm = vi.fn(() => false);
    const h = setup({
      tabs: ["/w/a.txt", "/w/b.txt"],
      buffers: { "/w/a.txt": "dirty" },
      originals: { "/w/a.txt": "disk" },
      openPath: "/w/a.txt",
    });
    await act(async () => {
      await h.result.current.closeTab("/w/a.txt");
    });
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(h.wsOf().tabs).toEqual(["/w/a.txt", "/w/b.txt"]);
    expect(h.wsOf().buffers["/w/a.txt"]).toBe("dirty");
  });

  it("closes dirty tab on confirm and activates the neighbour at the edge", async () => {
    (window as any).confirm = vi.fn(() => true);
    const h = setup({
      tabs: ["/w/a.txt", "/w/b.txt"],
      buffers: { "/w/a.txt": "dirty", "/w/b.txt": "clean" },
      originals: { "/w/a.txt": "disk", "/w/b.txt": "clean" },
      openPath: "/w/b.txt",
    });
    await act(async () => {
      await h.result.current.closeTab("/w/a.txt");
    });
    // The clean close added no second prompt; openPath preserved.
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(h.wsOf().tabs).toEqual(["/w/b.txt"]);
    expect(h.wsOf().openPath).toBe("/w/b.txt");
    expect(h.wsOf().buffers["/w/a.txt"]).toBeUndefined();
    h.rerender();
    await act(async () => {
      await h.result.current.closeTab("/w/b.txt");
    });
    expect(h.wsOf().tabs).toEqual([]);
    expect(h.wsOf().openPath).toBe("");
  });
});

describe("useEditorTabs.rename/delete retargeting", () => {
  it("retargetTabs re-keys nested paths, buffers and the pending diff", async () => {
    setInvokeImpl(async () => "t");
    const h = setup({
      tabs: ["/w/src/a.ts", "/w/other.ts"],
      buffers: { "/w/src/a.ts": "a" },
      originals: { "/w/src/a.ts": "a" },
      openPath: "/w/src/a.ts",
      pendingDiff: { path: "/w/src/deep/b.ts", content: "x", original: "y" },
    });
    await act(async () => {
      h.result.current.retargetTabs("/w/src", "/w/pkg");
    });
    expect(h.wsOf().tabs).toEqual(["/w/pkg/a.ts", "/w/other.ts"]);
    expect(h.wsOf().buffers).toEqual({ "/w/pkg/a.ts": "a" });
    expect(h.wsOf().openPath).toBe("/w/pkg/a.ts");
    expect(h.wsOf().pendingDiff?.path).toBe("/w/pkg/deep/b.ts");
  });

  it("dropTabsUnder clears tabs, buffers, dangling openPath and pending diff", async () => {
    setInvokeImpl(async () => "t");
    const h = setup({
      tabs: ["/w/src/a.ts", "/w/keep.ts"],
      buffers: { "/w/src/a.ts": "a", "/w/keep.ts": "k" },
      originals: { "/w/src/a.ts": "a", "/w/keep.ts": "k" },
      openPath: "/w/src/a.ts",
      pendingDiff: { path: "/w/src/c.ts", content: "x", original: "y" },
    });
    await act(async () => {
      h.result.current.dropTabsUnder("/w/src");
    });
    h.rerender();
    expect(h.wsOf().tabs).toEqual(["/w/keep.ts"]);
    expect(h.wsOf().openPath).toBe("");
    expect(h.result.current.editorText).toContain("open a file from the tree");
    expect(h.wsOf().pendingDiff).toBeNull();
  });
});
