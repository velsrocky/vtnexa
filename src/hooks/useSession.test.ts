// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSession } from "./useSession";
import { newWorkspace } from "../lib/utils";
import type { Workspace } from "../types";

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

const BASE_WS: Workspace = {
  ...newWorkspace("main:ws", "/w", { baseUrl: "http://x", apiKey: "SHOULD-BE-STRIPPED", model: "m", kind: "auto" }),
  messages: [
    { id: "u1", role: "user", content: "hi" },
    { id: "a1", role: "assistant", content: "hello" },
    { id: "s1", role: "system", content: "sys" } as any,
  ],
  usage: { input: 10, output: 5, cost: 0, tools: 2, toolMs: 100 },
  audit: [{ id: "e1", ts: 1, tool: "fs_read", args: "{}", decision: "auto", ok: true, ms: 3 }],
  tabs: ["clean.txt"],
  buffers: { "clean.txt": "same" },
  originals: { "clean.txt": "same" },
  openPath: "clean.txt",
};

function setup(ws: Workspace = BASE_WS) {
  const saves: string[] = [];
  setInvokeImpl(async (cmd, args?: any) => {
    if (cmd === "session_save") {
      saves.push(args.content);
      return {};
    }
    if (cmd === "session_load") return "";
    if (cmd === "key_get") return "";
    if (cmd === "fs_list") return [];
    throw new Error(`unexpected ${cmd}`);
  });
  const notes: string[] = [];
  const hook = renderHook(() =>
    useSession({
      ws,
      workspaceRoot: "/w",
      setWs: vi.fn(),
      setCwdState: vi.fn(),
      note: (t) => notes.push(t),
    }),
  );
  return { ...hook, saves, notes };
}

describe("useSession.saveSessionNow", () => {
  it("persists v7 per-window slot, strips secrets and non-chat roles", async () => {
    const { result, saves } = setup();
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(saves).toHaveLength(1);
    const data = JSON.parse(saves[0]);
    expect(data.version).toBe(7);
    const w = data.windows.main;
    expect(w.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(w.provider).toMatchObject({ baseUrl: "http://x", model: "m", apiKey: "" });
    expect(w.buffers).toEqual({});
    expect(w).toMatchObject({ centerTab: "edit", sideTab: "chat", chatDraft: "", previewUrl: "" });
  });

  it("merges into the existing file without touching sibling slots", async () => {
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "session_load")
        return JSON.stringify({ version: 7, windows: { "main-2": { cwd: "/other", messages: [] } } });
      if (cmd === "session_save") {
        saves2.push(JSON.parse(args.content));
        return {};
      }
      if (cmd === "key_get") return "";
      if (cmd === "fs_list") return [];
      throw new Error(`unexpected ${cmd}`);
    });
    const saves2: any[] = [];
    const { result } = renderHook(() =>
      useSession({
        ws: BASE_WS,
        workspaceRoot: "/w",
        setWs: vi.fn(),
        setCwdState: vi.fn(),
        note: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(saves2[0].windows["main-2"]).toEqual({ cwd: "/other", messages: [] });
    expect(saves2[0].windows.main).toBeTruthy();
  });

  it("persists per-window UI state", async () => {
    const { result, saves } = setup({
      ...BASE_WS,
      centerTab: "git" as const,
      sideTab: "audit" as const,
      chatDraft: "half-typed",
      previewUrl: "http://localhost:5173",
    });
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(JSON.parse(saves[0]).windows.main).toMatchObject({
      centerTab: "git",
      sideTab: "audit",
      chatDraft: "half-typed",
      previewUrl: "http://localhost:5173",
    });
  });

  it("trims oldest messages to fit the cap and notes it", async () => {
    const big = Array.from({ length: 500 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      content: "x".repeat(4096),
    }));
    const { result, saves, notes } = setup({ ...BASE_WS, messages: big });
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(JSON.parse(saves[0]).windows.main.messages.length).toBeLessThan(500);
    expect(notes.join("")).toMatch(/trimmed oldest messages/);
  });

  it("keeps the last save when even trimmed state overflows", async () => {
    const tabs = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    const buffers: Record<string, string> = {};
    const originals: Record<string, string> = {};
    for (const t of tabs) {
      buffers[t] = "b".repeat(50000);
      originals[t] = "o".repeat(50000);
    }
    const { result, saves, notes } = setup({ ...BASE_WS, tabs, buffers, originals });
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(saves).toHaveLength(0);
    expect(notes.join("")).toMatch(/too large to save/);
  });
});

