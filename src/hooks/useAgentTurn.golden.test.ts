// @vitest-environment jsdom
// Golden conversation: the reference good-behavior transcript (strong model,
// ffmpeg task). Shape locked in:
//   greeting -> zero tools | run -> approved shell, stdout surfaced |
//   fix -> staged to Diff gate, never direct-written | re-run -> grounded.
// Guards cut both ways: future prompt/detector changes must neither break
// this flow NOR start firing repairs on these good replies.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentTurn } from "./useAgentTurn";
import { announcesToolAction, deniesCapability, narratesBareToolCall } from "../lib/providers";
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
  vi.unstubAllGlobals();
  localStorage.clear();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function openAIText(text: string) {
  return json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
}

function openAITools(calls: { id: string; name: string; args: unknown }[]) {
  return json({
    choices: [
      {
        message: {
          content: "",
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  });
}

function stubRafSync() {
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

function setupGolden() {
  let ws: Workspace = newWorkspace("main:ws", "/w");
  const audits: any[] = [];
  const centerTabs: string[] = [];
  const invoked: string[] = [];
  setInvokeImpl(async (cmd) => {
    invoked.push(cmd);
    // Native dialog confirmed (mocked): issue a token like the backend would.
    if (cmd === "approval_issue" || cmd === "approval_claim") return "tok-test";
    if (cmd === "fs_read") return "old content";
    if (cmd === "shell_run") return { stdout: "FFmpeg is installed.\n", stderr: "", code: 0 };
    return {};
  });
  const hook = renderHook(() =>
    useAgentTurn({
      ws,
      workspaceRoot: "/w",
      conventions: "",
      conventionsName: "",
      skills: [],
      provHistLength: 1,
      busy: false,
      turnAbort: { current: null } as any,
      stopTurnIdRef: { current: "" } as any,
      streamRaf: { current: null } as any,
      stickBottom: { current: true },
      lastSynced: { current: { pad: "", plan: "", memory: "" } },
      updateWs: (fn) => {
        ws = fn(ws);
      },
      setBusy: () => {},
      logAudit: (e) => audits.push(e),
      rememberProvider: () => {},
      // Golden flow approves every gated tool: the mocked approval_issue
      // above returns a token, like a confirmed native dialog.
      setCenterTab: ((t: string) => centerTabs.push(t)) as any,
      setPadText: vi.fn(),
      setPlanText: vi.fn(),
      setMemoryText: vi.fn(),
      setNexaState: vi.fn(),
      setShowJump: vi.fn(),
      flushStreamFrame: vi.fn(),
    }),
  );
  return { ...hook, wsOf: () => ws, audits, centerTabs, invoked };
}

describe("golden: greeting needs no tools", () => {
  it("answers in one round, zero tool activity", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches++;
      return openAIText("Hi! What would you like to work on in this workspace?");
    });
    stubRafSync();
    const h = setupGolden();
    await act(async () => {
      await h.result.current.runAgentTurn("hi");
    });
    expect(fetches).toBe(1);
    expect(h.audits).toEqual([]);
    expect(h.wsOf().messages).toHaveLength(2);
    expect(h.wsOf().pendingDiff).toBeNull();
  });
});

describe("golden: approved run surfaces real stdout", () => {
  it("executes shell_run on approval and quotes the output", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1) {
        return openAITools([{ id: "s1", name: "shell_run", args: { cwd: "/w", cmd: "python3 check_ffmpeg.py" } }]);
      }
      return openAIText("Ran clean (exit 0). FFmpeg is installed.");
    });
    stubRafSync();
    const h = setupGolden();
    await act(async () => {
      await h.result.current.runAgentTurn("run it");
    });
    expect(h.invoked).toContain("shell_run");
    expect(h.audits).toMatchObject([{ tool: "shell_run", decision: "approved", ok: true }]);
    const last = h.wsOf().messages[h.wsOf().messages.length - 1];
    expect(last.content).toMatch(/FFmpeg is installed/);
  });
});

describe("golden: fix stages to the gate, never direct-writes", () => {
  it("proposes the write and opens the diff tab", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1) {
        return openAITools([
          { id: "w1", name: "fs_write", args: { path: "/w/check_ffmpeg.py", content: "new content" } },
        ]);
      }
      return openAIText("Staged to the Diff review gate - approve it to apply.");
    });
    stubRafSync();
    const h = setupGolden();
    await act(async () => {
      await h.result.current.runAgentTurn("fix it");
    });
    expect(h.wsOf().pendingDiff).toEqual({
      path: "/w/check_ffmpeg.py",
      content: "new content",
      original: "old content",
    });
    expect(h.centerTabs).toEqual(["diff"]);
    // Staged, NOT written: the backend fs_write command must never fire.
    expect(h.invoked).not.toContain("fs_write");
  });
});

describe("golden: good replies never trip repairs", () => {
  it("no detector fires on the reference answers", () => {
    const replies = [
      "Hi! What would you like to work on in this workspace?",
      "Current working directory: /home/velsrocky/projects/test/qwen2.5",
      "Ran clean (exit 0). Result: FFmpeg is installed.",
      "Staged to the Diff review gate - approve it to apply.",
      "Output is now just FFmpeg is installed. - clean, exit 0, no version banner.",
    ];
    for (const r of replies) {
      expect(announcesToolAction(r)).toBeNull();
      expect(narratesBareToolCall(r)).toBeNull();
      expect(deniesCapability(r)).toBe(false);
    }
  });
});
