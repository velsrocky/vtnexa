import { afterEach, describe, expect, it, vi } from "vitest";
import { announcesToolAction, asksAuthQuestion, chatWithTools, deniesCapability, detectDegenerateRepetition, estimateCost, extractEmbeddedToolCalls, extractExplicitPaths, listModels, narratesBareToolCall, parseTextToolCalls, requestsAction, runTool, skillConfinement, skillNeedsInspection, skillPrescribes } from "./providers";

// ---- Backend seam: Tauri invoke is stubbed per test ----
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

// Policy stub: native dialog confirmed (see lib/approval approvalIssue).
const TOK = { token: "tok-test", detail: "{}" };

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
        requestApproval: async () => null,
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
      { requestApproval: async () => TOK },
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
  // Live 1.0.0 report: the model staged /workspace/hello.txt (hallucinated
  // container path) and every Approve click failed backend-side, queuing a
  // dead pending diff. Staging must refuse up front, in-turn.
  it("refuses to stage fs_write outside the workspace instead of queuing a dead diff", async () => {
    setInvokeImpl(async () => {
      throw new Error("must not reach backend");
    });
    let staged: { path: string; content: string } | null = null;
    const out = await runTool(
      "fs_write",
      { path: "/workspace/hello.txt", content: "hi" },
      {
        workspaceRoot: "/home/u/projects/test",
        onProposeWrite: async (path, content) => { staged = { path, content }; },
      },
    );
    expect(out).toMatch(/^error:.*outside workspace/);
    expect(staged).toBeNull();
  });
  it("returns auto direct-write failures as tool errors instead of throwing", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "approval_claim") return "tok-test";
      if (cmd === "fs_read") throw new Error("nope");
      if (cmd === "fs_write") throw new Error("fs_write: outside workspace /w (got /w/../x)");
      throw new Error(`unexpected ${cmd}`);
    });
    const out = await runTool(
      "fs_write",
      { path: "/w/sub/x.txt", content: "hi" },
      { autoApproveWorkspace: true, workspaceRoot: "/w" },
    );
    expect(out).toMatch(/^error:.*outside workspace/);
  });
  // Live 1.0.2 report: "hello world" arrived as "" and the model repeated
  // the empty write 3×. The result must flag the empty file loudly.
  it("flags empty auto direct-writes so dropped content gets re-sent", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "approval_claim") return "tok-test";
      if (cmd === "fs_read") throw new Error("nope");
      if (cmd === "fs_write") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    const out = await runTool(
      "fs_write",
      { path: "/w/sub/x.txt", content: "" },
      { autoApproveWorkspace: true, workspaceRoot: "/w" },
    );
    expect(out).toMatch(/now EMPTY.*re-send the FULL content/);
  });
  it("returns no-gate direct-write failures as tool errors instead of throwing", async () => {
    setInvokeImpl(async () => {
      throw new Error("backend down");
    });
    await expect(runTool("fs_write", { path: "/w/a.txt", content: "hi" })).resolves.toMatch(/^error:/);
  });
  it("refuses oversized fs_write payloads", async () => {
    const out = await runTool("fs_write", { path: "/w/a.txt", content: "x".repeat(5 * 1024 * 1024) });
    expect(out).toMatch(/^error:/);
  });
  it("reports unknown tools instead of throwing", async () => {
    await expect(runTool("teleport", {})).resolves.toMatch(/unknown tool/);
  });
  it("runs lsp_diagnostics with approval for ts (py stays free) and requires absolute paths", async () => {
    let approvals = 0;
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("lsp_diagnostics");
      return "clean: no diagnostics for /w/a.ts";
    });
    const out = await runTool(
      "lsp_diagnostics",
      { path: "/w/a.ts" },
      { requestApproval: async () => { approvals++; return TOK; } },
    );
    expect(out).toContain("clean:");
    expect(approvals).toBe(1);
    // Python stays approval-free.
    let pyApprovals = 0;
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("lsp_diagnostics");
      return "clean: no diagnostics for /w/a.py";
    });
    const pyOut = await runTool(
      "lsp_diagnostics",
      { path: "/w/a.py" },
      { requestApproval: async () => { pyApprovals++; return TOK; } },
    );
    expect(pyOut).toContain("clean:");
    expect(pyApprovals).toBe(0);
    await expect(runTool("lsp_diagnostics", { path: "relative/a.ts" })).resolves.toMatch(/^error:/);
    await expect(runTool("lsp_diagnostics", {})).resolves.toMatch(/^error:/);
  });
  it("classifies weak vs frontier models", async () => {
    const { isWeakModel } = await import("./providers");
    expect(isWeakModel("http://localhost:11434/v1", "qwen2.5-coder:7b")).toBe(true);
    expect(isWeakModel("https://x.test/v1", "llama3.1:8b")).toBe(true);
    expect(isWeakModel("https://x.test/v1", "gpt-4o-mini")).toBe(true);
    expect(isWeakModel("https://api.anthropic.com", "claude-sonnet-4-5")).toBe(false);
    expect(isWeakModel("https://api.openai.com/v1", "gpt-4o")).toBe(false);
    expect(isWeakModel("https://x.test/v1", "qwen2.5-coder:32b")).toBe(true);
    // Host and file format are not capability signals: a 35B gguf served
    // locally is a strong model and gets the full system prompt.
    expect(isWeakModel("http://localhost:8080/v1", "/models/Ornith-1.5-35B-Q4_K_M.gguf")).toBe(false);
    expect(isWeakModel("http://127.0.0.1:8080/v1", "Qwen3-32B-Q4_K_M.gguf")).toBe(true); // family, not host/format
  });
  // Live 1.0.1 report: weak models burn whole turns on path errors
  // (relative "hello.txt", hallucinated /workspace/..., bare fs_list {}).
  // Read tools resolve/default; write errors hand over the exact path.
  it("grounds weak-model fs paths instead of burning rounds", async () => {
    const seen: string[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      seen.push(`${cmd}:${args?.path ?? ""}`);
      if (cmd === "fs_list") return [{ name: "hello.txt", is_dir: false }];
      if (cmd === "fs_read") return "hello world";
      return {};
    });
    const pol = { workspaceRoot: "/home/u/projects/test", cwd: "/home/u/projects/test/qwen2.5" };
    // Bare fs_list lists the workspace root (was: usage error).
    await expect(runTool("fs_list", {}, pol)).resolves.toMatch(/hello\.txt/);
    expect(seen).toContain("fs_list:/home/u/projects/test");
    // Relative read resolves against cwd and says so.
    await expect(runTool("fs_read", { path: "hello.txt" }, pol)).resolves.toMatch(
      /hello world.*resolved from relative "hello\.txt"/,
    );
    expect(seen).toContain("fs_read:/home/u/projects/test/qwen2.5/hello.txt");
    // Relative write still refuses (explicit-absolute for mutations) but
    // hands over the exact path to copy.
    await expect(runTool("fs_write", { path: "hello.txt", content: "hi" }, pol)).resolves.toMatch(
      /must be absolute.*\/home\/u\/projects\/test\/qwen2\.5\/hello\.txt/,
    );
    expect(seen.every((s) => !s.startsWith("fs_write"))).toBe(true);
  });
  it("names the real root/cwd in path errors, never a placeholder", async () => {
    setInvokeImpl(async () => {
      throw new Error(
        "fs_list: outside workspace /home/u/projects/test (got /workspace/hello, nearest existing ancestor resolves outside)",
      );
    });
    const pol = { workspaceRoot: "/home/u/projects/test", cwd: "/home/u/projects/test/qwen2.5" };
    // Absolute but outside: the backend refusal surfaces verbatim (no throw).
    const out = await runTool("fs_list", { path: "/workspace/hello" }, pol);
    expect(out).toMatch(/^error:.*outside workspace \/home\/u\/projects\/test/);
    expect(out).not.toMatch(/\/ws(?!\/)/);
  });
  // Live 1.0.3 report: 3 approved junk shell dialogs (~5s of user attention
  // on empty/"<command>"/outside-cwd calls the backend was bound to refuse).
  it("refuses junk shell calls before any approval dialog", async () => {
    let dialogs = 0;
    setInvokeImpl(async () => ({}));
    const pol = {
      workspaceRoot: "/w",
      requestApproval: async () => {
        dialogs++;
        return TOK;
      },
    };
    await expect(runTool("shell_run", { cmd: "", cwd: "/w" }, pol)).resolves.toMatch(/cmd is empty/);
    await expect(runTool("shell_run", { cmd: "<command>", cwd: "/w" }, pol)).resolves.toMatch(/placeholder/);
    await expect(runTool("shell_run", { cmd: "empty_or_invalid_cmd", cwd: "/w" }, pol)).resolves.toMatch(
      /placeholder/,
    );
    await expect(runTool("shell_run", { cmd: "ls", cwd: "/path/to/workspace" }, pol)).resolves.toMatch(
      /cwd outside workspace/,
    );
    expect(dialogs).toBe(0);
  });
  it("still pops the dialog for real shell commands", async () => {
    let dialogs = 0;
    setInvokeImpl(async (cmd) => {
      if (cmd === "shell_run") return { stdout: "x", stderr: "", code: 0 };
      throw new Error(`unexpected ${cmd}`);
    });
    const out = await runTool("shell_run", { cmd: "ls -la", cwd: "/w" }, {
      workspaceRoot: "/w",
      requestApproval: async () => {
        dialogs++;
        return TOK;
      },
    });
    expect(dialogs).toBe(1);
    expect(out).toContain("x");
  });
  // Live 1.0.3 report: 8 failures, 0 progress, all 10 rounds burned by a
  // model failing differently every round (no identical-call loop to catch).
  it("ends the turn after consecutive failures instead of burning all rounds", async () => {
    setInvokeImpl(async () => {
      throw new Error("fs_list: outside workspace /w (got /nope)");
    });
    const events: string[] = [];
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length < 5) {
        return openAITools([{ id: `f${prev.length}`, name: "fs_list", args: { path: `/nope${prev.length}` } }]);
      }
      return openAIText("giving up gracefully");
    });
    // "hi" is discussion, not action: no survey-stall redirect muddies the count.
    await chatWithTools(CFG, [{ role: "user", content: "hi" }], (e) => events.push(e));
    expect(events.join("")).toMatch(/consecutive failures — ending turn early/);
    // 4 failing rounds + finalize synthesis, not 10 rounds + finalize.
    expect(calls).toHaveLength(5);
  });
});

