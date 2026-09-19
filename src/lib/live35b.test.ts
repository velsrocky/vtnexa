// LIVE integration harness: drives the app's real chatWithTools against a
// local llama.cpp server. Opt-in only: LIVE_35B=1 pnpm exec vitest run src/lib/live35b.test.ts
// The ONLY seam mocked is Tauri invoke (approvals auto-granted, tool results
// canned) — streaming, prompt assembly, tool-call wire format, parsing and
// the turn loop are the production code paths.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatWithTools } from "./providers";

type Cfg = { baseUrl: string; apiKey: string; model: string; kind: "auto" };
const env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

const LIVE = !!env.LIVE_35B;
const BASE = env.LIVE_BASE_URL ?? "http://127.0.0.1:8080/v1";
const MODEL = env.LIVE_MODEL ?? "Ornith-1.5-35B-Q4_K_M";

if (LIVE) {
  // Capture every request body so a provider 500 can be diagnosed against
  // the exact payload (llama.cpp rejects some templates with "No messages").
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    try {
      if (init?.body) {
        const parsed = JSON.parse(init.body);
        const n = Array.isArray(parsed.messages) ? parsed.messages.length : -1;
        const summary = {
          url: String(input),
          nMessages: n,
          roles: Array.isArray(parsed.messages) ? parsed.messages.map((m: any) => m.role) : [],
          model: parsed.model,
          hasTools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        };
        console.log("REQ " + JSON.stringify(summary));
        if (n === 0) console.log("EMPTY-BODY " + init.body.slice(0, 800));
      }
    } catch {
      /* log-only */
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

const CFG: Cfg = { baseUrl: BASE, apiKey: "", model: MODEL, kind: "auto" };
const TOK = { token: "tok-live", detail: "{}" };

// Canned workspace: one fabricated project the agent can inspect.
const ENTRIES = [
  { name: "src", path: "/tmp/live-ws/src", is_dir: true },
  { name: "package.json", path: "/tmp/live-ws/package.json", is_dir: false },
  { name: "README.md", path: "/tmp/live-ws/README.md", is_dir: false },
];
const PKG = JSON.stringify({ name: "live-ws", scripts: { test: "vitest run" } }, null, 2);

function stubBackend() {
  setInvokeImpl(async (cmd: string, args?: any) => {
    switch (cmd) {
      case "fs_list":
        return ENTRIES;
      case "fs_read":
        return args?.path?.endsWith("package.json") ? PKG : "# Live WS\nA tiny test project.";
      case "shell_run":
        return { stdout: "12.3.4\n", stderr: "", code: 0 };
      default:
        throw new Error(`live harness: unexpected invoke ${cmd}: ${JSON.stringify(args).slice(0, 120)}`);
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke")));
});

describe.skipIf(!LIVE)("live 35B @ llama.cpp", () => {
  it(
    "act-first: investigates with fs_list before answering, stays in contract",
    async () => {
      stubBackend();
      let toolCalls = 0;
      let thinking = "";
      const res = await chatWithTools(
        CFG,
        [{ role: "user", content: "List the files in this project and tell me what kind of project it is." }],
        () => {},
        {
          onToolActivity: () => {
            toolCalls++;
          },
          onThinking: (t) => {
            thinking += t;
          },
          signal: AbortSignal.timeout(300_000),
        },
      );
      console.log(
        JSON.stringify({ test: "act-first", toolCalls, thinkingChars: thinking.length, final: res.slice(0, 300) }),
      );
      expect(toolCalls).toBeGreaterThanOrEqual(1);
      expect(res.trim().length).toBeGreaterThan(0);
      expect(res.length).toBeLessThan(1500);
      expect(res).not.toContain("Project skills:");
      expect(res.trimEnd().endsWith("?")).toBe(false);
    },
    360_000,
  );

  it(
    "shell gate: runs shell_run (auto-approved in harness) and reports real output",
    async () => {
      stubBackend();
      const audits: { tool: string; decision: string; ok: boolean; note?: string }[] = [];
      const res = await chatWithTools(
        CFG,
        [{ role: "user", content: "Run `pnpm --version` in the shell and report the exact output." }],
        () => {},
        {
          policy: { requestApproval: async () => TOK } as never,
          onAudit: (e) => audits.push({ tool: e.tool, decision: e.decision, ok: e.ok, note: e.note }),
          signal: AbortSignal.timeout(300_000),
        },
      );
      const shell = audits.filter((a) => a.tool === "shell_run");
      console.log(JSON.stringify({ test: "shell-gate", shell, final: res.slice(0, 300) }));
      expect(shell.length).toBeGreaterThanOrEqual(1);
      expect(shell.every((a) => a.ok)).toBe(true);
      expect(res).toContain("12.3.4");
    },
    360_000,
  );
});
