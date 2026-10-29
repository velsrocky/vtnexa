// @vitest-environment node
import { expect, it, vi } from "vitest";
import { codingToolsForOllama, ollamaComplete, partialOllamaAnswer, usesOllamaProtocol } from "./ollama";
import type { ToolDef } from "./toolDefs";

const cfg = { baseUrl: "http://127.0.0.1:11434/v1", model: "local", apiKey: "", kind: "ollama" as const };
const tools: ToolDef[] = [{ type: "function", function: { name: "fs_write", description: "Write source", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } }];

it("focuses coding tools while retaining explicitly requested capabilities and MCP", () => {
  const available = ["fs_read", "fs_write", "shell_run", "shell_bg", "shell_poll", "nexa_read", "browser_click", "lsp", "git_diff", "mcp_demo_read"].map((name) => ({ ...tools[0], function: { ...tools[0].function, name } }));
  const names = (task: string) => codingToolsForOllama(available, task).map((tool) => tool.function.name);
  expect(names("Refactor this function")).toEqual(["fs_read", "fs_write", "shell_run", "shell_bg", "shell_poll", "mcp_demo_read"]);
  expect(names("Fix this website and take a screenshot")).toContain("browser_click");
  expect(names("Review this code's git diff")).toContain("git_diff");
  expect(names("Fix code using diagnostics")).toContain("lsp");
  expect(names("Fix this file and update memory")).toContain("nexa_read");
});

it("auto-detects the standard local Ollama endpoint while preserving explicit OpenAI selection", () => {
  expect(usesOllamaProtocol({ ...cfg, kind: "auto" })).toBe(true);
  expect(usesOllamaProtocol({ ...cfg, kind: "openai" })).toBe(false);
  expect(usesOllamaProtocol({ ...cfg, baseUrl: "https://proxy.test/v1", kind: "auto" })).toBe(false);
  expect(usesOllamaProtocol({ ...cfg, baseUrl: "https://proxy.test/ollama", kind: "ollama" })).toBe(true);
});

it("preserves multiline code and literal escapes in a schema-constrained action", async () => {
  const source = "export const value = 1;\nexport const escaped = '\\n';\n";
  const action = JSON.stringify({ tool: "fs_write", arguments: { path: "/w/a.mjs", content: source } });
  const request = vi.fn(async (_url: string, _headers: Record<string, string>, _payload: unknown) => new Response(
    JSON.stringify({ message: { content: action }, done: true, prompt_eval_count: 21, eval_count: 9 }),
  ));
  const result = await ollamaComplete(cfg, [{ role: "user", content: "Edit the file" }], tools, request, () => undefined);
  expect(JSON.parse(result.toolCalls[0].function.arguments).content).toBe(source);
  expect(result.usage).toEqual({ input: 21, output: 9 });
  const payload = request.mock.calls[0][2] as { options: { num_ctx: number }; format: { oneOf: unknown[] }; tools?: unknown };
  expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
  expect(payload.options.num_ctx).toBe(16384);
  expect(payload.tools).toBeUndefined();
  expect(payload.format.oneOf).toHaveLength(2);
});

it("streams answer text without leaking action JSON or incomplete escapes", async () => {
  expect(partialOllamaAnswer('{"answer":"hello\\n\\u00')).toBe("hello\n");
  expect(partialOllamaAnswer('{"tool":"fs_write","arguments":{"content":"secret')).toBe("");
  const text = JSON.stringify({ answer: "Hello\nworld" });
  const chunks = [text.slice(0, 14), text.slice(14)];
  const response = new Response(chunks.map((content, index) => JSON.stringify({ message: { content }, done: index === 1 })).join("\n"));
  let streamed = "";
  const result = await ollamaComplete(cfg, [], [], async () => response, (chunk) => { streamed += chunk; });
  expect(streamed).toBe("Hello\nworld");
  expect(result.content).toBe(streamed);
});

it("rejects missing arguments, unoffered tools, and truncated output", async () => {
  for (const action of [{ tool: "fs_write", arguments: { path: "/w/a" } }, { tool: "shell_run", arguments: { cmd: "anything" } }]) {
    await expect(ollamaComplete(cfg, [], tools, async () => Response.json({ message: { content: JSON.stringify(action) }, done: true }), () => undefined)).rejects.toThrow(/argument|invalid tool/);
  }
  await expect(ollamaComplete(cfg, [], tools, async () => Response.json({ message: { content: "{" }, done: true, done_reason: "length" }), () => undefined)).rejects.toThrow(/output limit/);
});

it("retries only schema sampler initialization failures in JSON mode and still validates actions", async () => {
  const incompatible = { ...cfg, model: "sampler-incompatible" };
  const request = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error("sampler"), { status: 400, body: "Failed to initialize samplers: std::exception" }))
    .mockResolvedValueOnce(Response.json({ message: { content: JSON.stringify({ tool: "shell_run", arguments: { cmd: "anything" } }) }, done: true }));
  await expect(ollamaComplete(incompatible, [], tools, request, () => undefined)).rejects.toThrow("invalid tool action");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][2].format).toBe("json");
  const next = vi.fn().mockResolvedValue(Response.json({ message: { content: '{"answer":"Ready."}' }, done: true }));
  await ollamaComplete(incompatible, [], tools, next, () => undefined);
  expect(next.mock.calls[0][2].format).toBe("json");
  const unavailable = vi.fn().mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503, body: "Failed to initialize samplers" }));
  await expect(ollamaComplete(cfg, [], tools, unavailable, () => undefined)).rejects.toThrow("unavailable");
  expect(unavailable).toHaveBeenCalledTimes(1);
});
