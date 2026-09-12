// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentTurn } from "./useAgentTurn";
import { newLane } from "../lib/utils";
import type { Lane, ProviderConfig } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAIText(text: string, usage = { prompt_tokens: 20, completion_tokens: 10 }) {
  return json({ choices: [{ message: { content: text } }], usage });
}

function setup(opts?: {
  busy?: boolean;
  activeIsLane?: boolean;
  provHistLength?: number;
  skills?: { name: string; description: string }[];
}) {
  let store: Lane[] = [{ ...newLane("L", "/w"), id: "lane1" }];
  const setLanes: any = (u: any) => {
    store = typeof u === "function" ? u(store) : u;
  };
  const busy: [string, boolean][] = [];
  const remembered: ProviderConfig[] = [];
  const unseen: Record<string, boolean>[] = [];
  const centerTabs: string[] = [];
  const audits: any[] = [];
  const turnAborts = { current: new Map<string, AbortController>() };
  const hook = renderHook(() =>
    useAgentTurn({
      lanes: store,
      lane: store[0],
      workspaceRoot: "/w",
      conventions: "",
      conventionsName: "",
      skills: opts?.skills ?? [],
      provHistLength: opts?.provHistLength ?? 1,
      busyLanes: opts?.busy ? { lane1: true } : {},
      activeIdRef: { current: opts?.activeIsLane === false ? "other" : "lane1" },
      turnAborts: turnAborts as any,
      streamRafs: { current: new Map() } as any,
      stickBottom: { current: true },
      lastSynced: { current: { pad: "", plan: "", memory: "" } },
      updateLane: (id, fn) => setLanes((ls: Lane[]) => ls.map((l) => (l.id === id ? fn(l) : l))),
      setLaneBusy: (id, v) => busy.push([id, v]),
      logAudit: (_id, e) => audits.push(e),
      rememberProvider: (c) => remembered.push(c),
      setUnseen: ((u: any) => {
        unseen.push(typeof u === "function" ? u({}) : u);
      }) as any,
      setPendingTools: vi.fn(),
      setCenterTab: ((t: string) => centerTabs.push(t)) as any,
      setPadText: vi.fn(),
      setPlanText: vi.fn(),
      setMemoryText: vi.fn(),
      setNexaState: vi.fn(),
      setShowJump: vi.fn(),
      flushStreamFrame: vi.fn(),
    }),
  );
  const lane = () => store.find((l) => l.id === "lane1") ?? store[0];
  return { ...hook, lane, busy, remembered, unseen, centerTabs, audits, turnAborts };
}

function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", handler);
}

function stubRafSync() {
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

describe("useAgentTurn plain turns", () => {
  it("appends user + answer, tracks busy, usage and provider", async () => {
    stubFetch(() => openAIText("answer"));
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup();
    await act(async () => {
      await h.result.current.runAgentTurn("lane1", "go");
    });
    expect(h.lane().messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["assistant", "answer"],
    ]);
    expect(h.busy).toEqual([["lane1", true], ["lane1", false]]);
    expect(h.lane().usage).toMatchObject({ input: 20, output: 10 });
    expect(h.remembered).toHaveLength(1);
    expect(h.unseen).toHaveLength(0);
    expect(h.turnAborts.current.has("lane1")).toBe(false);
  });

  it("flags background lanes for later review", async () => {
    stubFetch(() => openAIText("done"));
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup({ activeIsLane: false });
    await act(async () => {
      await h.result.current.runAgentTurn("lane1", "go");
    });
    expect(h.unseen).toEqual([{ lane1: true }]);
  });

  it("refuses occupied lanes without touching the network", async () => {
    let fetched = false;
    stubFetch(() => {
      fetched = true;
      return openAIText("x");
    });
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup({ busy: true });
    await act(async () => {
      await h.result.current.runAgentTurn("lane1", "go");
    });
    expect(fetched).toBe(false);
    expect(h.lane().messages).toHaveLength(0);
  });

  it("surfaces provider errors as chat messages", async () => {
    stubFetch(() => json({ error: "boom" }, 500));
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup();
    await act(async () => {
      await h.result.current.runAgentTurn("lane1", "go");
    });
    const last = h.lane().messages[h.lane().messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toMatch(/provider error/);
    expect(h.busy[h.busy.length - 1]).toEqual(["lane1", false]);
  });
});

describe("useAgentTurn stop", () => {
  it("aborts in-flight turns without undoing history", async () => {
    stubFetch((_url, init: any) => {
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });
    });
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup();
    let p: Promise<void> | undefined;
    act(() => {
      p = h.result.current.runAgentTurn("lane1", "go");
    });
    expect(h.turnAborts.current.has("lane1")).toBe(true);
    act(() => {
      h.turnAborts.current.get("lane1")?.abort();
    });
    await act(async () => {
      await p;
    });
    const last = h.lane().messages[h.lane().messages.length - 1];
    expect(last.content).toMatch(/turn stopped/);
    expect(h.turnAborts.current.has("lane1")).toBe(false);
  });
});

describe("useAgentTurn.expandSkill", () => {
  it("passes through plain text and unknown skills", async () => {
    setInvokeImpl(async () => ({}));
    const h = setup({ skills: [{ name: "fix", description: "d" }] });
    await expect(h.result.current.expandSkill("hello")).resolves.toBe("hello");
    await expect(h.result.current.expandSkill("/nope args")).resolves.toBe("/nope args");
  });

  it("inlines skill bodies with arguments", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("skill_read");
      return "SKILL BODY";
    });
    const h = setup({ skills: [{ name: "fix", description: "d" }] });
    await expect(h.result.current.expandSkill("/fix the bug")).resolves.toBe(
      "[skill: fix]\nSKILL BODY\n\nArguments:\nthe bug",
    );
  });
});

describe("useAgentTurn tools", () => {
  it("stages agent writes into the gate on the active lane", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "old";
      return {};
    });
    stubRafSync();
    const h = setup();
    // First request: propose a write; second: final text.
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1) {
        return json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "w1", type: "function", function: { name: "fs_write", arguments: JSON.stringify({ path: "/w/a.txt", content: "new" }) } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      return openAIText("staged");
    });
    await act(async () => {
      await h.result.current.runAgentTurn("lane1", "write it");
    });
    expect(h.lane().pendingDiff).toEqual({ path: "/w/a.txt", content: "new", original: "old" });
    expect(h.centerTabs).toEqual(["diff"]);
  });

  it("adds first-run Ollama aid for localhost connection failures", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup({ provHistLength: 0 });
    await act(async () => {
      await h.result.current.runAgentTurn("lane1", "go");
    });
    const last = h.lane().messages[h.lane().messages.length - 1];
    expect(last.content).toMatch(/ollama serve/);
  }, 10000);
});
