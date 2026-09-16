import { afterEach, describe, expect, it, vi } from "vitest";
import { runTool } from "./providers";
import { setMcpToolCache } from "./mcp";

// Cross-layer gate proof: policy decision -> runTool -> backend invoke.
// A rejected side-effecting tool must NEVER reach its backend (no spawn, no
// fetch, no invoke), while read-only tools must run with zero approval prompts.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

const calls: { cmd: string; args?: unknown }[] = [];

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = async (cmd: string, args?: any) => {
    calls.push({ cmd, args });
    return fn(cmd, args);
  };
}

afterEach(() => {
  calls.length = 0;
  setMcpToolCache([]);
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke")));
});

const REJECT = { requestApproval: async () => false };

describe("rejected side effects never reach the backend", () => {
  const gated: [string, Record<string, unknown>][] = [
    ["shell_run", { cwd: "/w", cmd: "ls" }],
    ["git_commit", { cwd: "/w", message: "m", files: [] }],
    ["fs_rename", { old_path: "/a", new_path: "/b" }],
    ["fs_delete", { path: "/a" }],
    ["browser_navigate", { url: "https://x.test" }],
    ["browser_click", { target_ref: 1 }],
    ["browser_type", { target_ref: 1, text: "hi" }],
    ["browser_back", {}],
    ["mcp_demo_tool", { q: 1 }],
  ];
  it.each(gated)("%s rejected -> no invoke", async (name, args) => {
    const out = await runTool(name, args, REJECT);
    expect(out).toMatch(/^user rejected/);
    expect(calls).toEqual([]);
  });
});

describe("rejected MCP never spawns its server", () => {
  it("resolves from cache but still stops at the gate", async () => {
    setMcpToolCache([
      { server: "demo", name: "add", qualified_name: "mcp_demo_add", description: "", input_schema: {} },
    ]);
    const out = await runTool("mcp_demo_add", { a: 1 }, REJECT);
    expect(out).toMatch(/^user rejected/);
    expect(calls).toEqual([]);
  });
});

describe("approved MCP forwards exact server/tool/args", () => {
  it("round-trips lossy sanitized names via the turn cache", async () => {
    setMcpToolCache([
      { server: "demo", name: "get.Issue", qualified_name: "mcp_demo_get_issue", description: "", input_schema: {} },
    ]);
    setInvokeImpl(async () => "42");
    const out = await runTool("mcp_demo_get_issue", { a: 1 }, { requestApproval: async () => true });
    expect(out).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("mcp_call_tool");
    expect(calls[0].args).toEqual({ server: "demo", tool: "get.Issue", args: { a: 1 } });
  });
  it("unknown MCP errors without invoking", async () => {
    const out = await runTool("mcp_nope_x", {}, { requestApproval: async () => true });
    expect(out).toMatch(/^error:/);
    expect(calls).toEqual([]);
  });
});

describe("read-only tools need no approval", () => {
  const readable: [string, Record<string, unknown>, unknown][] = [
    ["fs_list", { path: "/w" }, [{ name: "a", path: "/w/a", is_dir: false }]],
    ["fs_read", { path: "/w/a" }, "hello"],
    ["lsp_diagnostics", { path: "/w/a.ts" }, "clean: no diagnostics for /w/a.ts"],
    ["git_status", { cwd: "/w" }, { branch: "main", root: "/w", files: [] }],
    ["nexa_read", { kind: "pad" }, ""],
  ];
  it.each(readable)("%s runs with zero prompts", async (name, args, backend) => {
    let approvals = 0;
    setInvokeImpl(async () => backend);
    const out = await runTool(name, args, {
      requestApproval: async () => { approvals++; return true; },
    });
    expect(out).not.toMatch(/^user rejected/);
    expect(approvals).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });
});
