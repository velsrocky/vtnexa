// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMcp } from "./useMcp";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

afterEach(() => {
  localStorage.clear();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke")));
});

function setup(impl?: (cmd: string, args?: any) => Promise<any>) {
  setInvokeImpl(
    impl ??
      (async (cmd: string) => {
        if (cmd === "mcp_list_servers") return [];
        if (cmd === "mcp_list_tools") return [];
        throw new Error(`unexpected ${cmd}`);
      }),
  );
  return renderHook(() => useMcp({ workspaceRoot: "/ws" }));
}

describe("useMcp", () => {
  it("starts off with empty servers", () => {
    const { result } = setup();
    expect(result.current.mcpOn).toBe(false);
    expect(result.current.servers).toEqual([]);
  });

  it("loads servers and splits tools vs errors", async () => {
    localStorage.setItem("vtai.mcpEnabled", "1");
    const { result } = setup(async (cmd: string) => {
      if (cmd === "mcp_list_servers")
        return [
          { name: "good", kind: "local", enabled: true },
          { name: "bad", kind: "local", enabled: true },
        ];
      if (cmd === "mcp_list_tools")
        return [
          { server: "good", name: "add", qualified_name: "mcp_good_add", description: "", input_schema: {} },
          { server: "bad", name: "__error__", qualified_name: "mcp_bad_error", description: "spawn failed", input_schema: {} },
        ];
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.servers).toHaveLength(2);
    expect(result.current.toolCount).toBe(1);
    expect(result.current.errorCount).toBe(1);
    expect(result.current.servers.find((s) => s.name === "bad")?.error).toContain("spawn failed");
  });

  it("toggles a server then refreshes", async () => {
    const calls: string[] = [];
    const { result } = setup(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "mcp_list_servers") return [{ name: "s", kind: "local", enabled: true }];
      if (cmd === "mcp_list_tools") return [];
      if (cmd === "mcp_set_server_enabled") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => {
      await result.current.setServerOn("s", false);
    });
    expect(calls).toContain("mcp_set_server_enabled");
  });

  it("loads OAuth status for remote servers, signs in and out", async () => {
    localStorage.setItem("vtai.mcpEnabled", "1");
    const calls: { cmd: string; args?: any }[] = [];
    const { result } = setup(async (cmd: string, args?: any) => {
      calls.push({ cmd, args });
      if (cmd === "mcp_list_servers") return [{ name: "r", kind: "remote", enabled: true }];
      if (cmd === "mcp_list_tools") return [];
      if (cmd === "mcp_oauth_status") return { signed_in: false, expires_in: null, has_refresh: false };
      if (cmd === "mcp_oauth_login") return "signed in to 'r'";
      if (cmd === "mcp_oauth_logout") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.servers[0].auth).toEqual({ signed_in: false, expires_in: null, has_refresh: false });
    await act(async () => {
      await result.current.signIn("r");
    });
    expect(calls.some((c) => c.cmd === "mcp_oauth_login")).toBe(true);
    expect(result.current.signingIn).toBeNull();
    await act(async () => {
      await result.current.signOut("r");
    });
    expect(calls.some((c) => c.cmd === "mcp_oauth_logout")).toBe(true);
  });
});
