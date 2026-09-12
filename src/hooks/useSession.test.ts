// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSession } from "./useSession";
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
  vi.useRealTimers();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

const BASE_LANE: Lane = {
  ...newLane("Lane 1", "/w"),
  id: "lane1",
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
  provider: { baseUrl: "http://x", model: "m", apiKey: "SHOULD-BE-STRIPPED", kind: "auto" },
};

function setup(lanes: Lane[] = [BASE_LANE], activeId = "lane1") {
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
  const updated: { id: string; fn: (l: Lane) => Lane }[] = [];
  const hook = renderHook(
    (props: { lanes: Lane[]; activeId: string }) =>
      useSession({
        lanes: props.lanes,
        activeId: props.activeId,
        workspaceRoot: "/w",
        setLanes: vi.fn(),
        setActiveId: vi.fn(),
        setCwdState: vi.fn(),
        updateLane: (id, fn) => updated.push({ id, fn }),
      }),
    { initialProps: { lanes, activeId } },
  );
  return { ...hook, saves, updated };
}

describe("useSession.saveSessionNow", () => {
  it("persists versioned lanes, strips secrets and non-chat roles", async () => {
    const { result, saves } = setup();
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(saves).toHaveLength(1);
    const data = JSON.parse(saves[0]);
    expect(data.version).toBe(5);
    expect(data.activeId).toBe("lane1");
    const [lane] = data.lanes;
    expect(lane.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(lane.provider).toMatchObject({ baseUrl: "http://x", model: "m", apiKey: "" });
    // Clean buffers are omitted to protect the 2MB cap.
    expect(lane.buffers).toEqual({});
    expect(lane.usage).toMatchObject({ input: 10, tools: 2 });
    // Per-lane UI travels with the lane.
    expect(lane).toMatchObject({ centerTab: "edit", sideTab: "chat", chatDraft: "", previewUrl: "" });
  });

  it("persists per-lane UI state", async () => {
    const { result, saves } = setup([
      { ...BASE_LANE, centerTab: "git" as const, sideTab: "audit" as const, chatDraft: "half-typed", previewUrl: "http://localhost:5173" },
    ]);
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0]).lanes[0]).toMatchObject({
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
    const { result, saves, updated } = setup([{ ...BASE_LANE, messages: big }]);
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(saves).toHaveLength(1);
    const data = JSON.parse(saves[0]);
    expect(data.lanes[0].messages.length).toBeLessThan(500);
    const noted = updated.map((u) => u.fn(BASE_LANE).shellOut).join("");
    expect(noted).toMatch(/trimmed oldest messages/);
  });

  it("keeps the last save when even trimmed state overflows", async () => {
    const tabs = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    const buffers: Record<string, string> = {};
    const originals: Record<string, string> = {};
    for (const t of tabs) {
      buffers[t] = "b".repeat(50000);
      originals[t] = "o".repeat(50000);
    }
    const { result, saves, updated } = setup([{ ...BASE_LANE, tabs, buffers, originals }]);
    await act(async () => {
      await result.current.saveSessionNow();
    });
    expect(saves).toHaveLength(0);
    const noted = updated.map((u) => u.fn(BASE_LANE).shellOut).join("");
    expect(noted).toMatch(/too large to save/);
  });
});

