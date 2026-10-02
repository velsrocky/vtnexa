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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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

function setup(provider?: Workspace["provider"]) {
  let ws: Workspace = newWorkspace("main:ws", "/w", provider);
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

  it("rememberProvider records a keyless entry and mirrors the key", async () => {
    const keySets: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_set") {
        keySets.push(args);
        return {};
      }
      return "";
    });
    const { result } = setup();
    await act(async () => {
      result.current.rememberProvider({ baseUrl: "https://x.test", model: "m", apiKey: "S", kind: "auto" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(keySets).toEqual([{ baseUrl: "https://x.test", model: "m", secret: "S" }]);
    expect(result.current.provHist[0]).toMatchObject({ baseUrl: "https://x.test", apiKey: "" });
    const saved = JSON.parse(localStorage.getItem("vtai.providerHistory") ?? "[]");
    expect(saved[0].baseUrl).toBe("https://x.test");
    expect(JSON.stringify(saved)).not.toContain("S");
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

  it("explicit clears cancel pending writes and persist only the deletion", async () => {
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
      result.current.setEditCfg({ apiKey: "" });
      result.current.rememberProvider({
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5-coder:7b",
        apiKey: "",
        kind: "auto",
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(keySets).toEqual([
      {
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5-coder:7b",
        secret: "",
      },
    ]);
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
    await advance(300);
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
      if (cmd === "key_get" || cmd === "key_set") throw new Error("no daemon");
      return {};
    });
    const h1 = setup();
    act(() => {
      h1.result.current.setEditCfg({ apiKey: "sk-local" });
      h1.rerender();
    });
    expect(localStorage.getItem("vtai.providerDraft") ?? "").not.toContain("sk-local");
    await advance(300);
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
    expect(localStorage.getItem("vtai.providerDraft") ?? "").not.toContain("typed");
    await advance(300);
    const draft = JSON.parse(localStorage.getItem("vtai.providerDraft") ?? "{}");
    expect(Object.values(draft)[0]).toMatchObject({ apiKey: "" });
    expect(JSON.stringify(draft)).not.toContain("typed");
    void wsOf;
  });
});

describe("useProvider key mirroring", () => {
  it("writes a debounced key edit to the keychain", async () => {
    vi.useFakeTimers();
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
      result.current.setEditCfg({ apiKey: "sk-debounced" });
    });
    expect(keySets).toEqual([]);
    await advance(300);
    expect(keySets).toEqual([
      {
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5-coder:7b",
        secret: "sk-debounced",
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

describe("useProvider credential persistence", () => {
  it("purges confirmed key material from the draft and matching history pair", async () => {
    vi.useFakeTimers();
    const baseUrl = "http://localhost:11434/v1";
    const model = "qwen2.5-coder:7b";
    localStorage.setItem(
      "vtai.providerHistory",
      JSON.stringify([
        { baseUrl, model, apiKey: "OLD-HISTORY", kind: "auto" },
        { baseUrl: "https://other.test", model: "other", apiKey: "OTHER-HISTORY", kind: "auto" },
      ]),
    );
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({
        main: {
          baseUrl,
          model,
          apiKey: "OLD-DRAFT",
          keys: { [`${baseUrl}|${model}`]: "OLD-DRAFT", "https://other.test|other": "OTHER-DRAFT" },
        },
      }),
    );
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_set") return {};
      return "";
    });
    const { result, wsOf } = setup();
    act(() => {
      result.current.setEditCfg({ apiKey: "CONFIRMED" });
    });
    expect(localStorage.getItem("vtai.providerDraft") ?? "").not.toContain("CONFIRMED");
    expect(localStorage.getItem("vtai.providerHistory") ?? "").not.toContain("CONFIRMED");
    await advance(300);
    expect(result.current.keychainOk).toBe(true);
    expect(wsOf().provider.apiKey).toBe("CONFIRMED");
    const history = JSON.parse(localStorage.getItem("vtai.providerHistory") ?? "[]");
    const draft = JSON.parse(localStorage.getItem("vtai.providerDraft") ?? "{}").main;
    expect(history[0]).toMatchObject({ baseUrl, model, apiKey: "" });
    expect(history[1].apiKey).toBe("OTHER-HISTORY");
    expect(draft.apiKey).toBe("");
    expect(draft.keys).toEqual({ "https://other.test|other": "OTHER-DRAFT" });
  });

  it("persists a fallback only after the keySet fails", async () => {
    vi.useFakeTimers();
    const write = deferred<void>();
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_set") return write.promise;
      throw new Error("no daemon");
    });
    const { result } = setup();
    act(() => {
      result.current.setEditCfg({ apiKey: "FALLBACK" });
    });
    await advance(300);
    expect(result.current.keychainOk).toBeNull();
    expect(localStorage.getItem("vtai.providerDraft") ?? "").not.toContain("FALLBACK");
    await act(async () => {
      write.reject(new Error("keychain unavailable"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.keychainOk).toBe(false);
    expect(localStorage.getItem("vtai.providerDraft") ?? "").toContain("FALLBACK");
  });

  it("serializes rapid writes so the latest value is last", async () => {
    vi.useFakeTimers();
    const writes: Array<{ args: any; gate: ReturnType<typeof deferred<void>> }> = [];
    let stored = "";
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_set") {
        const gate = deferred<void>();
        writes.push({ args, gate });
        return gate.promise.then(() => {
          stored = args.secret;
        });
      }
      return "";
    });
    const { result } = setup();
    act(() => {
      result.current.setEditCfg({ apiKey: "sk-old" });
    });
    await advance(300);
    act(() => {
      result.current.setEditCfg({ apiKey: "sk-latest" });
    });
    await advance(300);
    expect(writes.map((write) => write.args.secret)).toEqual(["sk-old"]);
    await act(async () => {
      writes[0].gate.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stored).toBe("sk-old");
    expect(writes.map((write) => write.args.secret)).toEqual(["sk-old", "sk-latest"]);
    await act(async () => {
      writes[1].gate.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stored).toBe("sk-latest");
  });

  it("lets explicit clear win over an in-flight write and purges only its pair", async () => {
    vi.useFakeTimers();
    const baseUrl = "http://localhost:11434/v1";
    const model = "qwen2.5-coder:7b";
    const writes: Array<{ args: any; gate: ReturnType<typeof deferred<void>> }> = [];
    let stored = "OLD";
    localStorage.setItem(
      "vtai.providerHistory",
      JSON.stringify([
        { baseUrl, model, apiKey: "OLD-HISTORY", kind: "auto" },
        { baseUrl: "https://other.test", model: "other", apiKey: "OTHER-HISTORY", kind: "auto" },
      ]),
    );
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({
        main: {
          baseUrl,
          model,
          apiKey: "OLD-DRAFT",
          keys: { [`${baseUrl}|${model}`]: "OLD-DRAFT", "https://other.test|other": "OTHER-DRAFT" },
        },
      }),
    );
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_set") {
        const gate = deferred<void>();
        writes.push({ args, gate });
        return gate.promise.then(() => {
          stored = args.secret;
        });
      }
      return "";
    });
    const { result } = setup();
    act(() => {
      result.current.setEditCfg({ apiKey: "NEW" });
    });
    await advance(300);
    act(() => {
      result.current.setEditCfg({ apiKey: "" });
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("vtai.providerHistory") ?? "[]")[0].apiKey).toBe("");
    expect(JSON.parse(localStorage.getItem("vtai.providerDraft") ?? "{}").main.keys).toEqual({
      "https://other.test|other": "OTHER-DRAFT",
    });
    await act(async () => {
      writes[0].gate.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writes.map((write) => write.args.secret)).toEqual(["NEW", ""]);
    await act(async () => {
      writes[1].gate.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stored).toBe("");
    expect(JSON.parse(localStorage.getItem("vtai.providerHistory") ?? "[]")[1].apiKey).toBe("OTHER-HISTORY");
  });

  it("purges successful migration pairs and retains only failed plaintext", async () => {
    vi.useFakeTimers();
    const current = { baseUrl: "https://failed.test", model: "m" };
    const migrated = { baseUrl: "https://ok.test", model: "m" };
    const draftOnly = { baseUrl: "https://draft.test", model: "m" };
    const keychainWrites: any[] = [];
    localStorage.setItem(
      "vtai.providerHistory",
      JSON.stringify([
        { ...migrated, apiKey: "MIGRATED-HISTORY", kind: "auto" },
        { ...current, apiKey: "FAILED-HISTORY", kind: "auto" },
      ]),
    );
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({
        main: {
          ...current,
          apiKey: "FAILED-DRAFT",
          keys: {
            [`${migrated.baseUrl}|${migrated.model}`]: "MIGRATED-DRAFT",
            [`${current.baseUrl}|${current.model}`]: "FAILED-DRAFT",
            [`${draftOnly.baseUrl}|${draftOnly.model}`]: "DRAFT-ONLY",
          },
        },
      }),
    );
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "key_get") return "";
      if (cmd === "key_set") {
        keychainWrites.push(args);
        if (args.baseUrl === current.baseUrl) throw new Error("write failed");
        return {};
      }
      return "";
    });
    const { result } = setup({ ...current, apiKey: "", kind: "auto" });
    await advance(600);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(keychainWrites.map((write) => write.baseUrl)).toEqual([
      migrated.baseUrl,
      current.baseUrl,
      draftOnly.baseUrl,
    ]);
    const history = JSON.parse(localStorage.getItem("vtai.providerHistory") ?? "[]");
    const draft = JSON.parse(localStorage.getItem("vtai.providerDraft") ?? "{}").main;
    expect(history[0].apiKey).toBe("");
    expect(history[1].apiKey).toBe("FAILED-HISTORY");
    expect(draft.apiKey).toBe("FAILED-DRAFT");
    expect(draft.keys).toEqual({ [`${current.baseUrl}|${current.model}`]: "FAILED-DRAFT" });
    expect(result.current.keychainOk).toBe(false);
  });

  it("ignores a keychain result that resolves after an endpoint switch", async () => {
    vi.useFakeTimers();
    const probe = deferred<string>();
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_get") return probe.promise;
      return "";
    });
    const { result, wsOf } = setup();
    await advance(500);
    act(() => {
      result.current.setEditCfg({ model: "new-model" });
    });
    await act(async () => {
      probe.resolve("STALE-KEY");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(wsOf().provider.model).toBe("new-model");
    expect(wsOf().provider.apiKey).toBe("");
    expect(result.current.keychainOk).toBeNull();
  });

  it("does not apply a deferred write result after unmount", async () => {
    vi.useFakeTimers();
    const baseUrl = "http://localhost:11434/v1";
    const model = "qwen2.5-coder:7b";
    const write = deferred<void>();
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({
        main: {
          baseUrl,
          model,
          apiKey: "OLD-DRAFT",
          keys: { [`${baseUrl}|${model}`]: "OLD-DRAFT" },
        },
      }),
    );
    setInvokeImpl(async (cmd) => {
      if (cmd === "key_set") return write.promise;
      return "";
    });
    const hook = setup();
    act(() => {
      hook.result.current.setEditCfg({ apiKey: "UNMOUNTED" });
    });
    await advance(300);
    hook.unmount();
    await act(async () => {
      write.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    const draft = JSON.parse(localStorage.getItem("vtai.providerDraft") ?? "{}").main;
    expect(draft.apiKey).toBe("OLD-DRAFT");
    expect(draft.keys).toEqual({ [`${baseUrl}|${model}`]: "OLD-DRAFT" });
  });
});
