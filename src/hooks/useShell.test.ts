// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useShell } from "./useShell";
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
  const busy: boolean[] = [];
  const hook = renderHook(() =>
    useShell({
      ws,
      cwd: "/w",
      setBusy: (v) => busy.push(v),
      updateWs: (fn) => {
        ws = fn(ws);
      },
    }),
  );
  return { ...hook, wsOf: () => ws, busy };
}

describe("useShell", () => {
  it("appends command output to the shell log", async () => {
    setInvokeImpl(async (cmd, args?: any) => {
      expect(cmd).toBe("shell_run");
      expect(args).toMatchObject({ cwd: "/w" });
      return { stdout: "total 0\n", stderr: "", code: 0 };
    });
    const h = setup();
    await act(async () => {
      await h.result.current.runShell();
    });
    expect(h.wsOf().shellOut).toContain("$ ls -la");
    expect(h.wsOf().shellOut).toContain("(exit 0)");
    expect(h.busy).toEqual([true, false]);
  });

  it("logs shell errors without throwing", async () => {
    setInvokeImpl(async () => {
      throw new Error("timed out");
    });
    const h = setup();
    await act(async () => {
      await h.result.current.runShell();
    });
    expect(h.wsOf().shellOut).toMatch(/shell error/);
    expect(h.busy[h.busy.length - 1]).toBe(false);
  });

  it("tracks the command draft", () => {
    setInvokeImpl(async () => ({}));
    const { result } = setup();
    expect(result.current.shellCmd).toBe("ls -la");
    act(() => {
      result.current.onShellCmdChange("echo hi");
    });
    expect(result.current.shellCmd).toBe("echo hi");
  });
});
