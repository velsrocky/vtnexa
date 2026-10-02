import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fsCreate, fsRename, setWorkspaceRoot } from "./tauri";
import { mcpCallTool } from "./mcp";
import { mcpApprovalDetail } from "./approval";

afterEach(() => clearMocks());

describe("Tauri IPC argument casing", () => {
  it("sends the camelCase keys bound by Rust v2 commands", async () => {
    const seen: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      const payload = (args ?? {}) as Record<string, unknown>;
      seen.push({ cmd, args: payload });
      if (cmd === "fs_create") return String(payload.path);
      if (cmd === "fs_rename") return String(payload.newPath);
      if (cmd === "set_workspace_root") return String(payload.path);
      if (cmd === "mcp_call_tool") return "ok";
      throw new Error(`unexpected command ${cmd}`);
    });

    await expect(fsCreate("C:\\repo\\folder", true)).resolves.toBe("C:\\repo\\folder");
    await expect(fsRename("C:\\repo\\old", "C:\\repo\\new")).resolves.toBe("C:\\repo\\new");
    await expect(setWorkspaceRoot("C:\\repo", true)).resolves.toBe("C:\\repo");
    const mcpDetail = mcpApprovalDetail("demo", "lookup", { query: "x" });
    await expect(
      mcpCallTool("demo", "lookup", { query: "x" }, { token: "mcp-token", detail: mcpDetail }),
    ).resolves.toBe("ok");

    expect(seen).toEqual([
      { cmd: "fs_create", args: { path: "C:\\repo\\folder", isDir: true } },
      {
        cmd: "fs_rename",
        args: {
          oldPath: "C:\\repo\\old",
          newPath: "C:\\repo\\new",
          approvalToken: null,
          approvalDetail: null,
        },
      },
      { cmd: "set_workspace_root", args: { path: "C:\\repo", confirmDangerous: true } },
      {
        cmd: "mcp_call_tool",
        args: {
          server: "demo",
          tool: "lookup",
          args: { query: "x" },
          approvalToken: "mcp-token",
          approvalDetail: mcpDetail,
        },
      },
    ]);
  });

  it("rejects an MCP approval detail for different arguments", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      return "should-not-run";
    });
    await expect(
      mcpCallTool("demo", "lookup", { query: "changed" }, {
        token: "mcp-token",
        detail: mcpApprovalDetail("demo", "lookup", { query: "original" }),
      }),
    ).rejects.toThrow(/does not match/);
    expect(calls).toEqual([]);
  });
});
