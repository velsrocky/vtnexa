// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { chatWithTools } from "./providers";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
afterEach(() => { vi.unstubAllGlobals(); bridge.invoke.mockReset(); });
const cfg = { baseUrl: "http://127.0.0.1:11434/v1", model: "local", apiKey: "", kind: "auto" as const };
const reply = (action: unknown) => Response.json({ message: { content: JSON.stringify(action) }, done: true });

it("routes native Ollama actions through the existing file approval and execution gates", async () => {
  const source = "export const n = 2;\n";
  let disk = "export const n = 1;\n";
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "fs_read") return disk;
    if (command === "approval_claim") return "token";
    if (command === "fs_write") { expect(args.approvalToken).toBe("token"); disk = args.content; return; }
    throw new Error(`unexpected ${command}`);
  });
  const responses = [{ tool: "fs_write", arguments: { path: "/w/a.mjs", content: source } }, { answer: "Updated." }];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(init.body as string);
    expect(body.format.oneOf.some((variant: { properties: { tool?: { const: string } } }) => variant.properties.tool?.const === "fs_write")).toBe(true);
    return reply(responses.shift());
  });
  vi.stubGlobal("fetch", fetch);
  const answer = await chatWithTools(cfg, [{ role: "user", content: "Update this code" }], () => undefined,
    { policy: { workspaceRoot: "/w", autoApproveWorkspace: true } });
  expect(disk).toBe(source);
  expect(answer).toBe("Updated.");
  expect(bridge.invoke.mock.calls.some(([name]) => name === "approval_claim")).toBe(true);
});

it("does not recover executable tools from a structured answer containing an example", async () => {
  const answer = 'Example: {"name":"shell_run","parameters":{"cmd":"node --test"}}';
  vi.stubGlobal("fetch", async () => reply({ answer }));
  expect(await chatWithTools(cfg, [{ role: "user", content: "Explain a tool call" }], () => undefined)).toBe(answer);
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("withholds write actions in Plan mode", async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const schema = JSON.parse(init.body as string).format;
    expect(JSON.stringify(schema)).not.toContain('"const":"fs_write"');
    return reply({ answer: "Inspect, then implement after switching to Build." });
  });
  await chatWithTools(cfg, [{ role: "user", content: "Fix this project" }], () => undefined, { policy: { workspaceRoot: "/w", planMode: true } });
  expect(bridge.invoke).not.toHaveBeenCalled();
});