describe("chatWithTools", () => {
  it("streams reasoning_content to onThinking and keeps it out of content/deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          { choices: [{ delta: { reasoning_content: "Let me think " } }] },
          { choices: [{ delta: { reasoning_content: "about paths." } }] },
          { choices: [{ delta: { content: "src/hooks has 3 files." } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
        ]),
      ) as unknown as typeof fetch,
    );
    const thinking: string[] = [];
    let streamed = "";
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "list src/hooks" }],
      (t) => {
        streamed += t;
      },
      { onThinking: (t) => thinking.push(t) },
    );
    expect(thinking.join("")).toBe("Let me think about paths.");
    expect(streamed).toBe("src/hooks has 3 files.");
    expect(res).toContain("src/hooks has 3 files.");
    expect(res).not.toContain("Let me think");
  });

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
      expect(lastUser.content).toMatch(/Cite the actual tool outputs/);
      expect(lastUser.content).toMatch(/do NOT invent tool calls/);
      expect(lastUser.content).toMatch(/Do not end with a question/);
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
        policy: { requestApproval: async () => null },
        onAudit: (e) => audits.push(e),
      },
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool: "shell_run", decision: "rejected", ok: false });
  });
});

describe("parseTextToolCalls", () => {
  it("recovers a plain-text tool call", () => {
    const [tc] = parseTextToolCalls('{"name":"skill_list","arguments":{}}');
    expect(tc.function.name).toBe("skill_list");
    expect(tc.function.arguments).toBe("{}");
  });
  it("accepts fenced and array forms and nested function shape", () => {
    expect(parseTextToolCalls('```json\n{"name":"fs_list","arguments":{"path":"/w"}}\n```')[0].function.name).toBe("fs_list");
    expect(parseTextToolCalls('[{"name":"fs_list","args":{"path":"/w"}}]')).toHaveLength(1);
    expect(parseTextToolCalls(`{"function":{"name":"git_status","arguments":"{\\"cwd\\":\\"/w\\"}"}}`)[0].function.arguments).toBe(`{"cwd":"/w"}`);
  });
  it("rejects prose, unknown tools, and broken JSON", () => {
    expect(parseTextToolCalls("Sure! I will run skill_list now.")).toEqual([]);
    expect(parseTextToolCalls('{"name":"delete_everything","arguments":{}}')).toEqual([]);
    expect(parseTextToolCalls('{"name":"fs_list", broken')).toEqual([]);
    expect(parseTextToolCalls("")).toEqual([]);
  });
});

