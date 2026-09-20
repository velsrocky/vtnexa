// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isGatedTool, isReadOnlyTool, toolsForMode } from "./toolDefs";
import { actionFor, detailFor, lspNeedsApproval } from "./approval";

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
  it("details are stable JSON capped at 4000 chars", () => {
    expect(detailFor({ cwd: "/w", cmd: "ls" })).toBe('{"cwd":"/w","cmd":"ls"}');
    expect(detailFor(null)).toBe("{}");
    expect(detailFor("x".repeat(9000)).length).toBe(4000);
  });
  it("lsp maps to the lsp_op backend action", () => {
    expect(actionFor("lsp")).toBe("lsp_op");
    expect(actionFor("shell_run")).toBe("shell_run");
  });
});
