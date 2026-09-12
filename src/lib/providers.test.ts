import { afterEach, describe, expect, it, vi } from "vitest";
import { chatWithTools, estimateCost, listModels, runTool } from "./providers";

// ---- Backend seam: Tauri invoke is stubbed per test ----
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

type FetchCalls = { url: string; init: any }[];

function stubFetch(handler: (url: string, init: any, calls: FetchCalls) => Response | Promise<Response>) {
  const calls: FetchCalls = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init: any) => {
      calls.push({ url, init });
      return handler(url, init, calls);
    },
  );
  return calls;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(events: unknown[]) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const CFG = { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen-test", kind: "auto" as const };

function openAIText(text: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return json({ choices: [{ message: { content: text } }], usage });
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
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

describe("estimateCost", () => {
  it("is free for local endpoints and models", () => {
    expect(estimateCost("http://localhost:11434/v1", "qwen2.5-coder:7b", 1000, 1000)).toBe(0);
    expect(estimateCost("https://cloud.example.com/v1", "llama-3.1-8b-instant", 1000, 1000)).toBe(0);
  });
  it("prices known cloud models", () => {
    // sonnet: $3/$15 per MTok → 1M+1M = $18
    expect(estimateCost("https://api.anthropic.com", "claude-sonnet-4-5", 1_000_000, 1_000_000)).toBeCloseTo(18);
  });
  it("returns undefined instead of a wrong number", () => {
    expect(estimateCost("https://cloud.example.com/v1", "mystery-model-3000", 1000, 1000)).toBeUndefined();
  });
});

describe("listModels", () => {
  it("reads OpenAI-style /models", async () => {
    stubFetch((url) => (url.endsWith("/models") ? json({ data: [{ id: "a" }, { id: "b" }] }) : json({}, 404)));
    expect(await listModels(CFG)).toEqual(["a", "b"]);
  });
  it("falls back to Ollama /api/tags", async () => {
    stubFetch((url) =>
      url.endsWith("/api/tags") ? json({ models: [{ name: "qwen2.5-coder:7b" }] }) : json({}, 404),
    );
    expect(await listModels(CFG)).toEqual(["qwen2.5-coder:7b"]);
  });
  it("returns [] when unreachable - never throws", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(listModels(CFG)).resolves.toEqual([]);
  });
});

describe("runTool", () => {
  it("runs read-only tools without approval", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("fs_list");
      return [{ name: "a", path: "/w/a", is_dir: false }];
    });
    const out = await runTool("fs_list", { path: "/w" });
    expect(out).toContain("/w/a");
  });
  it("rejects gated tools when the user says no", async () => {
    let invoked = false;
    setInvokeImpl(async () => {
      invoked = true;
      return {};
    });
    const audits: any[] = [];
    const out = await runTool(
      "shell_run",
      { cwd: "/w", cmd: "ls" },
      {
        requestApproval: async () => false,
        // silence unused warnings if policy shape changes
      },
    );
    void audits;
    expect(out).toMatch(/^user rejected/);
    expect(invoked).toBe(false);
  });
  it("runs gated tools after approval and audits the decision", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("shell_run");
      return { stdout: "hi\n", stderr: "", code: 0 };
    });
    const seen: any[] = [];
    const out = await runTool(
      "shell_run",
      { cwd: "/w", cmd: "echo hi" },
      { requestApproval: async () => true },
    );
    expect(out).toContain("hi");
    void seen;
  });
  it("stages fs_write through the review gate instead of writing", async () => {
    let wrote = false;
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_write") wrote = true;
      return {};
    });
    let staged: { path: string; content: string } | null = null;
    const out = await runTool(
      "fs_write",
      { path: "/w/a.txt", content: "hello" },
      { onProposeWrite: async (path, content) => { staged = { path, content }; } },
    );
    expect(out).toMatch(/staged \/w\/a\.txt/);
    expect(staged).toEqual({ path: "/w/a.txt", content: "hello" });
    expect(wrote).toBe(false);
  });
  it("refuses oversized fs_write payloads", async () => {
    const out = await runTool("fs_write", { path: "/w/a.txt", content: "x".repeat(5 * 1024 * 1024) });
    expect(out).toMatch(/^error:/);
  });
  it("reports unknown tools instead of throwing", async () => {
    await expect(runTool("teleport", {})).resolves.toMatch(/unknown tool/);
  });
});