describe("announcesToolAction", () => {
  it("detects narrated tool calls", () => {
    expect(announcesToolAction("Please approve the following fs_write to create the file.")).toBe("fs_write");
    expect(announcesToolAction("Next action: shell_run to check ffmpeg.")).toBe("shell_run");
    expect(announcesToolAction("I'll now call fs_read on that file.")).toBe("fs_read");
  });
  it("ignores plain summaries and tool-free prose", () => {
    expect(announcesToolAction("I read the file and it looks good.")).toBeNull();
    expect(announcesToolAction("I ran fs_read on App.tsx and found the bug.")).toBeNull();
    expect(announcesToolAction("")).toBeNull();
    expect(announcesToolAction("Please approve the diff in the Diff tab.")).toBeNull();
  });
});

describe("narratesBareToolCall", () => {
  it("detects bare Tool+args narrations", () => {
    expect(narratesBareToolCall("Fs_read /home/u/check_ffmpeg.py")).toBe("fs_read");
    expect(narratesBareToolCall("fs_write /w/a.txt")).toBe("fs_write");
    expect(narratesBareToolCall("  git_status   /w/repo  ")).toBe("git_status");
    expect(narratesBareToolCall("some explanation here\nFs_read /w/a.txt")).toBe("fs_read");
  });
  it("ignores descriptions and normal prose", () => {
    expect(narratesBareToolCall("fs_write stages to the Diff gate")).toBeNull();
    expect(narratesBareToolCall("I ran fs_read on App.tsx and found the bug.")).toBeNull();
    expect(narratesBareToolCall("```python\nprint(1)\n```")).toBeNull();
    expect(narratesBareToolCall("")).toBeNull();
  });
});

describe("extractEmbeddedToolCalls", () => {
  it("recovers trailing JSON after prose", () => {
    const out = extractEmbeddedToolCalls('Hi! I am Commander.\n{"name": "nexa_read", "arguments": {"kind":"memory"}}');
    expect(out).toHaveLength(1);
    expect(out[0].function.name).toBe("nexa_read");
    expect(out[0].function.arguments).toBe('{"kind":"memory"}');
  });
  it("recovers fenced JSON after explanation, skipping code fences", () => {
    const out = extractEmbeddedToolCalls(
      'Here is a script:\n```python\nprint("hi")\n```\nNow reading:\n```json\n{"name":"fs_read","arguments":{"path":"/w/a.txt"}}\n```',
    );
    expect(out.map((t) => t.function.name)).toEqual(["fs_read"]);
  });
  it("dedupes repeats and caps fan-out", () => {
    const one = '{"name":"fs_list","arguments":{"path":"/w"}}';
    const out = extractEmbeddedToolCalls(`${one} then again ${one} ${one} ${one} ${one}`);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0].function.name).toBe("fs_list");
  });
  it("ignores prose, examples without valid calls, and broken JSON", () => {
    expect(extractEmbeddedToolCalls("I read the file and it looks good.")).toEqual([]);
    expect(extractEmbeddedToolCalls('{"name":"delete_everything","arguments":{}}')).toEqual([]);
    expect(extractEmbeddedToolCalls('{"name":"fs_list", broken')).toEqual([]);
    expect(extractEmbeddedToolCalls("")).toEqual([]);
  });
});

describe("deniesCapability", () => {
  it("detects false text-only / cannot-run denials", () => {
    expect(
      deniesCapability("As a text-based AI, I cannot execute shell commands directly."),
    ).toBe(true);
    expect(deniesCapability("I cannot run shell commands in this environment.")).toBe(true);
    expect(deniesCapability("I am unable to read files here.")).toBe(true);
  });
  it("ignores legit refusals and normal prose", () => {
    expect(deniesCapability("I cannot approve it myself - please click Approve.")).toBe(false);
    expect(deniesCapability("I don't have access to /etc/shadow.")).toBe(false);
    expect(deniesCapability("I read the file and it looks good.")).toBe(false);
    expect(deniesCapability("")).toBe(false);
  });
});

describe("detectDegenerateRepetition", () => {
  const phrase = "The Build button is not clickable, so I have to wait for the image to be loaded.";

  it("flags a phrase repeated across separate lines", () => {
    const garbage = Array.from({ length: 12 }, () => phrase).join("\n");
    const got = detectDegenerateRepetition(garbage);
    expect(got).not.toBeNull();
    expect(got?.phrase).toBe(phrase.replace(/[.!?]+$/, ""));
    expect(got?.count).toBe(12);
  });

  it("flags a phrase repeated inside a single paragraph", () => {
    const garbage = `${phrase} `.repeat(8).trim();
    expect(detectDegenerateRepetition(garbage)?.count).toBe(8);
  });

  it("ignores normal prose that mentions a token several times", () => {
    const normal =
      "I read App.tsx and found the bug in the render loop. I patched App.tsx with a guard, " +
      "then re-read App.tsx to verify the fix. Tests pass and App.tsx is ready for review. " +
      "One note: App.tsx imports a helper that also needed a small change.";
    expect(detectDegenerateRepetition(normal)).toBeNull();
  });

  it("ignores a sentence repeated a few times (below the threshold)", () => {
    const mild =
      `Did the check. ${phrase} Then moved on to the next step and ran the tests. ` +
      `All good. ${phrase} Wrapping up now with a short summary of what changed.`;
    expect(detectDegenerateRepetition(mild)).toBeNull();
  });

  it("ignores short or empty text", () => {
    expect(detectDegenerateRepetition("")).toBeNull();
    expect(detectDegenerateRepetition(phrase)).toBeNull();
  });
});

describe("chatWithTools degenerate output", () => {
  it("stops a repetition loop and returns a diagnostic instead of garbage", async () => {
    const phrase = "The Build button is not clickable, so I have to wait for the image to be loaded.";
    const garbage = Array.from({ length: 30 }, () => phrase).join("\n");
    setInvokeImpl(async () => {
      throw new Error("unexpected invoke");
    });
    stubFetch(() => openAIText(garbage));
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "look at this screenshot" }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(res).toContain("[stopped: degenerate repetition detected");
    expect(res).toContain("30x");
    // Head is truncated; the 30-line wall is not handed back.
    expect(res.split(phrase).length - 1).toBeLessThan(10);
    expect(res.length).toBeLessThan(garbage.length / 2);
    expect(repairs).toEqual(["repetition"]);
  });
});

// The skill body the frontend expands into the user message (see
// useAgentTurn.expandSkill): marker + instructions + body + arguments.
function skillMsg(name: string, body: string, args = ""): string {
  return (
    `User invoked /${name} - follow these skill instructions now using tools, do not discuss the skill itself:\n` +
    `[skill: ${name}]\n${body}${args ? `\n\nArguments:\n${args}` : ""}`
  );
}

