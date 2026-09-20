// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTool, toolsForMode, type ToolDef } from "./providers";
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

// Policy stubs: TOK = native dialog confirmed, null = rejected/dismissed.
const TOK = { token: "tok-test", detail: "{}" };
const REJECT = { requestApproval: async () => null };

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
    // Unknown MCP tools fail before the gate (still zero invokes — the property).
    if (name.startsWith("mcp_")) {
      expect(out).toMatch(/^error: unknown MCP tool/);
    } else {
      expect(out).toMatch(/^user rejected/);
    }
    expect(calls).toEqual([]);
  });
});

describe("stale renderer modules fail loudly, never silently", () => {
  it("a bare-boolean policy (pre-restart window) is refused before any invoke", async () => {
    setInvokeImpl(async () => {
      throw new Error("must not reach backend");
    });
    // Simulates a zombie window whose useAgentTurn still resolves booleans:
    // truthy, but with no token to send. Must NOT surface as a backend
    // "approval required" — the turn must say restart.
    const out = await runTool("shell_run", { cwd: "/w", cmd: "ls" }, {
      requestApproval: async () => true as unknown as { token: string; detail: string },
    });
    expect(out).toMatch(/handshake broken/);
    expect(out).toMatch(/restart/);
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
    const out = await runTool("mcp_demo_get_issue", { a: 1 }, { requestApproval: async () => TOK });
    expect(out).toBe("42");
    expect(calls.map((c) => c.cmd)).toEqual(["mcp_call_tool"]);
    expect(calls[0].args).toEqual({
      server: "demo",
      tool: "get.Issue",
      args: { a: 1 },
      approval_token: "tok-test",
      approval_detail: "{}",
    });
  });
  it("unknown MCP errors without invoking", async () => {
    const out = await runTool("mcp_nope_x", {}, { requestApproval: async () => TOK });
    expect(out).toMatch(/^error:/);
    expect(calls).toEqual([]);
  });
});

describe("read-only tools need no approval", () => {
  const readable: [string, Record<string, unknown>, unknown][] = [
    ["fs_list", { path: "/w" }, [{ name: "a", path: "/w/a", is_dir: false }]],
    ["fs_read", { path: "/w/a" }, "hello"],
    // Python diagnostics stay approval-free (pure py_compile).
    ["lsp_diagnostics", { path: "/w/a.py" }, "clean: no diagnostics for /w/a.py"],
    ["git_status", { cwd: "/w" }, { branch: "main", root: "/w", files: [] }],
    ["nexa_read", { kind: "pad" }, ""],
  ];
  it.each(readable)("%s runs with zero prompts", async (name, args, backend) => {
    let approvals = 0;
    setInvokeImpl(async () => backend);
    const out = await runTool(name, args, {
      requestApproval: async () => { approvals++; return TOK; },
    });
    expect(out).not.toMatch(/^user rejected/);
    expect(approvals).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("plan mode", () => {
  const PLAN = { requestApproval: async () => TOK, planMode: true };
  it.each([
    ["shell_run", { cwd: "/w", cmd: "ls" }],
    ["fs_write", { path: "/w/a", content: "x" }],
    ["fs_rename", { old_path: "/a", new_path: "/b" }],
    ["fs_delete", { path: "/a" }],
    ["git_commit", { cwd: "/w", message: "m", files: [] }],
    ["browser_navigate", { url: "https://x.test" }],
    ["nexa_write", { kind: "pad", content: "x" }],
    ["mcp_demo_add", { a: 1 }],
    ["teleport", {}],
  ])("%s is refused before any popup or invoke", async (name, args) => {
    const out = await runTool(name, args, PLAN);
    expect(out).toMatch(/^error: plan mode/);
    expect(calls).toEqual([]);
  });
  it("read-only tools still run with zero prompts", async () => {
    let approvals = 0;
    setInvokeImpl(async () => "hello");
    const out = await runTool("fs_read", { path: "/w/a" }, {
      requestApproval: async () => { approvals++; return TOK; },
      planMode: true,
    });
    expect(out).toBe("hello");
    expect(approvals).toBe(0);
  });
});

describe("toolsForMode", () => {
  const base: ToolDef[] = ["fs_read", "shell_run", "fs_write"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: {} },
  }));
  const extra: ToolDef[] = [{ type: "function", function: { name: "mcp_x_y", description: "x", parameters: {} } }];
  it("build keeps everything plus capped extras", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: "function" as const,
      function: { name: `mcp_s_t${i}`, description: "x", parameters: {} },
    }));
    const tools = toolsForMode(base, many, false);
    expect(tools.map((t) => t.function.name)).toContain("shell_run");
    expect(tools.filter((t) => t.function.name.startsWith("mcp_"))).toHaveLength(50);
  });
  it("plan keeps read-only built-ins only, no MCP", () => {
    const names = toolsForMode(base, extra, true).map((t) => t.function.name);
    expect(names).toEqual(["fs_read"]);
  });
});

