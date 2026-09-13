// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProvider } from "./useProvider";
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup() {
  let ws: Workspace = newWorkspace("main:ws", "/w");
  const hook = renderHook(() =>
    useProvider({
      ws,
      updateWs: (fn) => {
        ws = fn(ws);
      },
    }),
  );
  return { ...hook, wsOf: () => ws };
}

describe("useProvider per-window config", () => {
  it("reads the window's own config and patches it", () => {
    const { result, wsOf } = setup();
    expect(result.current.editCfg.model).toBe("qwen2.5-coder:7b");
    act(() => {
      result.current.setEditCfg({ model: "new-model" });
    });
    expect(wsOf().provider.model).toBe("new-model");
  });
});

describe("useProvider keychain", () => {
  it("fills the key from the OS store and migrates plaintext history", async () => {
    vi.useFakeTimers();
    const keySets: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_get") return "K-SECRET";
      if (cmd === "key_set") {
        keySets.push(args);
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    localStorage.setItem(
      "vtai.providerHistory",
      JSON.stringify([{ baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", apiKey: "PLAIN", kind: "auto" }]),
    );
    const { result, wsOf } = setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.keychainOk).toBe(true);
    expect(wsOf().provider.apiKey).toBe("K-SECRET");
    expect(keySets).toContainEqual(
      expect.objectContaining({ baseUrl: "http://localhost:11434/v1", secret: "PLAIN" }),
    );
    expect(result.current.provHist[0].apiKey).toBe("");
  });

  it("falls back to local storage without a credential store", async () => {
    vi.useFakeTimers();
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_get") throw new Error("no daemon");
      if (cmd === "key_set") throw new Error("no daemon");
      return {};
    });
    const { result } = setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.keychainOk).toBe(false);
  });

  it("rememberProvider mirrors keys and records history", () => {
    const keySets: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_set") {
        keySets.push(args);
        return {};
      }
      return "";
    });
    const { result } = setup();
    act(() => {
      result.current.rememberProvider({ baseUrl: "https://x.test", model: "m", apiKey: "S", kind: "auto" });
    });
    expect(keySets).toEqual([{ baseUrl: "https://x.test", model: "m", secret: "S" }]);
    // No keychain yet: the key stays in local history so reloads keep working.
    expect(result.current.provHist[0]).toMatchObject({ baseUrl: "https://x.test", apiKey: "S" });
    const saved = JSON.parse(localStorage.getItem("vtai.providerHistory") ?? "[]");
    expect(saved[0].baseUrl).toBe("https://x.test");
  });
});

describe("useProvider key loss", () => {
  it("stale empty turn-end mirrors never delete the saved key", () => {
    const keySets: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_set") {
        keySets.push(args);
        return {};
      }
      if (cmd === "key_get") return "";
      return "";
    });
    localStorage.setItem(
      "vtai.providerHistory",
      JSON.stringify([{ baseUrl: "https://a.test", model: "m", apiKey: "K", kind: "auto" }]),
    );
    const { result } = setup();
    act(() => {
      // Stale copy from before an endpoint switch: empty key, no clear intent.
      result.current.rememberProvider({ baseUrl: "https://a.test", model: "m", apiKey: "", kind: "auto" });
    });
    expect(keySets).toEqual([]);
    expect(result.current.provHist).toEqual([
      { baseUrl: "https://a.test", model: "m", apiKey: "K", kind: "auto" },
    ]);
  });

  it("explicit clears propagate the deletion on the next turn", () => {
    const keySets: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_set") {
        keySets.push(args);
        return {};
      }
      if (cmd === "key_get") return "";
      return "";
    });
    localStorage.setItem(
      "vtai.providerHistory",
      JSON.stringify([
        { baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", apiKey: "K", kind: "auto" },
      ]),
    );
    const { result } = setup();
    act(() => {
      result.current.setEditCfg({ apiKey: "K2" });
    });
    act(() => {
      result.current.setEditCfg({ apiKey: "" });
    });
    act(() => {
      result.current.rememberProvider({
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5-coder:7b",
        apiKey: "",
        kind: "auto",
      });
    });
    expect(keySets).toContainEqual({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5-coder:7b",
      secret: "",
    });
    expect(result.current.provHist[0]).toMatchObject({ apiKey: "" });
  });

  it("survives endpoint flips without a keychain via per-pair backups", async () => {
    vi.useFakeTimers();
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_get") throw new Error("no daemon");
      if (cmd === "key_set") throw new Error("no daemon");
      return {};
    });
    const h = setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    act(() => {
      h.result.current.setEditCfg({ apiKey: "K-LOCAL" });
      h.rerender();
    });
    expect(h.wsOf().provider.apiKey).toBe("K-LOCAL");
    act(() => {
      h.result.current.setEditCfg({ model: "other" });
      h.rerender();
    });
    expect(h.wsOf().provider.apiKey).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(h.wsOf().provider.apiKey).toBe("");
    act(() => {
      h.result.current.setEditCfg({ model: "qwen2.5-coder:7b" });
      h.rerender();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(h.wsOf().provider.apiKey).toBe("K-LOCAL");
  });
});