describe("skillNeedsInspection", () => {
  const RATE = skillMsg(
    "rate",
    "Provide a concise 1-10 score.\n1. Inspect the target with read-only tools: fs_list the root, fs_read code, git_status and git_log for activity.\n3. Reply with ONLY Score/Strengths/Weaknesses/Suggestion.",
  );
  it("flags a skill whose body prescribes read-only tools", () => {
    expect(skillNeedsInspection(RATE)).toBe("rate");
  });
  it("returns null when no skill marker is present", () => {
    expect(skillNeedsInspection("just a normal user question")).toBeNull();
  });
  it("returns null for an informational skill with no tool steps", () => {
    const noTools = skillMsg("greet", "Answer the user's greeting warmly and briefly. No tools needed.");
    expect(skillNeedsInspection(noTools)).toBeNull();
  });
  it("ignores empty input", () => {
    expect(skillNeedsInspection("")).toBeNull();
  });
});

describe("skillPrescribes", () => {
  const RATE = skillMsg(
    "rate",
    "Inspect the target with read-only tools: fs_list the root, fs_glob for file patterns, fs_read plus fs_search for code, git_status plus git_log.",
  );
  it("lists the exact tools the skill body prescribes", () => {
    expect(skillPrescribes(RATE)).toEqual({
      name: "rate",
      tools: expect.arrayContaining(["fs_list", "fs_glob", "fs_read", "fs_search", "git_status", "git_log"]),
    });
    expect(skillPrescribes(RATE)?.tools).toHaveLength(6);
  });
  it("returns null for a skill with no tool steps", () => {
    expect(skillPrescribes(skillMsg("greet", "Be brief."))).toBeNull();
  });
});

describe("chatWithTools skill follow-through", () => {
  const RATE = skillMsg(
    "rate",
    "Inspect the target with read-only tools: fs_list the root, git_status for activity. Then reply with ONLY Score/Strengths/Weaknesses/Suggestion.",
  );

  it("forces inspection when a skill is answered from memory", async () => {
    const invoked: string[] = [];
    setInvokeImpl(async (cmd) => {
      invoked.push(cmd);
      if (cmd === "fs_list") return JSON.stringify(["App.tsx", "package.json"]);
      if (cmd === "git_status") return " M App.tsx";
      throw new Error(`unexpected ${cmd}`);
    });
    let n = 0;
    stubFetch(() => {
      n++;
      if (n === 1) {
        // Skipped every tool and produced the score from memory.
        return openAIText("**Score: 6/10**\n\nStrengths: clean layout.");
      }
      // After the nudge it inspects for real, then answers.
      if (n === 2) return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      if (n === 3) return openAITools([{ id: "g1", name: "git_status", args: {} }]);
      return openAIText("**Score: 8/10**\n\nStrengths: inspected for real this time.");
    });
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: RATE }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(repairs).toContain("skill");
    expect(invoked).toContain("fs_list");
    expect(invoked).toContain("git_status");
    expect(res).toContain("inspected for real");
  });

  it("does not nudge when the model inspects on its own", async () => {
    const invoked: string[] = [];
    setInvokeImpl(async (cmd) => {
      invoked.push(cmd);
      return cmd === "fs_list" ? JSON.stringify(["App.tsx"]) : " M App.tsx";
    });
    let n = 0;
    stubFetch(() => {
      n++;
      if (n === 1) return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      if (n === 2) return openAITools([{ id: "g1", name: "git_status", args: {} }]);
      return openAIText("**Score: 8/10** based on the listing and status above.");
    });
    const repairs: string[] = [];
    await chatWithTools(
      CFG,
      [{ role: "user", content: RATE }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(repairs).not.toContain("skill");
    expect(invoked).toContain("fs_list");
  });

  it("does not nudge for a skill that needs no tools", async () => {
    const greet = skillMsg("greet", "Answer the user's greeting warmly and briefly. No tools needed.");
    setInvokeImpl(async () => {
      throw new Error("unexpected invoke");
    });
    stubFetch(() => openAIText("Hey! Good to see you. What are we working on?"));
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: greet }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(repairs).not.toContain("skill");
    expect(res).toContain("Good to see you");
  });

  // Reproduces the real-world failure: the model burns a round on skill_read
  // (re-reading the skill is NOT inspecting the target) and then emits a
  // "provisional" score from memory. The guard must not be satisfied by the
  // decoy — it forces the prescribed inspection tools to actually run.
  it("is not fooled by a skill_read decoy into skipping inspection", async () => {
    const invoked: string[] = [];
    setInvokeImpl(async (cmd) => {
      invoked.push(cmd);
      if (cmd === "skill_read") return "# rate\nInspect the target with read-only tools.";
      if (cmd === "fs_list") return JSON.stringify(["App.tsx", "package.json"]);
      if (cmd === "git_status") return " M App.tsx";
      throw new Error(`unexpected ${cmd}`);
    });
    let n = 0;
    stubFetch(() => {
      n++;
      if (n === 1) {
        // Decoy: re-reads the skill instead of inspecting.
        return openAITools([{ id: "s1", name: "skill_read", args: { name: "rate" } }]);
      }
      if (n === 2) {
        // Then answers from memory with a "provisional" score.
        return openAIText("Score: N/A (inspection not performed). Provisional ~6/10 from memory.");
      }
      // After the nudge it inspects for real, then answers.
      if (n === 3) return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      if (n === 4) return openAITools([{ id: "g1", name: "git_status", args: {} }]);
      return openAIText("Score: 8/10 based on the actual listing and git status.");
    });
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: RATE }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(repairs).toContain("skill");
    // The decoy ran but so did the real inspection.
    expect(invoked).toContain("skill_read");
    expect(invoked).toContain("fs_list");
    expect(invoked).toContain("git_status");
    // The memory-based provisional answer was replaced by the inspected one.
    expect(res).toContain("actual listing");
    expect(res).not.toMatch(/Provisional ~6\/10/);
  });
});

