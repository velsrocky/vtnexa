// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWorkspace } from "./useWorkspace";
import { newWorkspace } from "../lib/utils";

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
  let ws = newWorkspace("main:ws", "/w");
  const updates: string[] = [];
  const hook = renderHook(() =>
    useWorkspace({
      updateWs: (fn) => {
        ws = fn(ws);
        updates.push(ws.cwd);
      },
      ptyId: "main:pty",
    }),
  );
  return { ...hook, wsOf: () => ws, updates };
}

describe("useWorkspace.refreshFiles", () => {
  it("lists entries into the tree", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("fs_list");
      return [{ name: "a.txt", path: "/w/a.txt", is_dir: false }];
    });
    const { result } = setup();
    await act(async () => {
      await result.current.refreshFiles("/w");
    });
    expect(result.current.files).toEqual([{ name: "a.txt", path: "/w/a.txt", is_dir: false }]);
  });

  it("clears the tree and logs fs errors to the workspace", async () => {
    setInvokeImpl(async () => {
      throw new Error("denied");
    });
    const { result, wsOf } = setup();
    await act(async () => {
      await result.current.refreshFiles("/w");
    });
    expect(result.current.files).toEqual([]);
    expect(wsOf().shellOut).toMatch(/fs error/);
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

describe("useWorkspace.setCwd", () => {
  it("blocks navigation outside the workspace", () => {
    setInvokeImpl(async () => []);
    const { result, wsOf } = setup();
    act(() => {
      result.current.setWorkspaceRoot("/w");
    });
    act(() => {
      result.current.setCwd("/etc");
    });
    expect(wsOf().shellOut).toMatch(/outside workspace/);
    expect(wsOf().cwd).toBe("/w");
  });

  it("accepts inside paths (workspace cwd follows)", () => {
    setInvokeImpl(async () => []);
    const { result, updates } = setup();
    act(() => {
      result.current.setWorkspaceRoot("/w");
    });
    act(() => {
      result.current.setCwd("/w/sub");
    });
    expect(result.current.cwd).toBe("/w/sub");
    expect(updates).toContain("/w/sub");
  });
});
