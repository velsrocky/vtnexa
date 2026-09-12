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
