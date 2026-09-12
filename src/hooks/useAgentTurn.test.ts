// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentTurn } from "./useAgentTurn";
import { newWorkspace } from "../lib/utils";
import type { ProviderConfig, Workspace } from "../types";

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
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function openAIText(text: string, usage = { prompt_tokens: 20, completion_tokens: 10 }) {
  return json({ choices: [{ message: { content: text } }], usage });
}

function setup(opts?: {
  busy?: boolean;
  provHistLength?: number;
  skills?: { name: string; description: string }[];
}) {
  let ws: Workspace = newWorkspace("main:ws", "/w");
  const busy: boolean[] = [];
  const remembered: ProviderConfig[] = [];
  const centerTabs: string[] = [];
  const audits: any[] = [];
  const turnAbort = { current: null as AbortController | null };
  const hook = renderHook(() =>
    useAgentTurn({
      ws,
      workspaceRoot: "/w",
      conventions: "",
      conventionsName: "",
      skills: opts?.skills ?? [],
      provHistLength: opts?.provHistLength ?? 1,
      busy: opts?.busy ?? false,
      turnAbort: turnAbort as any,
      streamRaf: { current: null } as any,
      stickBottom: { current: true },
      lastSynced: { current: { pad: "", plan: "", memory: "" } },
      updateWs: (fn) => {
        ws = fn(ws);
      },
      setBusy: (v) => busy.push(v),
      logAudit: (e) => audits.push(e),
      rememberProvider: (c) => remembered.push(c),
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
  return { ...hook, wsOf: () => ws, busy, remembered, centerTabs, audits, turnAbort };
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
      await h.result.current.runAgentTurn("go");
    });
    expect(h.wsOf().messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["assistant", "answer"],
    ]);
    expect(h.busy).toEqual([true, false]);
    expect(h.wsOf().usage).toMatchObject({ input: 20, output: 10 });
    expect(h.remembered).toHaveLength(1);
    expect(h.turnAbort.current).toBeNull();
  });

  it("refuses when busy without touching the network", async () => {
    let fetched = false;
    stubFetch(() => {
      fetched = true;
      return openAIText("x");
    });
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup({ busy: true });
    await act(async () => {
      await h.result.current.runAgentTurn("go");
    });
    expect(fetched).toBe(false);
    expect(h.wsOf().messages).toHaveLength(0);
  });

  it("surfaces provider errors as chat messages", async () => {
    stubFetch(() => json({ error: "boom" }, 500));
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup();
    await act(async () => {
      await h.result.current.runAgentTurn("go");
    });
    const last = h.wsOf().messages[h.wsOf().messages.length - 1];
    expect(last.content).toMatch(/provider error/);
    expect(h.busy[h.busy.length - 1]).toBe(false);
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
      p = h.result.current.runAgentTurn("go");
    });
    expect(h.turnAbort.current).not.toBeNull();
    act(() => {
      h.turnAbort.current?.abort();
    });
    await act(async () => {
      await p;
    });
    const last = h.wsOf().messages[h.wsOf().messages.length - 1];
    expect(last.content).toMatch(/turn stopped/);
    expect(h.turnAbort.current).toBeNull();
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
  it("stages agent writes into the gate", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "old";
      return {};
    });
    stubRafSync();
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
    const h = setup();
    await act(async () => {
      await h.result.current.runAgentTurn("write it");
    });
    expect(h.wsOf().pendingDiff).toEqual({ path: "/w/a.txt", content: "new", original: "old" });
    expect(h.centerTabs).toEqual(["diff"]);
  });

  it("adds first-run Ollama aid for localhost connection failures", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup({ provHistLength: 0 });
    await act(async () => {
      await h.result.current.runAgentTurn("go");
    });
    const last = h.wsOf().messages[h.wsOf().messages.length - 1];
    expect(last.content).toMatch(/ollama serve/);
  }, 10000);
});