describe("useSession.loadSession", () => {
  function loadSetup(raw: string) {
    const restored: Workspace[] = [];
    setInvokeImpl(async (cmd, _args?: any) => {
      if (cmd === "session_load") return raw;
      if (cmd === "session_save") return {};
      if (cmd === "key_get") return "REFILLED";
      if (cmd === "fs_list") return [];
      throw new Error(`unexpected ${cmd}`);
    });
    const hook = renderHook(() =>
      useSession({
        ws: BASE_WS,
        workspaceRoot: "/w",
        setWs: ((u: any) => {
          restored.push(typeof u === "function" ? u(BASE_WS) : u);
        }) as any,
        setCwdState: vi.fn(),
        note: vi.fn(),
      }),
    );
    return { ...hook, restored };
  }

  it("restores its own v7 slot and refills keys", async () => {
    const raw = JSON.stringify({
      version: 7,
      windows: {
        main: {
        id: "main:ws",
        cwd: "/w",
        messages: [{ id: "m1", role: "user", content: "hi" }],
        usage: { input: 1, output: 2, cost: 0, tools: 0, toolMs: 0 },
        audit: [],
        tabs: [],
        buffers: {},
        originals: {},
        openPath: "",
          provider: { baseUrl: "http://x", model: "m", kind: "openai" },
        },
      },
    });
    const { result, restored } = loadSetup(raw);
    await act(async () => {
      await result.current.loadSession();
    });
    expect(restored).toHaveLength(1);
    expect(restored[0].messages).toEqual([{ id: "m1", role: "user", content: "hi" }]);
    expect(restored[0].provider).toMatchObject({ apiKey: "REFILLED", kind: "openai" });
    expect(result.current.sessionReady.current).toBe(true);
  });

  it("starts a fresh window empty when only another label has a slot", async () => {
    const raw = JSON.stringify({
      version: 7,
      windows: {
        "main-2": {
          id: "main-2:ws",
          cwd: "/w",
          messages: [{ id: "m1", role: "user", content: "not yours" }],
        },
      },
    });
    const { result, restored } = loadSetup(raw);
    await act(async () => {
      await result.current.loadSession();
    });
    expect(restored).toHaveLength(0);
    expect(result.current.sessionReady.current).toBe(true);
  });

  it("migrates v6/v4/v5 (single workspace / lanes[0]) into the main slot", async () => {
    const raw = JSON.stringify({
      version: 6,
      workspace: {
        id: "lane1",
        name: "Lane 1",
        cwd: "/w",
        messages: [],
        usage: { input: 0, output: 0, cost: 0, tools: 0, toolMs: 0 },
        audit: [],
        tabs: [],
        buffers: {},
        originals: {},
        openPath: "",
        provider: { baseUrl: "https://y.test", model: "ym", apiKey: "OLD", kind: "gemini" },
      },
    });
    const { result, restored } = loadSetup(raw);
    await act(async () => {
      await result.current.loadSession();
    });
    expect(restored[0].provider).toMatchObject({ baseUrl: "https://y.test", apiKey: "REFILLED", kind: "gemini" });
  });

  it("validates UI fields and caps drafts", async () => {
    const raw = JSON.stringify({
      version: 6,
      workspace: {
        id: "main:ws",
        cwd: "/w",
        messages: [],
        usage: { input: 0, output: 0, cost: 0, tools: 0, toolMs: 0 },
        audit: [],
        tabs: [],
        buffers: {},
        originals: {},
        openPath: "",
        centerTab: "bogus",
        sideTab: "bogus",
        chatDraft: "x".repeat(25000),
        previewUrl: "http://localhost:5173",
      },
    });
    const { result, restored } = loadSetup(raw);
    await act(async () => {
      await result.current.loadSession();
    });
    expect(restored[0].centerTab).toBe("edit");
    expect(restored[0].sideTab).toBe("chat");
    expect(restored[0].chatDraft).toHaveLength(20000);
  });

  it("ignores empty or corrupt payloads but still readies", async () => {
    for (const raw of ["", "not json{{"]) {
      const { result } = loadSetup(raw);
      await act(async () => {
        await result.current.loadSession();
      });
      expect(result.current.sessionReady.current).toBe(true);
    }
  });
});