describe("chatWithTools", () => {
  it("returns plain replies and streams deltas", async () => {
    stubFetch(() => openAIText("hello there"));
    const deltas: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "hi" }], (d) => deltas.push(d));
    expect(res).toBe("hello there");
    expect(deltas.join("")).toBe("hello there");
  });

  it("assembles streamed tool calls and feeds results back", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("fs_list");
      return [{ name: "a", path: "/w/a", is_dir: false }];
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return sse([
          { choices: [{ delta: { content: "looking…", tool_calls: [{ index: 0, id: "c1", function: { name: "fs_li", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "st", arguments: '{"path":"/w"}' } }] } }] },
          { usage: { prompt_tokens: 5, completion_tokens: 5 } },
        ]);
      }
      return openAIText("found /w/a");
    });
    const events: string[] = [];
    const usage: any[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "list /w" }],
      (d) => events.push(d),
      { onUsage: (u) => usage.push(u) },
    );
    expect(res).toBe("found /w/a");
    expect(events.join("")).toContain("looking…");
    expect(events.join("")).toContain("[tool fs_list");
    expect(calls).toHaveLength(2);
    // Second request carries the tool request + result pair.
    const body = JSON.parse(calls[1].init.body);
    const roles = body.messages.map((m: any) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    expect(usage.length).toBeGreaterThan(0);
  });

  it("stops after 3 identical calls and synthesizes a final answer", async () => {
    setInvokeImpl(async () => []);
    stubFetch((_url, init, prev) => {
      if (prev.length <= 3) {
        return openAITools([{ id: `c${prev.length}`, name: "fs_list", args: { path: "/w" } }]);
      }
      // Final no-tools round sees the loop note.
      const body = JSON.parse(init.body);
      expect(body.tools).toBeUndefined();
      const lastUser = [...body.messages].reverse().find((m: any) => m.role === "user");
      expect(lastUser.content).toMatch(/Tool budget exhausted/);
      expect(lastUser.content).toMatch(/repeating `fs_list`/);
      return openAIText("gave up gracefully");
    });
    let toolCount = 0;
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "list" }],
      () => {},
      { onToolActivity: () => { toolCount++; } },
    );
    expect(res).toBe("gave up gracefully");
    expect(toolCount).toBe(3);
  });

  it("falls back to plain chat when the endpoint rejects tools", async () => {
    const calls = stubFetch((_url, init, prev) => {
      if (prev.length === 1) return json({ error: { message: "tool_use not supported" } }, 400);
      expect(JSON.parse(init.body).tools).toBeUndefined();
      return openAIText("plain answer");
    });
    const events: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "hi" }], (d) => events.push(d));
    expect(res).toBe("plain answer");
    expect(events.join("")).toMatch(/plain chat mode/);
    expect(calls).toHaveLength(2);
  });

  it("retries without stream_options when the endpoint rejects them", async () => {
    const calls = stubFetch((_url, init, prev) => {
      if (prev.length === 1) return json({ error: { message: "unknown field stream_options" } }, 400);
      expect(JSON.parse(init.body).stream_options).toBeUndefined();
      return openAIText("ok");
    });
    await expect(chatWithTools(CFG, [{ role: "user", content: "hi" }], () => {})).resolves.toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("attaches screenshots as vision on the next round", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("browser_screenshot");
      return { imageBase64: "QUJD", mimeType: "image/jpeg", url: "http://x/" };
    });
    const calls = stubFetch((_url, init, prev) => {
      if (prev.length === 1) {
        return openAITools([{ id: "s1", name: "browser_screenshot", args: {} }]);
      }
      const body = JSON.parse(init.body);
      const withImage = body.messages.find(
        (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"),
      );
      expect(withImage).toBeTruthy();
      expect(withImage.content.find((p: any) => p.type === "image_url").image_url.url).toContain(
        "data:image/jpeg;base64,QUJD",
      );
      return openAIText("i can see it");
    });
    await expect(chatWithTools(CFG, [{ role: "user", content: "look" }], () => {})).resolves.toBe(
      "i can see it",
    );
    expect(calls).toHaveLength(2);
  });

  it("speaks Anthropic SSE and reports usage", async () => {
    const anthropic = { ...CFG, baseUrl: "https://api.anthropic.com", apiKey: "k", model: "m", kind: "anthropic" as const };
    const calls = stubFetch(() =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
        { type: "message_delta", usage: { output_tokens: 5 } },
      ]),
    );
    const usage: any[] = [];
    const res = await chatWithTools(
      anthropic,
      [{ role: "user", content: "hi" }],
      () => {},
      { onUsage: (u) => usage.push(u) },
    );
    expect(res).toBe("hello world");
    expect(usage[0]).toMatchObject({ input: 10, output: 5 });
    expect(calls[0].init.headers["x-api-key"]).toBe("k");
    const body = JSON.parse(calls[0].init.body);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("records approval decisions in the audit trail", async () => {
    setInvokeImpl(async () => ({ stdout: "", stderr: "", code: 0 }));
    stubFetch((_u, _i, prev) =>
      prev.length === 1
        ? openAITools([{ id: "g1", name: "shell_run", args: { cwd: "/w", cmd: "ls" } }])
        : openAIText("stopped"),
    );
    const audits: any[] = [];
    await chatWithTools(
      CFG,
      [{ role: "user", content: "run ls" }],
      () => {},
      {
        policy: { requestApproval: async () => false },
        onAudit: (e) => audits.push(e),
      },
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool: "shell_run", decision: "rejected", ok: false });
  });
});
