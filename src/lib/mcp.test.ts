// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMcpEnabled,
  isMcpToolName,
  resolveMcpQualified,
  setMcpEnabled,
  setMcpToolCache,
  splitQualifiedName,
  toMcpToolDefs,
} from "./mcp";
import { isGatedTool, parseTextToolCalls } from "./providers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("not stubbed")),
}));

beforeEach(() => {
  localStorage.clear();
  setMcpToolCache([]);
});

describe("isMcpToolName", () => {
  it("accepts qualified names, rejects the rest", () => {
    expect(isMcpToolName("mcp_sentry_list_issues")).toBe(true);
    expect(isMcpToolName("fs_read")).toBe(false);
    expect(isMcpToolName("mcp_")).toBe(false);
    expect(isMcpToolName("mcp_a-b")).toBe(false);
  });
});

describe("feature flag", () => {
  it("defaults off and toggles", () => {
    expect(isMcpEnabled()).toBe(false);
    setMcpEnabled(true);
    expect(isMcpEnabled()).toBe(true);
    setMcpEnabled(false);
    expect(isMcpEnabled()).toBe(false);
  });
});

describe("toMcpToolDefs", () => {
  it("prefixes descriptions and defaults empty schemas", () => {
    const defs = toMcpToolDefs([
      { server: "s", name: "add", qualified_name: "mcp_s_add", description: "add numbers", input_schema: {} },
    ]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("mcp_s_add");
    expect(defs[0].function.description).toContain("[mcp:s]");
    expect(defs[0].function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("splitQualifiedName", () => {
  it("prefers the longest server prefix", () => {
    expect(splitQualifiedName("mcp_my_list", ["my", "my_mcp"])).toEqual({
      server: "my",
      tool: "list",
    });
    expect(splitQualifiedName("mcp_my_mcp_list", ["my", "my_mcp"])).toEqual({
      server: "my_mcp",
      tool: "list",
    });
  });
});

describe("resolveMcpQualified", () => {
  it("resolves exact cache hits even when sanitizing was lossy", () => {
    setMcpToolCache([
      { server: "s", name: "get.Issue", qualified_name: "mcp_s_get_issue", description: "", input_schema: {} },
    ]);
    expect(resolveMcpQualified("mcp_s_get_issue")).toEqual({ server: "s", tool: "get.Issue" });
  });
  it("returns null with an empty cache", () => {
    expect(resolveMcpQualified("mcp_s_add")).toBeNull();
  });
});

describe("provider gating + recovery", () => {
  it("gates mcp tools and shell, not reads", () => {
    expect(isGatedTool("mcp_sentry_list")).toBe(true);
    expect(isGatedTool("shell_run")).toBe(true);
    expect(isGatedTool("fs_read")).toBe(false);
  });
  it("recovers plain-text mcp calls", () => {
    const calls = parseTextToolCalls(JSON.stringify({ name: "mcp_s_add", arguments: { a: 1 } }));
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("mcp_s_add");
  });
});
