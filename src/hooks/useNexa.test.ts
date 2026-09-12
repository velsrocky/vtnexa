// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MEMORY_DEFAULT, PAD_DEFAULT, PLAN_DEFAULT, useNexa } from "./useNexa";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

afterEach(() => {
  vi.useRealTimers();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function reads(store: Record<string, string>, fail = false) {
  const writes: { kind: string; content: string }[] = [];
  setInvokeImpl(async (cmd, args: any) => {
    if (cmd === "nexa_read") {
      if (fail) throw new Error("io gone");
      return store[args.kind] ?? "";
    }
    if (cmd === "nexa_write") {
      writes.push({ kind: args.kind, content: args.content });
      return {};
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return writes;
}

describe("useNexa.loadNexa", () => {
  it("loads shared notes and marks them synced", async () => {
    reads({ pad: "P", plan: "PL", memory: "M" });
    const { result } = renderHook(() => useNexa({ workspaceRoot: "/w" }));
    await act(async () => {
      await result.current.loadNexa();
    });
    expect(result.current.padText).toBe("P");
    expect(result.current.planText).toBe("PL");
    expect(result.current.memoryText).toBe("M");
    expect(result.current.nexaState).toBe("saved");
    expect(result.current.nexaReady.current).toBe(true);
  });

  it("falls back to defaults for missing notes", async () => {
    reads({});
    const { result } = renderHook(() => useNexa({ workspaceRoot: "/w" }));
    await act(async () => {
      await result.current.loadNexa();
    });
    expect(result.current.padText).toBe(PAD_DEFAULT);
    expect(result.current.planText).toBe(PLAN_DEFAULT);
    expect(result.current.memoryText).toBe(MEMORY_DEFAULT);
  });

  it("surfaces load errors but still unlocks the saver", async () => {
    reads({}, true);
    const { result } = renderHook(() => useNexa({ workspaceRoot: "/w" }));
    await act(async () => {
      await result.current.loadNexa();
    });
    expect(result.current.nexaState).toBe("error");
    expect(result.current.nexaReady.current).toBe(true);
  });
});

describe("useNexa autosave", () => {
  it("debounces user edits into backend writes, then goes quiet", async () => {
    vi.useFakeTimers();
    const writes = reads({ pad: "P", plan: "PL", memory: "M" });
    const { result } = renderHook(() => useNexa({ workspaceRoot: "/w" }));
    await act(async () => {
      await result.current.loadNexa();
    });
    expect(result.current.nexaState).toBe("saved");

    act(() => {
      result.current.setPadText("P edited");
    });
    expect(result.current.nexaState).toBe("saving");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(writes).toEqual([{ kind: "pad", content: "P edited" }]);
    expect(result.current.nexaState).toBe("saved");

    // In sync now: no further writes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(writes).toHaveLength(1);
  });

  it("does nothing before the initial load completes", async () => {
    vi.useFakeTimers();
    const writes = reads({});
    const { result } = renderHook(() => useNexa({ workspaceRoot: "/w" }));
    act(() => {
      result.current.setPadText("early edit");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(writes).toHaveLength(0);
  });
});