describe("useProvider.refreshModels", () => {
  it("lists what the endpoint actually serves", async () => {
    vi.stubGlobal(
      "fetch",
      async (url: string) =>
        String(url).endsWith("/models")
          ? new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
              headers: { "content-type": "application/json" },
            })
          : new Response("{}", { status: 404 }),
    );
    const { result } = setup();
    await act(async () => {
      await result.current.refreshModels();
    });
    expect(result.current.provModels).toEqual(["a", "b"]);
    expect(result.current.modelsNote).toMatch(/2 models/);
  });
});

describe("useProvider draft persistence", () => {
  it("keeps the key in the local draft when no keychain exists, and refills it on reload", async () => {
    vi.useFakeTimers();
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_get") throw new Error("no daemon");
      return {};
    });
    const h1 = setup();
    act(() => {
      h1.result.current.setEditCfg({ apiKey: "sk-local" });
      h1.rerender();
    });
    const draft = JSON.parse(localStorage.getItem("vtai.providerDraft") ?? "{}");
    expect(Object.values(draft)[0]).toMatchObject({ apiKey: "sk-local" });

    // Simulate restart: fresh window, session-stripped key, no keychain.
    let ws2: Workspace = newWorkspace("main:ws", "/w", {
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "qwen2.5-coder:7b",
      kind: "auto",
    });
    renderHook(() => useProvider({ ws: ws2, updateWs: (fn) => { ws2 = fn(ws2); } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ws2.provider.apiKey).toBe("sk-local");
  });

  it("does not duplicate the key into the draft when the keychain works", async () => {
    vi.useFakeTimers();
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_get") return "K";
      return {};
    });
    const { result, wsOf } = setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.keychainOk).toBe(true);
    act(() => {
      result.current.setEditCfg({ apiKey: "typed" });
    });
    const draft = JSON.parse(localStorage.getItem("vtai.providerDraft") ?? "{}");
    expect(Object.values(draft)[0]).toMatchObject({ apiKey: "" });
    void wsOf;
  });
});

describe("useProvider key mirroring", () => {
  it("writes the key to the keychain immediately on edit", () => {
    const keySets: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_set") {
        keySets.push(args);
        return {};
      }
      return "";
    });
    const { result } = setup();
    act(() => {
      result.current.setEditCfg({ apiKey: "sk-immediate" });
    });
    expect(keySets).toEqual([
      {
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5-coder:7b",
        secret: "sk-immediate",
      },
    ]);
  });

  it("switching model clears the key, then refills from the keychain for the new pair", async () => {
    vi.useFakeTimers();
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_get") return args.model === "big" ? "K-BIG" : "";
      return {};
    });
    let ws: Workspace = newWorkspace("main:ws", "/w", {
      baseUrl: "https://api.test",
      apiKey: "K-BIG",
      model: "big",
      kind: "auto",
    });
    const { result, rerender } = renderHook(() =>
      useProvider({ ws, updateWs: (fn) => { ws = fn(ws); } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ws.provider.apiKey).toBe("K-BIG");
    act(() => {
      result.current.setEditCfg({ model: "small" });
      rerender();
    });
    expect(ws.provider.apiKey).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // "small" has no stored key -> stays empty; switch back -> refilled.
    expect(ws.provider.apiKey).toBe("");
    act(() => {
      result.current.setEditCfg({ model: "big" });
      rerender();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ws.provider.apiKey).toBe("K-BIG");
  });
});
