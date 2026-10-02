// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isGatedTool, isReadOnlyTool, toolsForMode } from "./toolDefs";
import { actionFor, approvalClaim, approvalDetailFor, approvalIssue, detailFor, lspNeedsApproval, MAX_APPROVAL_DETAIL, MAX_NATIVE_APPROVAL_DETAIL, MAX_REVIEWABLE_SHELL_COMMAND, mcpApprovalDetail } from "./approval";

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

describe("approval detail + action mapping", () => {
  it("details preserve the full ordinary JSON payload", () => {
    expect(detailFor({ cwd: "/w", cmd: "ls" })).toBe('{"cwd":"/w","cmd":"ls"}');
    expect(detailFor(null)).toBe("{}");
    expect(detailFor("x".repeat(9000)).length).toBe(9002);
    expect(detailFor("x".repeat(9000)).length).toBeLessThanOrEqual(MAX_APPROVAL_DETAIL);
  });
  it("rejects details and shell commands that cannot be fully reviewed", async () => {
    await expect(approvalIssue("fs_write", "x".repeat(MAX_NATIVE_APPROVAL_DETAIL + 1))).rejects.toThrow(
      "native review limit",
    );
    const shellDetail = JSON.stringify({ cwd: "/w", cmd: "x".repeat(MAX_REVIEWABLE_SHELL_COMMAND + 1) });
    await expect(approvalClaim("shell_run", shellDetail)).rejects.toThrow("too long to review");
    const suffixA = detailFor({ cwd: "/w", cmd: "echo safe" }) + "AAAA";
    const suffixB = detailFor({ cwd: "/w", cmd: "echo safe" }) + "BBBB";
    expect(suffixA).not.toBe(suffixB);
  });

  it("lsp maps to the lsp_op backend action", () => {
    expect(actionFor("lsp")).toBe("lsp_op");
    expect(actionFor("shell_run")).toBe("shell_run");
  });
  it("MCP approval uses the backend action and resolved detail", () => {
    const detail = approvalDetailFor("mcp_call_tool", {
      server: "demo",
      tool: "lookup",
      args: { q: "x" },
    });
    expect(actionFor("mcp_call_tool")).toBe("mcp_call_tool");
    expect(actionFor("mcp_demo_lookup")).toBe("mcp_call_tool");
    expect(detail).toBe(mcpApprovalDetail("demo", "lookup", { q: "x" }));
    expect(mcpApprovalDetail("one", "lookup", { q: "x" })).toBe(
      '{"args":{"q":"x"},"server":"one","tool":"lookup"}',
    );
    expect(detail).toContain('"server":"demo"');
    expect(detail).toContain('"tool":"lookup"');
    expect(detail).toContain('"q":"x"');
    expect(detail).not.toBe(detailFor({ q: "x" }));
  });
});
