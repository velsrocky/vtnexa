// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessions } from "./useSessions";
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

function setup(initial?: Partial<Workspace>) {
  let ws: Workspace = { ...newWorkspace("main:ws", "/w"), ...initial };
  const hook = renderHook(() =>
    useSessions({
      ws,
      workspaceRoot: "/w",
      setWs: ((u: any) => {
        ws = typeof u === "function" ? u(ws) : u;
      }) as any,
      setCwdState: vi.fn(),
      setOpenPath: vi.fn(),
      note: vi.fn(),
    }),
  );
  return { ...hook, wsOf: () => ws };
}

const META = [
  { id: "ses_b", title: "Second", directory: "/w", created: 2, updated: 200, message_count: 3, preview: "b" },
  { id: "ses_a", title: "First", directory: "/w", created: 1, updated: 100, message_count: 1, preview: "a" },
];

describe("useSessions boot", () => {
  it("always starts fresh and lists previous sessions newest-first", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "sessions_list") return JSON.stringify(META);
      if (cmd === "session_put") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup({ messages: [{ id: "old", role: "user", content: "stale" }] });
    await act(async () => {
      await h.result.current.bootFresh("/w", "/w");
    });
    // Fresh chat even though the previous ws had messages.
    expect(h.wsOf().messages).toEqual([]);
    expect(h.result.current.sessions.map((s) => s.id)).toEqual(["ses_b", "ses_a"]);
    expect(h.result.current.currentTitle).toBe("New session");
    expect(h.result.current.sessionsReady.current).toBe(true);
  });
});

describe("useSessions.persistCurrent", () => {
  it("skips empty sessions and strips nothing else", async () => {
    const puts: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "sessions_list") return "[]";
      if (cmd === "session_put") {
        puts.push(args);
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await act(async () => {
      await h.result.current.bootFresh("/w", "/w");
    });
    // Empty: no write.
    await act(async () => {
      await h.result.current.persistCurrent();
    });
    expect(puts).toHaveLength(0);
    // Non-empty: writes one version-8 file for the current id.
    const withMsg: Workspace = {
      ...h.wsOf(),
      messages: [{ id: "u1", role: "user", content: "hello world" }],
    };
    await act(async () => {
      await h.result.current.persistCurrent(withMsg);
    });
    expect(puts).toHaveLength(1);
    const file = JSON.parse(puts[0].content);
    expect(file).toMatchObject({ version: 8, title: "hello world", directory: "/w" });
    expect(file.workspace.messages).toEqual([{ id: "u1", role: "user", content: "hello world" }]);
  });
});

describe("useSessions resume/remove", () => {
  const FILE = {
    version: 8,
    id: "ses_a",
    title: "First",
    directory: "/w",
    created: 1,
    updated: 100,
    workspace: {
      ...newWorkspace("main:ws", "/w"),
      messages: [{ id: "m1", role: "user", content: "resumed!" }],
    },
  };

  it("resumeSession restores messages and tracks the id", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "sessions_list") return JSON.stringify(META);
      if (cmd === "session_get") return JSON.stringify(FILE);
      if (cmd === "session_put") return {};
      if (cmd === "key_get") return "";
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await act(async () => {
      await h.result.current.bootFresh("/w", "/w");
    });
    await act(async () => {
      await h.result.current.resumeSession("ses_a");
    });
    expect(h.wsOf().messages).toEqual([{ id: "m1", role: "user", content: "resumed!" }]);
    expect(h.result.current.currentId).toBe("ses_a");
    expect(h.result.current.currentTitle).toBe("First");
  });

  it("resumeSession refills the key from the local backup without a keychain", async () => {
    localStorage.clear();
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({
        main: {
          baseUrl: "http://localhost:11434/v1",
          model: "qwen2.5-coder:7b",
          kind: "auto",
          apiKey: "",
          keys: { "http://localhost:11434/v1|qwen2.5-coder:7b": "K-BACKUP" },
        },
      }),
    );
    const keyless = {
      ...FILE,
      workspace: { ...newWorkspace("main:ws", "/w"), messages: [] },
    };
    setInvokeImpl(async (cmd) => {
      if (cmd === "sessions_list") return JSON.stringify(META);
      if (cmd === "session_get") return JSON.stringify(keyless);
      if (cmd === "session_put") return {};
      if (cmd === "key_get") throw new Error("no daemon");
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await act(async () => {
      await h.result.current.bootFresh("/w", "/w");
    });
    await act(async () => {
      await h.result.current.resumeSession("ses_a");
    });
    expect(h.wsOf().provider.apiKey).toBe("K-BACKUP");
    localStorage.clear();
  });

  it("removeSession deletes the file and fresh-starts when current", async () => {
    const deleted: string[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "sessions_list") return JSON.stringify(META);
      if (cmd === "session_get") return JSON.stringify(FILE);
      if (cmd === "session_put") return {};
      if (cmd === "session_delete") {
        deleted.push(args.id);
        return {};
      }
      if (cmd === "key_get") return "";
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await act(async () => {
      await h.result.current.bootFresh("/w", "/w");
    });
    await act(async () => {
      await h.result.current.resumeSession("ses_a");
    });
    const before = h.result.current.currentId;
    await act(async () => {
      await h.result.current.removeSession("ses_a");
    });
    expect(deleted).toEqual(["ses_a"]);
    expect(h.result.current.currentId).not.toBe(before);
    expect(h.wsOf().messages).toEqual([]);
    void before;
  });
});
