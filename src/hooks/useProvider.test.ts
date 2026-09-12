// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProvider } from "./useProvider";
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup(lane?: Lane) {
  const updated: { id: string; fn: (l: Lane) => Lane }[] = [];
  const base = lane ?? newLane("L", "/w");
  const hook = renderHook(() =>
    useProvider({
      lane: base,
      updateLane: (id, fn) => updated.push({ id, fn }),
    }),
  );
  return { ...hook, updated, lane: base };
}

function applyUpdates(updated: { id: string; fn: (l: Lane) => Lane }[], lane: Lane): Lane {
  return updated.reduce((l, u) => (u.id === lane.id ? u.fn(l) : l), lane);
}

describe("useProvider per-lane config", () => {
  it("reads the lane's own config and patches only that lane", () => {
    const { result, updated, lane } = setup();
    expect(result.current.editCfg.model).toBe("qwen2.5-coder:7b");
    act(() => {
      result.current.setEditCfg({ model: "new-model" });
    });
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(lane.id);
    expect(applyUpdates(updated, lane).provider.model).toBe("new-model");
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
    const { result, updated, lane } = setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.keychainOk).toBe(true);
    expect(applyUpdates(updated, lane).provider.apiKey).toBe("K-SECRET");
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

describe("useProvider lane isolation", () => {
  it("edits never address another lane", () => {
    const { result, updated, lane } = setup();
    act(() => {
      result.current.setEditCfg({ baseUrl: "https://other.test", model: "m2" });
    });
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(lane.id);
    const patched = applyUpdates(updated, lane);
    expect(patched.provider).toMatchObject({ baseUrl: "https://other.test", model: "m2" });
  });
});
