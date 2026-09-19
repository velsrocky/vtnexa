// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentTurn } from "./useAgentTurn";
import { newWorkspace } from "../lib/utils";
import type { ChatMsg, ProviderConfig, Workspace } from "../types";

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
  localStorage.clear();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function openAIText(text: string, usage = { prompt_tokens: 20, completion_tokens: 10 }) {
  return json({ choices: [{ message: { content: text } }], usage });
}

function sse(events: unknown[]) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** One streamed tool round: thinking deltas + N parallel fs_list calls. */
function sseToolRound(reasoning: string, calls: { id: string; path: string }[]) {
  return sse([
    { choices: [{ delta: { reasoning_content: reasoning } }] },
    ...calls.map((c, i) => ({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: i, id: c.id, function: { name: "fs_list", arguments: JSON.stringify({ path: c.path }) } },
            ],
          },
        },
      ],
    })),
    { usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
}

function setup(opts?: {
  busy?: boolean;
  provHistLength?: number;
  skills?: { name: string; description: string }[];
  memoryText?: string;
  repoMap?: string;
  gitSnapshot?: string;
  openPath?: string;
  provider?: Partial<ProviderConfig>;
  planMode?: boolean;
  /** Prior session messages, seeded before the turn runs. */
  history?: ChatMsg[];
}) {
  let ws: Workspace = {
    ...newWorkspace("main:ws", "/w"),
    ...(opts?.provider ? { provider: { ...newWorkspace("main:ws", "/w").provider, ...opts.provider } } : {}),
    ...(opts?.history ? { messages: opts.history } : {}),
  };
  const busy: boolean[] = [];
  const remembered: ProviderConfig[] = [];
  const centerTabs: string[] = [];
  const audits: any[] = [];
  const turnAbort = { current: null as AbortController | null };
  const stopTurnIdRef = { current: "" };
  const hook = renderHook(() =>
    useAgentTurn({
      ws,
      workspaceRoot: "/w",
      conventions: "",
      conventionsName: "",
      skills: opts?.skills ?? [],
      provHistLength: opts?.provHistLength ?? 1,
      memoryText: opts?.memoryText,
      repoMap: opts?.repoMap,
      gitSnapshot: opts?.gitSnapshot,
      openPath: opts?.openPath,
      busy: opts?.busy ?? false,
      turnAbort: turnAbort as any,
      stopTurnIdRef: stopTurnIdRef as any,
      streamRaf: { current: null } as any,
      stickBottom: { current: true },
      lastSynced: { current: { pad: "", plan: "", memory: "" } },
      updateWs: (fn) => {
        ws = fn(ws);
      },
      setBusy: (v) => busy.push(v),
      logAudit: (e) => audits.push(e),
      rememberProvider: (c) => remembered.push(c),
      setCenterTab: ((t: string) => centerTabs.push(t)) as any,
      setPadText: vi.fn(),
      setPlanText: vi.fn(),
      setMemoryText: vi.fn(),
      setNexaState: vi.fn(),
      setShowJump: vi.fn(),
      flushStreamFrame: vi.fn(),
      planMode: opts?.planMode ?? false,
      pushUndo: vi.fn(),
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

describe("useAgentTurn context packing", () => {
  it("packs contract, clarify rule, memory, repo map, git and open file into the system prompt", async () => {
    let sys = "";
    stubFetch((_url, init: any) => {
      try {
        sys = JSON.parse(init.body).messages[0].content;
      } catch {
        sys = "";
      }
      return openAIText("ok");
    });
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup({
      memoryText: "Decided: use pnpm, never npm.",
      repoMap: "dir src\nfile package.json",
      gitSnapshot: "main · 2 changed: a.txt, b.txt",
      openPath: "/w/src/App.tsx",
      provider: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
    });
    await act(async () => {
      await h.result.current.runAgentTurn("go");
    });
    expect(sys).toMatch(/Answer contract/);
    expect(sys).toMatch(/Ambiguity rule/);
    expect(sys).toMatch(/act-first/);
    expect(sys).toMatch(/Start acting on your first reply/);
    expect(sys).toMatch(/NEVER use shell for listing/);
    expect(sys).toMatch(/Wrapper rule/);
    expect(sys).toMatch(/Read-before-edit/);
    expect(sys).toMatch(/Decided: use pnpm/);
    expect(sys).toMatch(/Repo map/);
    expect(sys).toMatch(/main · 2 changed/);
    expect(sys).toMatch(/open=\/w\/src\/App\.tsx/);
  });
});

describe("useAgentTurn model variants", () => {
  async function captureSys(provider?: Partial<ProviderConfig>): Promise<string> {
    let sys = "";
    stubFetch((_url, init: any) => {
      try {
        sys = JSON.parse(init.body).messages[0].content;
      } catch {
        sys = "";
      }
      return openAIText("ok");
    });
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup(provider ? { provider } : undefined);
    await act(async () => {
      await h.result.current.runAgentTurn("go");
    });
    return sys;
  }

  it("uses the compact one-tool prompt for weak local models", async () => {
    const sys = await captureSys({ baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b" });
    expect(sys).toMatch(/ONE tool call per reply/);
    expect(sys).toMatch(/talking about a tool does nothing/);
    expect(sys).toMatch(/meta-commentary/);
    expect(sys).toMatch(/NO cd tool/);
    expect(sys).toMatch(/ALREADY pasted above/);
    expect(sys).toMatch(/needs NO tools/);
    expect(sys).toMatch(/First reply/);
    expect(sys).toMatch(/Grounding/);
    expect(sys).toMatch(/text-only/);
    expect(sys).toMatch(/ONLY from a shell_run tool result/);
    expect(sys).not.toMatch(/Answer contract/);
  });

  it("uses the full contract prompt for frontier models", async () => {
    const sys = await captureSys({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o" });
    expect(sys).toMatch(/Answer contract/);
    expect(sys).toMatch(/Start acting on your first reply/);
    expect(sys).toMatch(/Grounding/);
    expect(sys).toMatch(/only shell_run results count as output/);
    expect(sys).not.toMatch(/ONE tool call per reply/);
  });

  it("lets observed repair history override the heuristic", async () => {
    const { recordTurnRepairs } = await import("../lib/modelBands");
    for (let i = 0; i < 3; i++) {
      recordTurnRepairs("https://api.openai.com/v1", "gpt-4o", 2);
    }
    const sys = await captureSys({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o" });
    expect(sys).toMatch(/ONE tool call per reply/);
    expect(sys).not.toMatch(/Answer contract/);
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
      "User invoked /fix - follow these skill instructions now using tools, do not discuss the skill itself:\n[skill: fix]\nSKILL BODY\n\nArguments:\nthe bug",
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

describe("useAgentTurn plan mode", () => {
  async function planTurn(opts?: { planMode?: boolean; override?: { plan?: boolean } }) {
    let body: any = null;
    stubFetch(async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return openAIText("here is the plan");
    });
    stubRafSync();
    setInvokeImpl(async () => ({}));
    const h = setup({ planMode: opts?.planMode });
    await act(async () => {
      await h.result.current.runAgentTurn("plan this", opts?.override);
    });
    return body;
  }

  it("withholds side-effect tools and says PLAN MODE", async () => {
    const body = await planTurn({ override: { plan: true } });
    const sys = body.messages[0].content as string;
    expect(sys).toContain("PLAN MODE");
    const names = (body.tools as any[]).map((t) => t.function.name);
    expect(names).toContain("fs_read");
    expect(names).toContain("shell_poll");
    expect(names).not.toContain("shell_run");
    expect(names).not.toContain("shell_bg");
    expect(names).not.toContain("fs_write");
    expect(names).not.toContain("git_commit");
  });

  it("defaults to the window toggle, overridable per call", async () => {
    const fromToggle = await planTurn({ planMode: true });
    expect((fromToggle.messages[0].content as string)).toContain("PLAN MODE");
    // Routines force Build even when the toggle is on.
    const forced = await planTurn({ planMode: true, override: { plan: false } });
    expect((forced.messages[0].content as string)).not.toContain("PLAN MODE");
    const names = (forced.tools as any[]).map((t) => t.function.name);
    expect(names).toContain("shell_run");
  });
});

describe("useAgentTurn stall escalation", () => {
  const Q = "Should I proceed with the setup?";
  function stubScript(replies: (string | { tool: string; args: unknown })[]) {
    const bodies: any[] = [];
    let i = 0;
    stubFetch((_url: string, init: any) => {
      try {
        bodies.push(JSON.parse(init.body));
      } catch {
        /* ignore */
      }
      const next = replies[Math.min(i++, replies.length - 1)];
      if (typeof next === "string") return openAIText(next);
      return json({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "c1", type: "function", function: { name: next.tool, arguments: JSON.stringify(next.args) } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });
    });
    stubRafSync();
    return bodies;
  }
  function stubFs() {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [{ name: "a", path: "/w/a", is_dir: false }];
      throw new Error(`unexpected ${cmd}`);
    });
  }
  const sysOf = (bodies: any[]) => bodies[0].messages[0].content as string;

  it("warns after question-only turns, resets once the model acts", async () => {
    stubFs();
    const h = setup();
    const run = (p: string) => act(async () => { await h.result.current.runAgentTurn(p); });

    let bodies = stubScript([Q, Q]);
    await run("set it up");
    expect(sysOf(bodies)).not.toContain("Stall warning");
    expect(sysOf(bodies)).toContain("may be reused directly");

    bodies = stubScript([Q, Q]);
    await run("set it up");
    expect(sysOf(bodies)).toContain("Stall warning: the last 1 turn");

    bodies = stubScript([{ tool: "fs_list", args: { path: "/w" } }, "listed it"]);
    await run("list again");
    bodies = stubScript([Q, Q]);
    await run("and again");
    expect(sysOf(bodies)).not.toContain("Stall warning");
  });
});

describe("useAgentTurn reasoning stream", () => {
  it("renders a live thinking frame and keeps it out of the final answer", async () => {
    let holder: ReturnType<typeof setup> | null = null;
    const frames: string[] = [];
    // Synchronous rAF that records each published stream frame.
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      const msgs = holder?.wsOf().messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last?.id === "stream") frames.push(last.content);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    stubFetch(() =>
      sse([
        { choices: [{ delta: { reasoning_content: "let me check the files " } }] },
        { choices: [{ delta: { reasoning_content: "before answering" } }] },
        { choices: [{ delta: { content: "answer" } }] },
        { usage: { prompt_tokens: 20, completion_tokens: 10 } },
      ]),
    );
    setInvokeImpl(async () => ({}));
    const h = setup();
    holder = h;
    await act(async () => {
      await h.result.current.runAgentTurn("go");
    });
    // A frame is published during the reasoning phase - before any answer
    // text exists. Without that, the transcript sits frozen (the live bug).
    expect(frames.some((f) => f.includes("⏺ thinking") && !f.includes("answer"))).toBe(true);
    // ...and the persisted answer is content-only, with no thinking tail.
    expect(h.wsOf().messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["assistant", "answer"],
    ]);
  });
});

// Replay of the messy long turn that broke in live use: 30 messages of prior
// history, 10 tool rounds with parallel calls, a repeated call (repeat nudge),
// a transient provider 500 mid-turn, and reasoning deltas throughout. Each
// assertion pins one regression class found in live debugging.
describe("useAgentTurn long-turn integration", () => {
  it("keeps the task, isolates nudges, retries the 500 and streams thinking", async () => {
    const history: ChatMsg[] = [];
    for (let i = 0; i < 15; i++) {
      history.push({ id: `h${i}u`, role: "user", content: `earlier question ${i}` });
      history.push({ id: `h${i}a`, role: "assistant", content: `earlier answer ${i}` });
    }
    const TASK = "audit the workspace layout";
    const FINAL = "COMPLETE: reviewed the workspace across ten rounds.";
    let fetches = 0;
    let served = 0;
    let injected500 = false;
    const bodies: any[] = [];
    stubFetch((_url: string, init: any) => {
      fetches++;
      bodies.push(JSON.parse(init.body));
      if (fetches === 5 && !injected500) {
        // Transient llama.cpp template hiccup mid-turn: must be retried.
        injected500 = true;
        return json({ error: { message: "Jinja Exception: No messages provided." } }, 500);
      }
      served++;
      if (served <= 10) {
        // Round 2 repeats round 1's first call -> repeat nudge must fire.
        const first = served === 2 ? "/w/d1a" : `/w/d${served}a`;
        return sseToolRound(`round ${served}: weighing targets. `, [
          { id: `a${served}`, path: first },
          { id: `b${served}`, path: `/w/d${served}b` },
        ]);
      }
      return sse([{ choices: [{ delta: { content: FINAL } }] }, { usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
    });
    const frames: string[] = [];
    let holder: ReturnType<typeof setup> | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      const msgs = holder?.wsOf().messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last?.id === "stream") frames.push(last.content);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    setInvokeImpl(async () => []);
    const h = setup({ history });
    holder = h;
    await act(async () => {
      await h.result.current.runAgentTurn(TASK);
    });

    // 1. Final message is content-only: no thinking tail, no nudge text.
    const msgs = h.wsOf().messages.filter((m) => m.id !== "stream");
    const final = msgs[msgs.length - 1];
    expect(final.role).toBe("assistant");
    expect(final.content).toBe(FINAL);

    // 2. Inline tool cards captured every executed call (2 per round).
    expect(final.tools).toHaveLength(20);

    // 3. Every outbound request still carries this turn's request. With 30
    //    history messages + 20+ appended round messages the window trims hard;
    //    losing the task here is exactly the live "no task was given" bug.
    for (const b of bodies) {
      expect(b.messages.some((m: any) => m.role === "user" && m.content === TASK)).toBe(true);
    }

    // 4. Nudges never travel as user turns...
    for (const b of bodies) {
      const leaked = b.messages.filter(
        (m: any) => m.role === "user" && /system nudge|You repeated/.test(m.content ?? ""),
      );
      expect(leaked).toHaveLength(0);
    }
    // 5. ...and the repeat nudge did land inside a tool result.
    expect(
      bodies.some((b) =>
        b.messages.some((m: any) => m.role === "tool" && (m.content ?? "").includes("[system nudge]")),
      ),
    ).toBe(true);

    // 6. The transient 500 was retried once, not fatal (11 rounds + 1 retry).
    expect(injected500).toBe(true);
    expect(bodies.length).toBe(12);

    // 7. Reasoning streamed live during its phase, before the answer existed.
    expect(frames.some((f) => f.includes("⏺ thinking") && !f.includes(FINAL))).toBe(true);

    // 8. Audit complete and the turn closed cleanly.
    expect(h.audits).toHaveLength(20);
    expect(h.audits.every((a) => a.ok)).toBe(true);
    expect(h.busy).toEqual([true, false]);
    expect(h.turnAbort.current).toBeNull();
  });
});