describe("chatWithTools narration repair", () => {
  it("nudges a narrating model into emitting the real call", async () => {
    const staged: { path: string; content: string }[] = [];
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") throw new Error("not found");
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAIText("Please approve the fs_write to create check_ffmpeg.py.");
      }
      if (prev.length === 2) {
        // The repair nudge is a system message demanding the real call.
        const body = JSON.parse(_init.body);
        const last = body.messages[body.messages.length - 1];
        expect(last.role).toBe("system");
        expect(last.content).toMatch(/NO tool call/);
        return openAITools([
          { id: "w1", name: "fs_write", args: { path: "/w/check_ffmpeg.py", content: "print(1)" } },
        ]);
      }
      return openAIText("staged for review");
    });
    const events: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "check ffmpeg" }],
      (d) => events.push(d),
      { policy: { onProposeWrite: async (path, content) => { staged.push({ path, content }); } } },
    );
    expect(res).toBe("staged for review");
    expect(events.join("")).toMatch(/announced fs_write but made no tool call/);
    expect(staged).toEqual([{ path: "/w/check_ffmpeg.py", content: "print(1)" }]);
    expect(calls).toHaveLength(3);
  });

  it("gives up after two nudges and returns the prose", async () => {
    stubFetch(() => openAIText("Please approve the fs_write, I insist."));
    setInvokeImpl(async () => {
      throw new Error("must not run tools");
    });
    const res = await chatWithTools(CFG, [{ role: "user", content: "write it" }], () => {});
    expect(res).toBe("Please approve the fs_write, I insist.");
  });

  it("runs mixed prose+JSON calls while keeping the prose", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "nexa_read") return "memory: use pnpm";
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAIText('I am Commander, ready to help.\n{"name": "nexa_read", "arguments": {"kind":"memory"}}');
      }
      return openAIText("How can I assist you today?");
    });
    const events: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "introduce yourself" }], (d) =>
      events.push(d),
    );
    expect(res).toBe("How can I assist you today?");
    expect(events.join("")).toMatch(/recovered nexa_read from message text/);
    expect(calls).toHaveLength(2);
  });

  it("reminds a denying model of its tools and runs the call", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "shell_run") return { stdout: "FFmpeg is installed.\n", stderr: "", code: 0 };
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAIText("As a text-based AI, I cannot execute shell commands directly.");
      }
      if (prev.length === 2) {
        const body = JSON.parse(_init.body);
        const last = body.messages[body.messages.length - 1];
        expect(last.role).toBe("system");
        expect(last.content).toMatch(/You DO have that capability/);
        return openAITools([{ id: "s1", name: "shell_run", args: { cwd: "/w", cmd: "python3 check_ffmpeg.py" } }]);
      }
      return openAIText("FFmpeg is installed.");
    });
    const events: string[] = [];
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "run it" }],
      (d) => events.push(d),
      {
        policy: { requestApproval: async () => TOK },
        onRepair: (r) => repairs.push(r.kind),
      },
    );
    expect(res).toBe("FFmpeg is installed.");
    expect(events.join("")).toMatch(/false capability denial/);
    expect(repairs).toEqual(["denial"]);
    expect(calls).toHaveLength(3);
  });

  it("nudges bare tool narrations into real calls", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "print(1)";
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAIText("Fs_read /w/check_ffmpeg.py");
      }
      if (prev.length === 2) {
        const body = JSON.parse(_init.body);
        const last = body.messages[body.messages.length - 1];
        expect(last.role).toBe("user");
        expect(last.content).toMatch(/NO tool call/);
        return openAITools([{ id: "r1", name: "fs_read", args: { path: "/w/check_ffmpeg.py" } }]);
      }
      return openAIText("Yes, the file is available - it contains print(1).");
    });
    const events: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "is it there?" }], (d) =>
      events.push(d),
    );
    expect(res).toBe("Yes, the file is available - it contains print(1).");
    expect(events.join("")).toMatch(/announced fs_read but made no tool call/);
    expect(calls).toHaveLength(3);
  });
});

describe("chatWithTools text-call fallback", () => {
  it("executes a tool call the model printed as plain text", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("skill_list");
      return [{ name: "fix", description: "d" }];
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAIText('{"name":"skill_list","arguments":{}}');
      }
      return openAIText("there is one skill: fix");
    });
    const events: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "skills?" }], (d) => events.push(d));
    expect(res).toBe("there is one skill: fix");
    expect(events.join("")).toMatch(/parsed tool call from plain text/);
    expect(events.join("")).toMatch(/\[tool skill_list/);
    expect(calls).toHaveLength(2);
    // Second request carries the tool result.
    const body = JSON.parse(calls[1].init.body);
    expect(body.messages.some((m: any) => m.role === "tool")).toBe(true);
  });
});

describe("extractExplicitPaths", () => {
  it("finds real absolute paths", () => {
    expect(extractExplicitPaths("list /home/u/proj then read")).toEqual(["/home/u/proj"]);
    expect(extractExplicitPaths("fs_list /w/src")).toEqual(["/w/src"]);
  });
  it("ignores markdown false positives (rate skill)", () => {
    const skill = "UX/Performance:** build size\nScore: X/10\n**Architecture:**";
    expect(extractExplicitPaths(skill)).toEqual([]);
    expect(extractExplicitPaths("Score: X/10")).toEqual([]);
    expect(extractExplicitPaths("**UX/Performance:**")).toEqual([]);
  });
});

describe("asksAuthQuestion", () => {
  it.each([
    "Should I proceed with the setup?",
    "Would you like me to run the commands?",
    "Do you want me to continue?",
    "How would you like to proceed?",
    "Let me know how to proceed?",
    "Shall I start the install?",
    "Please confirm that I should proceed?",
    "Want me to go ahead?",
    "How should we proceed here?",
  ])("flags authorization-seeking: %s", (text) => {
    expect(asksAuthQuestion(text)).toBe(true);
  });
  it.each([
    "Which directory should I use?",
    "What should the commit message say?",
    "The file is ready for review.",
    "I ran the tests and they pass - 3 failures remain.",
    "Should the backup include node_modules?",
    "",
  ])("leaves genuine questions and prose alone: %s", (text) => {
    expect(asksAuthQuestion(text)).toBe(false);
  });
});

describe("chatWithTools question repair", () => {
  it("redirects an asking model into a real call", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [{ name: "a", path: "/w/a", is_dir: false }];
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAIText("Should I proceed with the setup? Would you like me to run the commands?");
      }
      if (prev.length === 2) {
        const body = JSON.parse(_init.body);
        const last = body.messages[body.messages.length - 1];
        expect(last.role).toBe("system");
        expect(last.content).toMatch(/instead of acting/);
        return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      }
      return openAIText("listed.");
    });
    const events: string[] = [];
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "set it up" }],
      (d) => events.push(d),
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(res).toBe("listed.");
    expect(events.join("")).toMatch(/asked for direction instead of acting/);
    expect(repairs).toEqual(["question"]);
    expect(calls).toHaveLength(3);
  });

  it("redirects only once, then ends the turn visibly stalled", async () => {
    stubFetch(() => openAIText("Should I proceed? Just say the word."));
    setInvokeImpl(async () => {
      throw new Error("must not run tools");
    });
    const events: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "go" }], (d) => events.push(d));
    expect(res).toBe("Should I proceed? Just say the word.");
    expect(events.join("").match(/asked for direction instead of acting/g)).toHaveLength(1);
  });

  it("leaves post-action questions alone", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [];
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      }
      return openAIText("Done. Should I proceed with the delete?");
    });
    const events: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "list then ask" }], (d) =>
      events.push(d),
    );
    expect(res).toBe("Done. Should I proceed with the delete?");
    expect(events.join("")).not.toMatch(/asked for direction/);
    expect(calls).toHaveLength(2);
  });
});

