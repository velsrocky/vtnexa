// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWorkspaceState } from "./useWorkspaceState";

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

describe("useWorkspaceState basics", () => {
  it("starts with one workspace, not busy", () => {
    const { result } = renderHook(() => useWorkspaceState());
    expect(result.current.ws.messages).toEqual([]);
    expect(result.current.ws.id).toContain(":ws");
    expect(result.current.busy).toBe(false);
    expect(result.current.ws.provider.model).toBeTruthy();
  });

  it("updateWs patches in place", () => {
    const { result } = renderHook(() => useWorkspaceState());
    act(() => {
      result.current.updateWs((w) => ({ ...w, cwd: "/x" }));
    });
    expect(result.current.ws.cwd).toBe("/x");
  });

  it("logAudit appends and caps at 100", () => {
    const { result } = renderHook(() => useWorkspaceState());
    act(() => {
      for (let i = 0; i < 105; i++) {
        result.current.logAudit({ tool: "fs_read", args: "{}", decision: "auto", ok: true, ms: 1 });
      }
    });
    expect(result.current.ws.audit).toHaveLength(100);
    expect(result.current.ws.audit[0].tool).toBe("fs_read");
  });
});

describe("useWorkspaceState turn control", () => {
  it("stopTurn aborts the in-flight controller", () => {
    const { result } = renderHook(() => useWorkspaceState());
    const ac = new AbortController();
    act(() => {
      result.current.turnAbort.current = ac;
      result.current.stopTurnIdRef.current = "test:ws";
    });
    act(() => {
      const stopped = result.current.stopTurn("test:ws");
      expect(stopped).toBe(true);
    });
    expect(ac.signal.aborted).toBe(true);
    expect(result.current.turnAbort.current).toBeNull();
    expect(result.current.stopTurnIdRef.current).toBe("");
  });

  it("stopTurn ignores a turn id that doesn't match", () => {
    const { result } = renderHook(() => useWorkspaceState());
    const ac = new AbortController();
    act(() => {
      result.current.turnAbort.current = ac;
      result.current.stopTurnIdRef.current = "this:ws";
    });
    act(() => {
      const stopped = result.current.stopTurn("other:ws");
      expect(stopped).toBe(false);
    });
    expect(ac.signal.aborted).toBe(false);
    expect(result.current.turnAbort.current).toBe(ac);
  });

  it("flushStreamFrame releases the coalescing frame", () => {
    const { result } = renderHook(() => useWorkspaceState());
    act(() => {
      result.current.streamRaf.current = 999999;
    });
    act(() => {
      result.current.flushStreamFrame();
    });
    expect(result.current.streamRaf.current).toBeNull();
  });
});

describe("useWorkspaceState approval queue", () => {
  it("resolveHead settles the head tool", () => {
    const { result } = renderHook(() => useWorkspaceState());
    const resolve = vi.fn();
    act(() => {
      result.current.setPendingTools([{ tool: "shell_run", args: { cmd: "ls" }, resolve }]);
    });
    act(() => {
      result.current.resolveHead(true);
    });
    expect(resolve).toHaveBeenCalledWith(true);
    expect(result.current.pendingTools).toHaveLength(0);
  });

  it("stopTurn releases every waiting approval", () => {
    const { result } = renderHook(() => useWorkspaceState());
    const r1 = vi.fn();
    const r2 = vi.fn();
    act(() => {
      result.current.setPendingTools([
        { tool: "shell_run", args: {}, resolve: r1 },
        { tool: "fs_delete", args: {}, resolve: r2 },
      ]);
    });
    act(() => {
      result.current.stopTurn("test:ws");
    });
    expect(r1).toHaveBeenCalledWith(false);
    expect(r2).toHaveBeenCalledWith(false);
    expect(result.current.pendingTools).toHaveLength(0);
  });

  it("resolveHead on an empty queue is a no-op", () => {
    const { result } = renderHook(() => useWorkspaceState());
    expect(() => {
      act(() => {
        result.current.resolveHead(false);
      });
    }).not.toThrow();
  });
});
