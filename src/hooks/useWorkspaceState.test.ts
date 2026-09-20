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

describe("useWorkspaceState approvals", () => {
  it("has no page-DOM approval queue (native OS dialogs own approvals)", () => {
    const { result } = renderHook(() => useWorkspaceState());
    expect((result.current as Record<string, unknown>).pendingTools).toBeUndefined();
    expect((result.current as Record<string, unknown>).resolveHead).toBeUndefined();
  });
});