describe("synthesis turn digest", () => {
  it("injects a citable outcome line for every executed call", async () => {
    setInvokeImpl(async (cmd, a) => {
      if (cmd === "fs_list") {
        return a?.path?.includes("sub")
          ? [{ name: "alpha", path: "/w/early/alpha", is_dir: true }]
          : [{ name: "beta", path: "/w/early/beta", is_dir: false }];
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const bodies: any[] = [];
    stubFetch((_url, init) => {
      bodies.push(JSON.parse(init.body));
      const n = bodies.length;
      if (n === 1) {
        return openAITools([{ id: "a1", name: "fs_list", args: { path: "/w/early" } }]);
      }
      if (n <= 10) {
        // Keep emitting distinct calls so the loop guard (3× identical)
        // doesn't fire: the digest path under test is budget exhaustion
        // after MAX_ROUNDS, where the trimmed tail would otherwise drop
        // the early calls.
        return openAITools([{ id: `b${n}`, name: "fs_list", args: { path: `/w/early/sub${n}` } }]);
      }
      return openAIText("done");
    });
    await chatWithTools(CFG, [{ role: "user", content: "go" }], () => {});
    const digest = bodies[bodies.length - 1].messages.find(
      (m: any) => m.role === "system" && typeof m.content === "string" && m.content.includes("Turn digest"),
    );
    expect(digest).toBeTruthy();
    expect(digest.content).toMatch(/fs_list.*"\/w\/early"/);
    expect(digest.content).toMatch(/fs_list.*"\/w\/early\/sub2"/);
    // The digest rides one round only as synthesis context: no user-turn text.
    const users = bodies[bodies.length - 1].messages.filter((m: any) => m.role === "user");
    expect(users.some((u: any) => /Turn digest/.test(u.content ?? ""))).toBe(false);
  });

  it("stays silent when no tools ran this turn", async () => {
    setInvokeImpl(async () => []);
    const bodies: any[] = [];
    stubFetch((_url, init) => {
      bodies.push(JSON.parse(init.body));
      return openAIText("plain answer");
    });
    await chatWithTools(CFG, [{ role: "user", content: "hi" }], () => {});
    expect(
      bodies.some((b) =>
        (b.messages as any[]).some((m) => typeof m.content === "string" && m.content.includes("Turn digest")),
      ),
    ).toBe(false);
  });
});

describe("nudge channels", () => {
  it("attaches the repeat nudge to the tool result, never as a user turn", async () => {
    setInvokeImpl(async () => []);
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length <= 3) {
        return openAITools([{ id: `c${prev.length}`, name: "fs_list", args: { path: "/w" } }]);
      }
      return openAIText("done");
    });
    await chatWithTools(CFG, [{ role: "user", content: "list" }], () => {});
    const sent = calls.map((c) => JSON.parse(c.init.body).messages as any[]);
    const nudges = sent.flat().filter((m) => typeof m.content === "string" && m.content.includes("You repeated"));
    expect(nudges.length).toBeGreaterThan(0);
    // The hint rides inside the tool result it follows - or inside the system
    // turn-digest that quotes every executed call for the synthesis round...
    expect(
      nudges.every(
        (m) => m.role === "tool" || (m.role === "system" && m.content.includes("Turn digest")),
      ),
    ).toBe(true);
    // ...and never masquerades as something the user said.
    const userTurns = sent.flat().filter((m) => m.role === "user");
    expect(userTurns.some((m) => typeof m.content === "string" && m.content.includes("You repeated"))).toBe(false);
  });
});

describe("windowConvo task anchor", () => {
  it("keeps this turn's request when a tool-heavy turn exceeds the history window", async () => {
    setInvokeImpl(async () => []);
    const bodies: any[] = [];
    stubFetch((_url, init) => {
      bodies.push(JSON.parse(init.body));
      const n = bodies.length;
      if (n <= 10) {
        // Ten distinct rounds: 10 assistant + 10 tool messages appended, which
        // pushes the user request out of the 14/20-message history window.
        return json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: `c${n}`,
                    type: "function",
                    function: { name: "fs_list", arguments: JSON.stringify({ path: `/w/d${n}` }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        });
      }
      return openAIText("final");
    });
    const res = await chatWithTools(
      CFG,
      [
        { role: "system", content: "sys" },
        { role: "user", content: "TASK-ANCHOR: analyse the app" },
      ],
      () => {},
    );
    expect(res).toBe("final");
    // The synthesis request must still carry the original task.
    const last = bodies[bodies.length - 1];
    const joined = last.messages.map((m: any) => m.content).join("\n");
    expect(joined).toContain("TASK-ANCHOR: analyse the app");
  });
});

describe("reasoning-content passthrough", () => {
  it("forwards streamed reasoning_content to onThinking without polluting the answer", async () => {
    setInvokeImpl(async () => []);
    stubFetch(() =>
      sse([
        { choices: [{ delta: { reasoning_content: "weighing " } }] },
        { choices: [{ delta: { reasoning_content: "options" } }] },
        { choices: [{ delta: { content: "Answer." } }] },
        { usage: { prompt_tokens: 3, completion_tokens: 4 } },
      ]),
    );
    const think: string[] = [];
    const events: string[] = [];
    const res = await chatWithTools(CFG, [{ role: "user", content: "hi" }], (d) => events.push(d), {
      onThinking: (t) => think.push(t),
    });
    expect(think.join("")).toBe("weighing options");
    expect(res).toBe("Answer.");
    expect(events.join("")).toBe("Answer.");
  });
});

