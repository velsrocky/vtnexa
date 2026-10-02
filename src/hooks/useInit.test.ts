// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInit } from "./useInit";
import { newWorkspace } from "../lib/utils";
import type { ProviderConfig } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dialogStub = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogStub.open }));

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

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setup(provider?: ProviderConfig) {
  let ws = newWorkspace("main:ws", "");
  const order: string[] = [];
  const notes: string[] = [];
  const deps: any = {
    workspaceRoot: "",
    provider,
    wsCommitted: { current: "" },
    nexaReady: { current: false },
    sessionsReady: { current: false },
    routinesReady: { current: false },
    setWorkspaceRoot: vi.fn((v: string) => {
      deps.workspaceRoot = v;
    }),
    setCwdState: vi.fn(),
    setWs: (u: any) => {
      ws = typeof u === "function" ? u(ws) : u;
    },
    setOpenPath: vi.fn(),
    updateWs: (fn: any) => {
      notes.push(fn(ws).shellOut);
    },
    saveSessionNow: vi.fn(async () => {
      order.push("save");
    }),
    bootFresh: vi.fn(async () => {
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
  const hook = renderHook(() => useInit(deps));
  return { ...hook, deps, order, notes, wsOf: () => ws };
}

describe("useInit boot", () => {
  it("resolves the root, loads every domain in order, clamps cwd", async () => {
    localStorage.setItem("vtai.workspaceRoot", "/backend-home");
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
    expect(h.wsOf().cwd).toBe("/backend-home");
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
    localStorage.setItem("vtai.workspaceRoot", "/w");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/w";
      if (cmd === "set_workspace_root") return String(args.path).replace(/\/$/, "");
      throw new Error(`unexpected ${cmd}`);
    });
    return setup();
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
    expect(h.wsOf().cwd).toBe("/new");
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

  it("resets the guard and reports failures", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "workspace_root") return "/w";
      if (cmd === "set_workspace_root") throw new Error("not a directory");
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    await act(async () => {
      await h.result.current.changeWorkspace("/bad");
    });
     expect(h.deps.wsCommitted.current).toBe("");
     expect(h.result.current.operation).toMatchObject({ status: "error" });
  });
});

describe("useInit changeWorkspace", () => {
  it("saves the old session and reloads every domain in order", async () => {
    localStorage.setItem("vtai.workspaceRoot", "/w1");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/w1";
      if (cmd === "set_workspace_root") return String(args.path);
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    h.order.length = 0;
    await act(async () => {
      await h.result.current.changeWorkspace("/w2");
    });
    expect(h.order).toEqual(["save", "nexa", "session", "routines", "skills", "conventions"]);
    expect(localStorage.getItem("vtai.workspaceRoot")).toBe("/w2");
  });

  it("ignores empty or unchanged targets and reports failures", async () => {
    localStorage.setItem("vtai.workspaceRoot", "/w1");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/w1";
      if (cmd === "set_workspace_root") {
        if (String(args.path) === "/w9") return Promise.reject("denied");
        return String(args.path);
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    h.order.length = 0;
    await act(async () => {
      await h.result.current.changeWorkspace("  ");
      await h.result.current.changeWorkspace("/w1");
    });
     expect(h.order).toEqual([]);
     await act(async () => {
       await h.result.current.changeWorkspace("/w9");
     });
     expect(h.result.current.operation).toMatchObject({ status: "error" });
  });
});

describe("useInit browseWorkspace", () => {
  it("enters an error state and retries the failed workspace initialization", async () => {
    localStorage.setItem("vtai.workspaceRoot", "/stored");
    let attempts = 0;
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/stored";
      if (cmd === "set_workspace_root") {
        attempts += 1;
        if (attempts === 1) throw new Error("access denied");
        return String(args.path);
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    expect(h.result.current.phase).toBe("workspace-error");
    expect(h.result.current.error).toMatch(/could not open/i);
    expect(h.result.current.details).toMatch(/access denied/);
    await act(async () => {
      await h.result.current.retry();
    });
    await flush();
    expect(h.result.current.phase).toBe("ready");
    expect(attempts).toBe(2);
  });

  it("moves from workspace-required to ready after a folder selection", async () => {
    dialogStub.open.mockReset();
    (globalThis as any).window.__TAURI_INTERNALS__ = {};
    dialogStub.open.mockResolvedValueOnce("/picked");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "";
      if (cmd === "set_workspace_root") return String(args.path);
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    expect(h.result.current.phase).toBe("workspace-required");
    await act(async () => {
      await h.result.current.browseWorkspace();
    });
    await flush();
    expect(h.result.current.phase).toBe("ready");
    expect(h.deps.wsCommitted.current).toBe("/picked");
    delete (globalThis as any).window.__TAURI_INTERNALS__;
  });

  it("requires provider details only when the configured provider needs them", async () => {
    localStorage.setItem("vtai.workspaceRoot", "/w");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/w";
      if (cmd === "set_workspace_root") return String(args.path);
      throw new Error(`unexpected ${cmd}`);
    });
    const provider: ProviderConfig = { baseUrl: "https://api.anthropic.com", model: "claude", apiKey: "" };
    const h = setup(provider);
    await flush();
    expect(h.result.current.phase).toBe("provider-required");
    expect(h.result.current.error).toMatch(/API key/);
    provider.apiKey = "secret";
    await act(async () => {
      await h.result.current.checkProvider();
    });
    expect(h.result.current.phase).toBe("ready");
  });

  it("treats the local default as configured", async () => {
    localStorage.setItem("vtai.workspaceRoot", "/w");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/w";
      if (cmd === "set_workspace_root") return String(args.path);
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    expect(h.result.current.phase).toBe("ready");
  });

  it("shows a visible error when the folder picker is unavailable", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "workspace_root") return "/w1";
      if (cmd === "set_workspace_root") return "/w1";
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    await act(async () => {
      await h.result.current.browseWorkspace();
    });
     expect(h.result.current.operation).toMatchObject({ status: "error" });
     expect(h.result.current.phase).toBe("workspace-error");
  });

  it("routes the picked directory through changeWorkspace", async () => {
    (globalThis as any).window.__TAURI_INTERNALS__ = {};
    dialogStub.open.mockResolvedValueOnce("/picked");
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "workspace_root") return "/w1";
      if (cmd === "set_workspace_root") return String(args.path);
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await flush();
    h.order.length = 0;
    await act(async () => {
      await h.result.current.browseWorkspace();
    });
    expect(dialogStub.open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true }),
    );
    expect(h.order).toContain("session");
    delete (globalThis as any).window.__TAURI_INTERNALS__;
  });
});