describe("undo capture for agent rename/delete", () => {
  it("captures renames after success", async () => {
    const captured: unknown[] = [];
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("fs_rename");
      return "renamed";
    });
    const out = await runTool(
      "fs_rename",
      { old_path: "/a", new_path: "/b" },
      { requestApproval: async () => TOK, onUndoCapture: (e) => captured.push(e) },
    );
    expect(out).toBe("renamed");
    expect(captured).toEqual([{ kind: "rename", oldPath: "/a", newPath: "/b" }]);
  });
  it("captures file deletes with content, skips dirs and missing files", async () => {
    const captured: unknown[] = [];
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "body";
      if (cmd === "fs_delete") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    const pol = { requestApproval: async () => TOK, onUndoCapture: (e: unknown) => captured.push(e) };
    const out = await runTool("fs_delete", { path: "/w/a" }, pol);
    expect(out).toBe("deleted /w/a");
    expect(captured).toEqual([{ kind: "delete", path: "/w/a", content: "body" }]);

    captured.length = 0;
    const dirOut = await runTool("fs_delete", { path: "/w/d", recursive: true }, pol);
    expect(dirOut).toMatch(/not undoable/);
    expect(captured).toEqual([]);
  });
});

describe("lsp tool", () => {
  it("passes ops through with approval in Build, blocked in Plan", async () => {
    const seen: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      expect(cmd).toBe("lsp_op");
      seen.push(args);
      return "mock-hover";
    });
    let approvals = 0;
    const pol = {
      requestApproval: async () => { approvals++; return TOK; },
    };
    const out = await runTool("lsp", { op: "hover", path: "/w/a.ts", line: 3 }, pol);
    expect(out).toBe("mock-hover");
    expect(approvals).toBe(1);
    expect(seen[0]).toMatchObject({ op: "hover", path: "/w/a.ts", line: 3 });
    await expect(runTool("lsp", { op: "hover", path: "rel/a.ts" }, pol)).resolves.toMatch(/^error:/);
    await expect(runTool("lsp", { path: "/w/a.ts" }, pol)).resolves.toMatch(/^error:/);
    // Plan mode withholds lsp entirely (executes workspace code).
    const planOut = await runTool(
      "lsp",
      { op: "hover", path: "/w/a.ts", line: 3 },
      { requestApproval: async () => TOK, planMode: true },
    );
    expect(planOut).toMatch(/^error: plan mode/);
  });
});

