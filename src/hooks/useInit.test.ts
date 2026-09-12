// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInit } from "./useInit";
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
  localStorage.clear();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup(lanes: Lane[] = [newLane("Lane 1", "")]) {
  const order: string[] = [];
  let store: Lane[] = lanes;
  const setLanes: any = (u: any) => {
    store = typeof u === "function" ? u(store) : u;
  };
  const notes: string[] = [];
  const deps: any = {
    laneId: lanes[0].id,
    workspaceRoot: "",
    cwd: "",
    wsCommitted: { current: "" },
    nexaReady: { current: false },
    sessionReady: { current: false },
    routinesReady: { current: false },
    setWorkspaceRoot: vi.fn((v: string) => {
      deps.workspaceRoot = v;
    }),
    setCwdState: vi.fn((v: any) => {
      const next = typeof v === "function" ? v("") : v;
      deps.cwd = next;
    }) as any,
    setLanes,
    setOpenPath: vi.fn(),
    updateLane: (_id: string, fn: (l: Lane) => Lane) => {
      notes.push(fn(store[0]).shellOut);
    },
    saveSessionNow: vi.fn(async () => {
      order.push("save");
    }),
    loadSession: vi.fn(async () => {
      order.push("session");
    }),
    loadNexa: vi.fn(async () => {
      order.push("nexa");
    }),
    loadRoutines: vi.fn(async () => {
      order.push("routines");
    }),
    refreshSkills: vi.fn(async () => {
      order.push("skills");
    }),
    loadConventions: vi.fn(async () => {
      order.push("conventions");
    }),
  };
  const hook = renderHook(() => useInit(deps as any));
  return { ...hook, deps, order, store: () => store, notes };
}


// Drain the async init IIFE (multiple awaited microtasks).
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("useInit boot", () => {
  it("resolves the root, loads every domain in order, clamps lanes", async () => {
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/backend-home";
      if (cmd === "set_workspace_root") return String(args.path).replace(/\/$/, "");
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    expect(h.deps.setWorkspaceRoot).toHaveBeenCalledWith("/backend-home");
    expect(localStorage.getItem("vtai.workspaceRoot")).toBe("/backend-home");
    expect(h.order).toEqual(["nexa", "session", "routines", "skills", "conventions"]);
    // Empty-cwd lane clamped to canon.
    expect(h.store()[0].cwd).toBe("/backend-home");
  });

  it("prefers the stored workspace over the backend default", async () => {
    localStorage.setItem("vtai.workspaceRoot", "/stored");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/backend-home";
      if (cmd === "set_workspace_root") return String(args.path);
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    expect(h.deps.setWorkspaceRoot).toHaveBeenCalledWith("/stored");
  });
});

describe("useInit.changeWorkspace", () => {
  function ready() {
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/w";
      if (cmd === "set_workspace_root") return String(args.path).replace(/\/$/, "");
      throw new Error(`unexpected ${cmd}`);
    });
    return setup([newLane("Lane 1", "/w")]);
  }

  it("saves the old session first and reloads all domains", async () => {
    const h = ready();
    await flush();
    h.order.length = 0;
    await act(async () => {
      await h.result.current.changeWorkspace("/new");
    });
    expect(h.order).toEqual(["save", "nexa", "session", "routines", "skills", "conventions"]);
    expect(h.deps.setWorkspaceRoot).toHaveBeenLastCalledWith("/new");
    expect(h.deps.setOpenPath).toHaveBeenCalledWith("");
    expect(h.deps.nexaReady.current).toBe(false);
    expect(h.deps.sessionReady.current).toBe(false);
    expect(h.deps.routinesReady.current).toBe(false);
    // Lanes pulled inside the new root, worktrees dropped.
    expect(h.store()[0].cwd).toBe("/new");
    expect(h.store()[0].worktree).toBeNull();
  });

  it("ignores the same committed target", async () => {
    const h = ready();
    await flush();
    h.deps.saveSessionNow.mockClear();
    await act(async () => {
      await h.result.current.changeWorkspace("/w");
    });
    expect(h.deps.saveSessionNow).not.toHaveBeenCalled();
  });

  it("resets the guard and notes failures on the lane", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "workspace_root") return "/w";
      if (cmd === "set_workspace_root") throw new Error("not a directory");
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup([newLane("Lane 1", "/w")]);
    await flush();
    await act(async () => {
      await h.result.current.changeWorkspace("/bad");
    });
    expect(h.deps.wsCommitted.current).toBe("");
    expect(h.notes.join("")).toMatch(/workspace change failed/);
  });
});
