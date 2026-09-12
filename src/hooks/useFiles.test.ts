// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFiles } from "./useFiles";
import { newLane } from "../lib/utils";

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

function setup() {
  const calls = {
    refreshFiles: [] as string[],
    opened: [] as string[],
    retargeted: [] as [string, string][],
    dropped: [] as string[],
    shellOut: [] as string[],
  };
  const lane = newLane("L", "/w");
  const hook = renderHook(() =>
    useFiles({
      cwd: "/w",
      workspaceRoot: "/w",
      lane,
      updateLane: (_id, fn) => {
        calls.shellOut.push(fn(lane).shellOut);
      },
      refreshFiles: async (dir) => {
        calls.refreshFiles.push(dir);
      },
      openFile: (path) => calls.opened.push(path),
      retargetTabs: (o, n) => calls.retargeted.push([o, n]),
      dropTabsUnder: (p) => calls.dropped.push(p),
    }),
  );
  return { ...hook, calls };
}

describe("useFiles.createEntry", () => {
  it("creates files and opens them", async () => {
    const created: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_create") {
        created.push(args);
        return "/w/new.txt";
      }
      return {};
    });
    const h = setup();
    act(() => {
      h.result.current.setCreating({ isDir: false, name: "new.txt" });
    });
    await act(async () => {
      await h.result.current.createEntry();
    });
    expect(created[0]).toMatchObject({ path: "/w/new.txt", is_dir: false });
    expect(h.result.current.creating).toBeNull();
    expect(h.calls.opened).toEqual(["/w/new.txt"]);
    expect(h.calls.refreshFiles).toEqual(["/w"]);
  });

  it("creates dirs without opening", async () => {
    setInvokeImpl(async () => ({}));
    const h = setup();
    act(() => {
      h.result.current.setCreating({ isDir: true, name: "sub" });
    });
    await act(async () => {
      await h.result.current.createEntry();
    });
    expect(h.calls.opened).toEqual([]);
    expect(h.result.current.creating).toBeNull();
  });

  it("blank names just close the row", async () => {
    let invoked = false;
    setInvokeImpl(async () => {
      invoked = true;
      return {};
    });
    const h = setup();
    act(() => {
      h.result.current.setCreating({ isDir: false, name: "   " });
    });
    await act(async () => {
      await h.result.current.createEntry();
    });
    expect(invoked).toBe(false);
    expect(h.result.current.creating).toBeNull();
  });
});

describe("useFiles.doRename", () => {
  it("renames and retargets tabs", async () => {
    const renamed: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_rename") {
        renamed.push(args);
        return "/w/b.txt";
      }
      return {};
    });
    const h = setup();
    act(() => {
      h.result.current.setRenaming({ path: "/w/a.txt", name: "b.txt" });
    });
    await act(async () => {
      await h.result.current.doRename();
    });
    expect(renamed[0]).toMatchObject({ old_path: "/w/a.txt", new_path: "/w/b.txt" });
    expect(h.calls.retargeted).toEqual([["/w/a.txt", "/w/b.txt"]]);
    expect(h.result.current.renaming).toBeNull();
  });

  it("unchanged names just close the row", async () => {
    let invoked = false;
    setInvokeImpl(async () => {
      invoked = true;
      return {};
    });
    const h = setup();
    act(() => {
      h.result.current.setRenaming({ path: "/w/a.txt", name: "a.txt" });
    });
    await act(async () => {
      await h.result.current.doRename();
    });
    expect(invoked).toBe(false);
  });
});

describe("useFiles.doDelete", () => {
  it("confirms, deletes and drops tabs", async () => {
    (window as any).confirm = vi.fn(() => true);
    const deleted: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_delete") {
        deleted.push(args);
        return {};
      }
      return {};
    });
    const h = setup();
    await act(async () => {
      await h.result.current.doDelete("/w/gone", true);
    });
    expect(deleted[0]).toMatchObject({ path: "/w/gone", recursive: true });
    expect(h.calls.dropped).toEqual(["/w/gone"]);
  });

  it("aborts when the user cancels", async () => {
    (window as any).confirm = vi.fn(() => false);
    let invoked = false;
    setInvokeImpl(async () => {
      invoked = true;
      return {};
    });
    const h = setup();
    await act(async () => {
      await h.result.current.doDelete("/w/keep", false);
    });
    expect(invoked).toBe(false);
    expect(h.calls.dropped).toEqual([]);
  });
});