describe("background shell jobs", () => {
  it("gates start and kill, polls free", async () => {
    const seen: string[] = [];
    setInvokeImpl(async (cmd) => {
      seen.push(cmd);
      if (cmd === "shell_bg") return "job_abc";
      if (cmd === "shell_poll") return { status: "done", code: 0, stdout_tail: "ok", stderr_tail: "", elapsed_ms: 5 };
      if (cmd === "shell_kill") return "killed job_abc";
      throw new Error(`unexpected ${cmd}`);
    });
    const APPROVE = { requestApproval: async () => TOK };
    expect(await runTool("shell_bg", { cwd: "/w", cmd: "sleep 60" }, APPROVE)).toMatch(/job_abc/);
    let approvals = 0;
    const poll = await runTool("shell_poll", { job_id: "job_abc" }, {
      requestApproval: async () => { approvals++; return TOK; },
    });
    expect(poll).toContain("done");
    expect(approvals).toBe(0);
    expect(await runTool("shell_kill", { job_id: "job_abc" }, APPROVE)).toMatch(/killed/);
    expect(seen).toEqual(["shell_bg", "shell_poll", "shell_kill"]);
  });
  it("rejected start never spawns, empty args error", async () => {
    const out = await runTool("shell_bg", { cwd: "/w", cmd: "rm -rf ~" }, REJECT);
    expect(out).toMatch(/^user rejected/);
    expect(calls).toEqual([]);
    await expect(runTool("shell_bg", { cmd: "" }, { requestApproval: async () => TOK })).resolves.toMatch(/^error:/);
    await expect(runTool("shell_poll", {}, { requestApproval: async () => TOK })).resolves.toMatch(/^error:/);
  });
  it("plan mode blocks start/kill but allows poll", async () => {
    setInvokeImpl(async () => ({ status: "running", code: null, stdout_tail: "", stderr_tail: "", elapsed_ms: 1 }));
    const PLAN = { requestApproval: async () => TOK, planMode: true };
    await expect(runTool("shell_bg", { cmd: "make" }, PLAN)).resolves.toMatch(/^error: plan mode/);
    await expect(runTool("shell_kill", { job_id: "job_x" }, PLAN)).resolves.toMatch(/^error: plan mode/);
    expect(calls).toEqual([]);
    const out = await runTool("shell_poll", { job_id: "job_x" }, PLAN);
    expect(out).toContain("running");
  });
});

describe("past sessions", () => {
  const metas = [
    { id: "s1", title: "Fresh scaffold", directory: "/w/txtiqgame", updated: 42, message_count: 6, preview: "scaffolded…" },
  ];
  const file = {
    id: "s1",
    title: "Fresh scaffold",
    directory: "/w/txtiqgame",
    updated: 42,
    workspace: {
      provider: { baseUrl: "http://x", model: "m", apiKey: "SECRET-KEY" },
      chatDraft: "SECRET-DRAFT",
      buffers: { "/w/a": "SECRET-BUFFER" },
      messages: [
        { id: "u1", role: "user", content: "scaffold fresh" },
        { id: "a1", role: "assistant", content: "did it" },
        { id: "s0", role: "system", content: "SECRET-SYSTEM" },
      ],
    },
  };
  it("lists threads with zero prompts", async () => {
    let approvals = 0;
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("sessions_list");
      return JSON.stringify(metas);
    });
    const out = await runTool("sessions_list", {}, {
      requestApproval: async () => { approvals++; return TOK; },
    });
    expect(out).toContain("Fresh scaffold");
    expect(approvals).toBe(0);
  });
  it("reads messages only - keys, drafts, buffers and system prompts never leak", async () => {
    setInvokeImpl(async (cmd) => {
      expect(cmd).toBe("session_get");
      return JSON.stringify(file);
    });
    const out = await runTool("session_read", { id: "s1" }, { requestApproval: async () => TOK });
    expect(out).toContain("scaffold fresh");
    expect(out).toContain("did it");
    expect(out).not.toContain("SECRET");
    await expect(runTool("session_read", {}, { requestApproval: async () => TOK })).resolves.toMatch(/^error:/);
  });
  it("both work in plan mode", async () => {
    setInvokeImpl(async (cmd) => (cmd === "sessions_list" ? JSON.stringify(metas) : JSON.stringify(file)));
    const PLAN = { requestApproval: async () => TOK, planMode: true };
    expect(await runTool("sessions_list", {}, PLAN)).toContain("Fresh scaffold");
    expect(await runTool("session_read", { id: "s1" }, PLAN)).toContain("did it");
  });
});

