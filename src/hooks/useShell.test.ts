// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useShell } from "./useShell";
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

afterEach(() => {
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup() {
  let store: Lane[] = [newLane("L", "/w")];
  const setLanes: any = (u: any) => {
    store = typeof u === "function" ? u(store) : u;
  };
  const busy: [string, boolean][] = [];
  const hook = renderHook(() =>
    useShell({
      lane: store[0],
      cwd: "/w",
      setLanes,
      setLaneBusy: (id, v) => busy.push([id, v]),
      updateLane: (id, fn) => setLanes((ls: Lane[]) => ls.map((l) => (l.id === id ? fn(l) : l))),
    }),
  );
  return { ...hook, busy, lane: () => store[0] };
}

describe("useShell", () => {
  it("appends command output to the lane log", async () => {
    setInvokeImpl(async (cmd, args?: any) => {
      expect(cmd).toBe("shell_run");
      expect(args).toMatchObject({ cwd: "/w" });
      return { stdout: "total 0\n", stderr: "", code: 0 };
    });
    const h = setup();
    await act(async () => {
      await h.result.current.runShell();
    });
    expect(h.lane().shellOut).toContain("$ ls -la");
    expect(h.lane().shellOut).toContain("total 0");
    expect(h.lane().shellOut).toContain("(exit 0)");
    expect(h.busy).toEqual([[h.lane().id, true], [h.lane().id, false]]);
  });

  it("logs shell errors without throwing", async () => {
    setInvokeImpl(async () => {
      throw new Error("timed out");
    });
    const h = setup();
    await act(async () => {
      await h.result.current.runShell();
    });
    expect(h.lane().shellOut).toMatch(/shell error/);
    expect(h.busy[h.busy.length - 1]).toEqual([h.lane().id, false]);
  });

  it("tracks a per-lane command draft", () => {
    setInvokeImpl(async () => ({}));
    const h = setup();
    expect(h.result.current.shellCmd).toBe("ls -la");
    act(() => {
      h.result.current.onShellCmdChange("echo hi");
    });
    h.rerender();
    expect(h.result.current.shellCmd).toBe("echo hi");
  });
});