describe("postJSON transient-failure retry", () => {
  it("silently retries one transient 500 and completes the turn", async () => {
    setInvokeImpl(async () => []);
    let n = 0;
    stubFetch(() => {
      n++;
      if (n === 1) return json({ error: { message: "Jinja Exception: No messages provided." } }, 500);
      return sse([
        { choices: [{ delta: { content: "recovered" } }] },
        { usage: { prompt_tokens: 4, completion_tokens: 2 } },
      ]);
    });
    const res = await chatWithTools(CFG, [{ role: "user", content: "hi" }], () => {});
    expect(res).toBe("recovered");
    // Exactly one retry, no extra model rounds.
    expect(n).toBe(2);
  });

  it("does not retry non-transient 4xx errors", async () => {
    setInvokeImpl(async () => []);
    let n = 0;
    stubFetch(() => {
      n++;
      return json({ error: { message: "invalid request" } }, 400);
    });
    await expect(chatWithTools(CFG, [{ role: "user", content: "hi" }], () => {})).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});

describe("requestsAction", () => {
  it("detects work requests, including polite can-you-do phrasing", () => {
    for (const t of [
      "can you do the git setup and commit for me?",
      "please add unit tests for auth",
      "fix the login bug",
      "implement pagination",
      "set up CI",
    ]) {
      expect(requestsAction(t), t).toBe(true);
    }
  });

  it("leaves discussion openers alone", () => {
    for (const t of [
      "how do I add tests for auth?",
      "how could we improve the score?",
      "what files handle login?",
      "explain the auth flow",
      "do you think we should refactor?",
      "list then ask",
      "go",
      "",
    ]) {
      expect(requestsAction(t), t).toBe(false);
    }
  });
});

describe("chatWithTools survey repair", () => {
  const SURVEY =
    "Backend structure shows NestJS auth and orders modules. No test suites or CI workflows were detected in the listings. Commit the files to establish state.";
  it("redirects a recon-only turn into its first mutation", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [{ name: "a", path: "/w/a", is_dir: false }];
      if (cmd === "fs_create") return "created";
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      }
      if (prev.length === 2) {
        return openAIText(SURVEY);
      }
      if (prev.length === 3) {
        const body = JSON.parse(_init.body);
        const last = body.messages[body.messages.length - 1];
        expect(last.role).toBe("system");
        expect(last.content).toMatch(/Recon is not completion/);
        return openAITools([{ id: "c1", name: "fs_create", args: { path: "/w/a.txt" } }]);
      }
      return openAIText("done - created and committed.");
    });
    const events: string[] = [];
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "can you do the git setup and commit for me?" }],
      (d) => events.push(d),
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(res).toBe("done - created and committed.");
    expect(repairs).toEqual(["survey"]);
    expect(events.join("")).toMatch(/first mutation/);
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("pushes repeat stallers twice, then lets the third survey stand", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [];
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      }
      return openAIText(SURVEY);
    });
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "please add tests for auth" }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(repairs).toEqual(["survey", "survey"]);
    expect(res).toBe(SURVEY);
    expect(calls).toHaveLength(4);
  });

  it("stays silent on discussion questions after recon", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [{ name: "a", path: "/w/a", is_dir: false }];
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      }
      return openAIText("Auth lives in backend/src/auth with a service and controller.");
    });
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "how do I add tests for the auth module?" }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(res).toContain("Auth lives");
    expect(repairs).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("stays silent in plan mode, where findings are the job", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [{ name: "a", path: "/w/a", is_dir: false }];
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAITools([{ id: "l1", name: "fs_list", args: { path: "/w" } }]);
      }
      return openAIText(SURVEY);
    });
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "can you do the git setup and commit for me?" }],
      () => {},
      { policy: { planMode: true }, onRepair: (r) => repairs.push(r.kind) },
    );
    expect(res).toBe(SURVEY);
    expect(repairs).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("stays silent once the turn already mutated", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_create") return "created";
      throw new Error(`unexpected ${cmd}`);
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) {
        return openAITools([{ id: "c1", name: "fs_create", args: { path: "/w/a.txt" } }]);
      }
      return openAIText("Created the file. Tests still missing.");
    });
    const repairs: string[] = [];
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "please add tests for auth" }],
      () => {},
      { onRepair: (r) => repairs.push(r.kind) },
    );
    expect(res).toContain("Created the file");
    expect(repairs).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe("skillConfinement", () => {
  const RATE = [
    "User invoked /rate - follow these skill instructions NOW, using tools, for THIS turn only.",
    "[skill: rate]",
    "1. Inspect the target using read-only tools: fs_list the workspace root, fs_glob for file patterns, fs_read plus fs_search for code, git_status plus git_log for activity.",
    "3. Reply with ONLY:",
  ].join("\n");
  it("confines /rate to exactly its prescribed read-only tools", () => {
    const c = skillConfinement(RATE);
    expect(c?.skill).toBe("rate");
    expect(c?.tools.sort()).toEqual(
      ["fs_glob", "fs_list", "fs_read", "fs_search", "git_log", "git_status"].sort(),
    );
  });
  it("leaves non-skill turns and full-surface skills alone", () => {
    expect(skillConfinement("please fix the bug")).toBeNull();
    expect(skillConfinement("")).toBeNull();
    // Skill turn without a read-only scope marker: no confinement.
    const fix = [
      "User invoked /fix - follow these skill instructions NOW, using tools, for THIS turn only.",
      "[skill: fix]",
      "1. Run the failing tests with shell_run, then fs_read the broken file and repair it.",
    ].join("\n");
    expect(skillConfinement(fix)).toBeNull();
  });
});

describe("chatWithTools skill confinement", () => {
  const RATE_POLICY = {
    allowedTools: {
      skill: "rate",
      tools: ["fs_list", "fs_glob", "fs_read", "fs_search", "git_status", "git_log"],
    },
  };
  it("withholds out-of-scope defs so the model is never offered shell", async () => {
    setInvokeImpl(async () => {
      throw new Error("must not reach backend");
    });
    const calls = stubFetch((_url, _init, prev) => {
      if (prev.length === 1) return openAIText("Score: 6/10");
      throw new Error("only one round expected");
    });
    const res = await chatWithTools(
      CFG,
      [{ role: "user", content: "rate it" }],
      () => {},
      { policy: RATE_POLICY },
    );
    expect(res).toBe("Score: 6/10");
    const offered = (JSON.parse(calls[0].init.body).tools as any[]).map((t) => t.function.name);
    expect(offered).not.toContain("shell_run");
    expect(offered).not.toContain("fs_write");
    expect(offered).toContain("fs_list");
  });
  it("refuses confined-out calls fail-closed before any dialog or invoke", async () => {
    const invoked: string[] = [];
    setInvokeImpl(async (cmd) => {
      invoked.push(cmd);
      return {};
    });
    const out = await runTool("shell_run", { cmd: "git commit -m x" }, {
      ...RATE_POLICY,
      requestApproval: async () => {
        throw new Error("dialog must never appear for out-of-scope tools");
      },
    });
    expect(out).toMatch(/outside this skill's tool scope/);
    expect(out).toMatch(/\/rate allows:/);
    expect(invoked).toEqual([]);
  });
  it("lets prescribed reads through untouched", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_list") return [{ name: "a", path: "/w/a", is_dir: false }];
      throw new Error(`unexpected ${cmd}`);
    });
    const out = await runTool("fs_list", { path: "/w" }, RATE_POLICY);
    expect(out).toContain("/w/a");
  });
});

