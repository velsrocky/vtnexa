import { describe, expect, it } from "vitest";
import { createWorkspaceStore } from "./workspaceStore";
import { isGatedTool, isReadOnlyTool, toolsForMode } from "./toolDefs";
import { lspNeedsApproval } from "./approval";

describe("workspaceStore", () => {
  it("caps audit at 100 and resolves approvals FIFO", () => {
    const s = createWorkspaceStore();
    for (let i = 0; i < 150; i++) s.log({ tool: "fs_read", decision: "auto", ok: true, ms: 1 });
    expect(s.snapshot().audit).toHaveLength(100);
    s.enqueue("shell_run", { cmd: "ls" });
    s.enqueue("git_commit", { message: "m" });
    expect(s.snapshot().pending).toHaveLength(2);
    expect(s.resolveHead(true)?.tool).toBe("shell_run");
    expect(s.snapshot().pending).toHaveLength(1);
  });
});

describe("toolDefs", () => {
  it("gates side-effects + MCP, keeps reads free", () => {
    expect(isGatedTool("shell_run")).toBe(true);
    expect(isGatedTool("mcp_demo_add")).toBe(true);
    expect(isGatedTool("fs_read")).toBe(false);
    expect(isReadOnlyTool("fs_read")).toBe(true);
    expect(isReadOnlyTool("shell_run")).toBe(false);
    // lsp is NOT in the static allowlist (exec risk) — dynamic gate decides.
    expect(isReadOnlyTool("lsp_diagnostics")).toBe(false);
  });
  it("plan mode withholds writes and MCP", () => {
    const base = ["fs_read", "shell_run"].map((name) => ({
      type: "function" as const,
      function: { name, description: name, parameters: {} },
    }));
    const extra = [{ type: "function" as const, function: { name: "mcp_a_b", description: "x", parameters: {} } }];
    expect(toolsForMode(base, extra, true).map((t) => t.function.name)).toEqual(["fs_read"]);
    expect(toolsForMode(base, extra, false).map((t) => t.function.name)).toContain("shell_run");
  });
});

describe("lspNeedsApproval", () => {
  it("py is free, ts/rs need a token", () => {
    expect(lspNeedsApproval("/w/a.py")).toBe(false);
    expect(lspNeedsApproval("/w/a.pyi")).toBe(false);
    expect(lspNeedsApproval("/w/a.ts")).toBe(true);
    expect(lspNeedsApproval("/w/main.rs")).toBe(true);
  });
});