describe("useSession.loadSession", () => {
  function loadSetup(raw: string) {
    const lanes: Lane[][] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "session_load") return raw;
      if (cmd === "session_save") return {};
      if (cmd === "key_get") return "REFILLED";
      if (cmd === "fs_list") {
        if (String(args.path).includes("gone")) throw new Error("missing");
        return [];
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const hook = renderHook(
      (props: { lanes: Lane[]; activeId: string }) =>
        useSession({
          lanes: props.lanes,
          activeId: props.activeId,
          workspaceRoot: "/w",
          setLanes: ((u: any) => {
            lanes.push(typeof u === "function" ? u([]) : u);
          }) as any,
          setActiveId: vi.fn(),
          setCwdState: vi.fn(),
          updateLane: vi.fn(),
        }),
      { initialProps: { lanes: [], activeId: "" } },
    );
    return { ...hook, lanes };
  }

  it("restores lanes, drops dangling worktrees, refills keys", async () => {
    const raw = JSON.stringify({
      version: 4,
      activeId: "lane1",
      lanes: [
        {
          id: "lane1",
          name: "Lane 1",
          cwd: "/w",
          messages: [{ id: "m1", role: "user", content: "hi" }],
          usage: { input: 1, output: 2, cost: 0, tools: 0, toolMs: 0 },
          audit: [],
          tabs: [],
          buffers: {},
          originals: {},
          openPath: "",
          providerOverride: { baseUrl: "http://x", model: "m", kind: "openai" },
          worktree: { path: "/w/.nexa/worktrees/gone", branch: "vtnexa/x" },
        },
      ],
    });
    const { result, lanes } = loadSetup(raw);
    await act(async () => {
      await result.current.loadSession();
    });
    expect(lanes).toHaveLength(1);
    const [restored] = lanes[0];
    expect(restored.messages).toEqual([{ id: "m1", role: "user", content: "hi" }]);
    expect(restored.worktree).toBeNull();
    // v4 override adopted as the lane's own provider, key refilled.
    expect(restored.provider).toMatchObject({ baseUrl: "http://x", model: "m", apiKey: "REFILLED", kind: "openai" });
    expect(result.current.sessionReady.current).toBe(true);
  });

  it("restores v5 providers and defaults missing ones", async () => {
    const raw = JSON.stringify({
      version: 5,
      activeId: "lane1",
      lanes: [
        {
          id: "lane1", name: "Lane 1", cwd: "/w", messages: [],
          usage: { input: 0, output: 0, cost: 0, tools: 0, toolMs: 0 },
          audit: [], tabs: [], buffers: {}, originals: {}, openPath: "",
          provider: { baseUrl: "https://y.test", model: "ym", apiKey: "OLD", kind: "gemini" },
        },
        {
          id: "lane2", name: "Lane 2", cwd: "/w", messages: [],
          usage: { input: 0, output: 0, cost: 0, tools: 0, toolMs: 0 },
          audit: [], tabs: [], buffers: {}, originals: {}, openPath: "",
        },
      ],
    });
    const { result, lanes } = loadSetup(raw);
    await act(async () => {
      await result.current.loadSession();
    });
    const [one, two] = lanes[0];
    expect(one.provider).toMatchObject({ baseUrl: "https://y.test", apiKey: "REFILLED", kind: "gemini" });
    expect(two.provider).toMatchObject({ baseUrl: "http://localhost:11434/v1", apiKey: "REFILLED", kind: "auto" });
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

  it("validates per-lane UI and caps drafts", async () => {
    const raw = JSON.stringify({
      version: 4,
      activeId: "lane1",
      lanes: [
        {
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
          centerTab: "bogus",
          sideTab: "bogus",
          chatDraft: "x".repeat(25000),
          previewUrl: "http://localhost:5173",
        },
      ],
    });
    const { result, lanes } = loadSetup(raw);
    await act(async () => {
      await result.current.loadSession();
    });
    const [restored] = lanes[0];
    expect(restored.centerTab).toBe("edit");
    expect(restored.sideTab).toBe("chat");
    expect(restored.chatDraft).toHaveLength(20000);
    expect(restored.previewUrl).toBe("http://localhost:5173");
  });
});

describe("useSession autosave", () => {
  it("debounces lane changes into a save", async () => {
    vi.useFakeTimers();
    const saves: string[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "session_load") return "";
      if (cmd === "session_save") {
        saves.push(args.content);
        return {};
      }
      if (cmd === "key_get") return "";
      if (cmd === "fs_list") return [];
      throw new Error(`unexpected ${cmd}`);
    });
    const { result, rerender } = renderHook(
      (props: { lanes: Lane[] }) =>
        useSession({
          lanes: props.lanes,
          activeId: "lane1",
          workspaceRoot: "/w",
          setLanes: vi.fn(),
          setActiveId: vi.fn(),
          setCwdState: vi.fn(),
          updateLane: vi.fn(),
        }),
      { initialProps: { lanes: [BASE_LANE] } },
    );
    await act(async () => {
      await result.current.loadSession();
    });
    expect(saves).toHaveLength(0);
    rerender({ lanes: [{ ...BASE_LANE, shellOut: "changed" }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(saves).toHaveLength(1);
  });
});