describe("tool catalog descriptions", () => {
  it("fs_create admits it makes empty placeholders; fs_write owns content", async () => {
    const { TOOL_DEFS } = await import("./toolCatalog");
    const def = (n: string) => TOOL_DEFS.find((t) => t.function.name === n)!.function.description;
    expect(def("fs_create")).toMatch(/EMPTY/i);
    expect(def("fs_create")).toMatch(/fs_write/);
    expect(def("fs_write")).toMatch(/creates.*if missing|if missing/i);
    expect(def("fs_write")).not.toMatch(/does NOT write directly/);
  });
});

// The toAnthropic/toGemini converters only run inside chatWithTools; these
// round-trips pin the exact wire shapes (merging, images, tool blocks) for
// the two backends whose request formats differ structurally from OpenAI.
describe("Anthropic & Gemini wire round-trips", () => {
  const ANTH = { baseUrl: "https://api.anthropic.com", apiKey: "k", model: "m", kind: "anthropic" as const };
  const GEM = { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "gk", model: "gemini-x", kind: "gemini" as const };

  it("Anthropic: system+image merging, streamed tool_use args, tool_result feedback", async () => {
    setInvokeImpl(async (cmd) => (cmd === "fs_read" ? "B DATA" : []));
    const calls = stubFetch((_u, _i, prev) => {
      if (prev.length === 1) {
        return sse([
          { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "fs_read" } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"' } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '/w/b.txt"}' } },
          { type: "message_delta", usage: { output_tokens: 3 } },
        ]);
      }
      return sse([
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      ]);
    });
    const res = await chatWithTools(
      ANTH,
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "read b.txt" },
        { role: "user", content: "screenshot next", images: ["QUJD"] } as never,
      ],
      () => {},
    );
    expect(res).toBe("done");

    const b1 = JSON.parse(calls[0].init.body);
    expect(b1.system).toContain("be terse");
    // Consecutive users collapse into one alternation-safe message, and the
    // string + image parts merge into a content block array.
    const withImage = b1.messages.find((m: any) =>
      Array.isArray(m.content) && m.content.some((p: any) => p.type === "image"),
    );
    expect(withImage).toBeTruthy();
    expect(withImage.content.some((p: any) => p.type === "image" && p.source.data === "QUJD")).toBe(true);
    expect(b1.tools.some((t: any) => t.name === "fs_read" && t.input_schema)).toBe(true);

    const b2 = JSON.parse(calls[1].init.body);
    const asst = b2.messages.find((m: any) => m.role === "assistant");
    expect(asst.content[0]).toMatchObject({
      type: "tool_use",
      id: "tu1",
      name: "fs_read",
      input: { path: "/w/b.txt" },
    });
    const toolResult = b2.messages
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .find((p: any) => p.type === "tool_result");
    expect(toolResult).toMatchObject({ tool_use_id: "tu1" });
    expect(toolResult.content).toContain("B DATA");
  });

  it("Anthropic: orphaned tool_results (no preceding tool_use) are dropped", async () => {
    stubFetch(() => openAIText("ok"));
    const calls = stubFetch(() =>
      sse([
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      ]),
    );
    await chatWithTools(
      ANTH,
      [
        { role: "user", content: "hi" },
        { role: "tool", content: "orphan", tool_call_id: "ghost" } as never,
      ],
      () => {},
    );
    const body = JSON.parse(calls[0].init.body);
    expect(JSON.stringify(body.messages)).not.toContain("orphan");
  });

  it("Gemini: systemInstruction, UPPERCASE schema, functionCall round-trip, functionResponse feedback", async () => {
    setInvokeImpl(async (cmd) => (cmd === "fs_read" ? "B DATA" : []));
    const calls = stubFetch((_u, _i, prev) =>
      prev.length === 1
        ? sse([
            {
              candidates: [{ content: { parts: [{ functionCall: { name: "fs_read", args: { path: "/w/b.txt" } } }] } }],
              usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
            },
          ])
        : sse([{ candidates: [{ content: { parts: [{ text: "all " }, { text: "set" }] } }] }]),
    );
    const res = await chatWithTools(
      GEM,
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "read b.txt" },
      ],
      () => {},
    );
    expect(res).toBe("all set");
    expect(calls[0].url).toContain(":streamGenerateContent?alt=sse");
    expect(calls[0].init.headers["x-goog-api-key"]).toBe("gk");

    const b1 = JSON.parse(calls[0].init.body);
    expect(b1.system_instruction).toEqual({ parts: [{ text: "be terse" }] });
    const decl = b1.tools[0].functionDeclarations.find((t: any) => t.name === "fs_read");
    expect(decl.parameters.type).toBe("OBJECT");
    expect(decl.parameters.properties.path.type).toBe("STRING");

    const b2 = JSON.parse(calls[1].init.body);
    const modelMsg = b2.contents.find((c: any) => c.role === "model");
    expect(modelMsg.parts[0].functionCall).toMatchObject({ name: "fs_read", args: { path: "/w/b.txt" } });
    const fr = b2.contents
      .flatMap((c: any) => c.parts)
      .find((p: any) => p.functionResponse);
    expect(fr.functionResponse.name).toBe("fs_read");
    expect(JSON.stringify(fr.functionResponse.response)).toContain("B DATA");
  });

  it("Gemini: malformed functionCall args and orphan responses degrade to {}", async () => {
    setInvokeImpl(async () => []);
    const calls = stubFetch(() =>
      sse([{ candidates: [{ content: { parts: [{ text: "fine" }] } }] }]),
    );
    await chatWithTools(
      GEM,
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "x", tool_calls: [{ id: "g1", function: { name: "fs_list", arguments: "{not json" } }] } as never,
        { role: "tool", content: "r", tool_call_id: "ghost" } as never,
      ],
      () => {},
    );
    const b = JSON.parse(calls[0].init.body);
    const modelMsg = b.contents.find((c: any) => c.role === "model");
    expect(modelMsg.parts.find((p: any) => p.functionCall).functionCall.args).toEqual({});
    // Orphan tool result (no known idToName) never becomes a functionResponse.
    expect(JSON.stringify(b.contents)).not.toContain("ghost");
  });
});