describe("workspace auto-approval (opencode-style)", () => {
  const autoPolicy = (over: Record<string, any> = {}) => ({
    autoApproveWorkspace: true,
    workspaceRoot: "/w",
    requestApproval: async () => {
      throw new Error("dialog must not appear for confined ops");
    },
    ...over,
  });

  it("confined shell claims silently, never popping a dialog", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "approval_claim") return "tok-auto";
      if (cmd === "shell_run") return { stdout: "hi", stderr: "", code: 0 };
      throw new Error(`unexpected ${cmd}`);
    });
    const out = await runTool("shell_run", { cwd: "/w", cmd: "npm test" }, autoPolicy());
    expect(JSON.parse(out).stdout).toBe("hi");
    expect(calls.map((c) => c.cmd)).toEqual(["approval_claim", "shell_run"]);
    expect((calls[1].args as any).approvalToken).toBe("tok-auto");
  });

  it("shell reaching outside still pops the dialog", async () => {
    let dialogs = 0;
    setInvokeImpl(async (cmd) => {
      if (cmd === "shell_run") return { stdout: "", stderr: "", code: 0 };
      throw new Error(`unexpected ${cmd}`);
    });
    await runTool("shell_run", { cwd: "/w", cmd: "cat ~/.ssh/id_rsa" }, autoPolicy({
      requestApproval: async () => { dialogs++; return TOK; },
    }));
    expect(dialogs).toBe(1);
    expect(calls.map((c) => c.cmd)).toEqual(["shell_run"]);
  });

  it("confined fs_write writes directly with undo captured", async () => {
    const undos: any[] = [];
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "old content";
      if (cmd === "approval_claim") return "tok-auto";
      if (cmd === "fs_write") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const out = await runTool(
      "fs_write",
      { path: "/w/a.txt", content: "new content" },
      autoPolicy({ onUndoCapture: (e: any) => undos.push(e) }),
    );
    expect(out).toMatch(/wrote \/w\/a\.txt.*directly/);
    expect(undos).toEqual([
      { kind: "write", path: "/w/a.txt", before: "old content", after: "new content", existedBefore: true },
    ]);
    expect(calls.map((c) => c.cmd)).toEqual(["fs_read", "approval_claim", "fs_write"]);
  });

  it("direct write of a new file marks existedBefore false", async () => {
    const undos: any[] = [];
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") throw new Error("not found");
      if (cmd === "approval_claim") return "tok-auto";
      if (cmd === "fs_write") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    await runTool(
      "fs_write",
      { path: "/w/new.txt", content: "x" },
      autoPolicy({ onUndoCapture: (e: any) => undos.push(e) }),
    );
    expect(undos[0].existedBefore).toBe(false);
  });

  it("outside-root fs_write falls back to Diff staging", async () => {
    const staged: any[] = [];
    setInvokeImpl(async () => {
      throw new Error("must not invoke for unconfined write");
    });
    const out = await runTool(
      "fs_write",
      { path: "/etc/x.txt", content: "x" },
      autoPolicy({ onProposeWrite: async (p: string, c: string) => { staged.push([p, c]); } }),
    );
    expect(out).toMatch(/staged .* Diff review gate/);
    expect(staged).toEqual([["/etc/x.txt", "x"]]);
    expect(calls).toEqual([]);
  });

  it("browser and MCP tools always keep the dialog", async () => {
    setMcpToolCache([
      { server: "demo", name: "add", qualified_name: "mcp_demo_add", description: "", input_schema: {} },
    ]);
    setInvokeImpl(async () => ({}));
    let dialogs = 0;
    const counting = autoPolicy({ requestApproval: async () => { dialogs++; return TOK; } });
    await runTool("browser_navigate", { url: "https://x.test" }, counting);
    await runTool("mcp_demo_add", { a: 1 }, counting);
    expect(dialogs).toBe(2);
  });

  it("disabled flag preserves the old gated behavior", async () => {
    let dialogs = 0;
    setInvokeImpl(async (cmd) => {
      if (cmd === "shell_run") return { stdout: "", stderr: "", code: 0 };
      throw new Error(`unexpected ${cmd}`);
    });
    await runTool("shell_run", { cwd: "/w", cmd: "ls" }, {
      autoApproveWorkspace: false,
      workspaceRoot: "/w",
      requestApproval: async () => { dialogs++; return TOK; },
    });
    expect(dialogs).toBe(1);
  });
});
