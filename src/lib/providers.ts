import type { ProviderConfig, ProviderKind } from "../types";
import {
  fsCreate,
  fsDelete,
  fsGlob,
  fsList,
  fsRead,
  fsRename,
  fsSearch,
  fsWrite,
  skillList,
  skillRead,
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
  nexaRead,
  nexaWrite,
  shellRun,
  type NexaKind,
} from "./tauri";
import {
  browserBack,
  browserClick,
  browserNavigate,
  browserScreenshot,
  browserScroll,
  browserSnapshot,
  browserStart,
  browserType,
} from "./browser";

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolPolicy {
  /** Agent fs_write no longer writes directly: stage into Diff review gate.
   *  May be async - the UI fetches the on-disk original for a faithful diff. */
  onProposeWrite?: (path: string, content: string) => void | Promise<void>;
  /** Return true to allow shell/browser side-effects, false to reject. Read-only tools bypass this. */
  requestApproval?: (tool: string, args: Record<string, any>) => Promise<boolean>;
  /** Agent wrote a Nexa note directly: mirror it into the sidebar state. */
  onNexaWrite?: (kind: NexaKind, content: string) => void;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "fs_list",
      description: "List directory entries (absolute path, read-only)",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_read",
      description: "Read a text file (absolute path, read-only, 2MB max)",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_search",
      description:
        "Search file contents across the workspace (grep-like). Returns {path, line, text} matches. Default: case-insensitive literal substring. Set regex=true for regex. Optional path (subdir, absolute) and glob (filename filter). Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          case_sensitive: { type: "boolean" },
          regex: { type: "boolean" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_glob",
      description:
        "Find files by name pattern (* = any sequence, ? = one char; comma-separated for multiple). Returns relative paths. Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_list",
      description:
        "List project skills (.vtnexa/skills/*.md) as {name, description}. Read-only, auto-approved.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_read",
      description:
        "Read a project skill's full instructions by name. Use when the task matches a skill. Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_create",
      description:
        "Create an empty file (parents included) or, with is_dir=true, a directory. Errors if it exists. Read-only-ish, auto-approved.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, is_dir: { type: "boolean" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_rename",
      description: "Rename/move a file or directory (absolute paths, target must not exist). REQUIRES user approval.",
      parameters: {
        type: "object",
        properties: { old_path: { type: "string" }, new_path: { type: "string" } },
        required: ["old_path", "new_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_delete",
      description:
        "Delete a file, or a directory (needs recursive=true for non-empty dirs). Permanent. REQUIRES user approval.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, recursive: { type: "boolean" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Show git branch + changed files for the repo containing cwd (absolute dir). Read-only, auto-approved. Errors when cwd is not in a git repo.",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string" } },
        required: ["cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Show uncommitted diff (set staged=true for staged). Optional path (absolute file) to limit output. Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          path: { type: "string" },
          staged: { type: "boolean" },
        },
        required: ["cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent commits (hash, author, date, message). Read-only, auto-approved.",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string" }, limit: { type: "number" } },
        required: ["cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description:
        "Stage ONLY the listed files (absolute paths) and commit with message. Prefer small commits with clear messages. REQUIRES user approval.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          message: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
        required: ["cwd", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write",
      description: "PROPOSE a file write (staged to Diff review gate, needs user Approve - does NOT write directly)",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_run",
      description: "Run a shell command via sh -c (REQUIRES user approval, cwd must be absolute dir)",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string" }, cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate the Browser Use tab to a URL (REQUIRES user approval)",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Read current page: url, title, text and clickable elements with refs",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click a page element by its snapshot ref (REQUIRES user approval)",
      parameters: { type: "object", properties: { target_ref: { type: "number" } }, required: ["target_ref"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Fill a text input by its snapshot ref (REQUIRES user approval)",
      parameters: {
        type: "object",
        properties: { target_ref: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" } },
        required: ["target_ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Capture the page as a screenshot that YOU CAN SEE (vision - the image is attached to the conversation). Use it to verify layout, styling, and errors. Also viewable in the Browser tab.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_back",
      description: "Go back one page in browser history (REQUIRES user approval)",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the page by dx/dy pixels (read-only-ish, no approval needed)",
      parameters: {
        type: "object",
        properties: { dx: { type: "number" }, dy: { type: "number" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nexa_read",
      description: "Read the shared Nexa notes (pad = scratch, plan = agreed work, memory = durable cross-session context). Auto-approved, always fresh - prefer over guessing.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["pad", "plan", "memory"] },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nexa_write",
      description: "Update a shared Nexa note (writes .nexa/{pad,plan,memory}.md directly, visible in sidebar - keep short, 16KB max. Use memory for durable decisions and cross-session context; pad for scratch; plan for agreed work.)",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["pad", "plan", "memory"] },
          content: { type: "string" },
        },
        required: ["kind", "content"],
      },
    },
  },
];

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/** List models the endpoint actually serves. Tries OpenAI-style /models,
 *  then Ollama-native /api/tags (covers baseUrls with or without /v1).
 *  Returns [] when unreachable - never throws. */
export async function listModels(cfg: ProviderConfig): Promise<string[]> {
  const base = cfg.baseUrl.replace(/\/$/, "");
  if (!base) return [];
  const headers: Record<string, string> = {
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
  try {
    const r = await fetch(base + "/models", { headers });
    if (r.ok) {
      const d = await r.json();
      const ids = ((d?.data ?? []) as unknown[])
        .map((m) => (m as { id?: unknown })?.id)
        .filter((x): x is string => typeof x === "string" && x.length > 0);
      if (ids.length) return ids;
    }
  } catch {
    /* fall through */
  }
  // Anthropic native model list.
  if (/api\.anthropic\.com/.test(base) && cfg.apiKey) {
    try {
      const r = await fetch(base + "/models", {
        headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      });
      if (r.ok) {
        const d = await r.json();
        const ids = ((d?.data ?? []) as unknown[])
          .map((m) => (m as { id?: unknown })?.id)
          .filter((x): x is string => typeof x === "string" && x.length > 0);
        if (ids.length) return ids;
      }
    } catch {
      /* fall through */
    }
  }
  // Gemini native model list.
  if (/generativelanguage\.googleapis\.com/.test(base) && cfg.apiKey) {
    try {
      const r = await fetch(base + "/models", {
        headers: { "x-goog-api-key": cfg.apiKey },
      });
      if (r.ok) {
        const d = await r.json();
        const names = ((d?.models ?? []) as unknown[])
          .map((m) => String((m as { name?: unknown })?.name ?? "").replace(/^models\//, ""))
          .filter((x) => x.length > 0);
        if (names.length) return names;
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const r = await fetch(base.replace(/\/v1$/, "") + "/api/tags", { headers });
    if (r.ok) {
      const d = await r.json();
      const names = ((d?.models ?? []) as unknown[])
        .map((m) => (m as { name?: unknown })?.name)
        .filter((x): x is string => typeof x === "string" && x.length > 0);
      if (names.length) return names;
    }
  } catch {
    /* unreachable */
  }
  return [];
}

// Approximate prices per 1M tokens (USD). Local endpoints and well-known
// local model families cost $0. Unknown cloud models return undefined
// (show tokens, no $) rather than a wrong number.
const PRICE_PER_MTOK: [RegExp, { in: number; out: number }][] = [
  [/opus/i, { in: 15, out: 75 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/haiku-3\.5|haiku3\.5/i, { in: 0.8, out: 4 }],
  [/haiku/i, { in: 0.25, out: 1.25 }],
  [/gpt-4o-mini/i, { in: 0.15, out: 0.6 }],
  [/gpt-4\.1-mini/i, { in: 0.4, out: 1.6 }],
  [/gpt-4o/i, { in: 2.5, out: 10 }],
  [/gpt-4\.1/i, { in: 2, out: 8 }],
  [/^o1/i, { in: 15, out: 60 }],
  [/o3-mini|o4-mini/i, { in: 1.1, out: 4.4 }],
  [/gemini-2\.5-pro/i, { in: 1.25, out: 10 }],
  [/gemini-2\.5-flash|gemini-2\.0-flash/i, { in: 0.3, out: 2.5 }],
  [/gemini-1\.5-pro/i, { in: 1.25, out: 5 }],
  [/gemini-1\.5-flash/i, { in: 0.075, out: 0.3 }],
  [/grok-3/i, { in: 3, out: 15 }],
  [/grok-2/i, { in: 2, out: 10 }],
  [/deepseek.*reasoner|\br1\b/i, { in: 0.55, out: 2.19 }],
  [/deepseek/i, { in: 0.27, out: 1.1 }],
  [/kimi|moonshot/i, { in: 0.6, out: 2.4 }],
];

const LOCAL_MODEL_RE =
  /localhost|127\.0\.0\.1|ollama|llama|qwen|mistral|mixtral|phi-|gemma|gguf/i;

export function estimateCost(
  baseUrl: string,
  model: string,
  input: number,
  output: number,
): number | undefined {
  if (LOCAL_MODEL_RE.test(baseUrl) || LOCAL_MODEL_RE.test(model)) return 0;
  for (const [re, p] of PRICE_PER_MTOK) {
    if (re.test(model)) return (input / 1e6) * p.in + (output / 1e6) * p.out;
  }
  return undefined;
}

// Screenshot vision stash: browser_screenshot stores JPEG base64 here keyed by
// token; chatWithTools attaches it to a synthetic user message so the model
// actually SEES the page. Bounded to avoid unbounded memory growth.
const pendingImages = new Map<string, string>();

function stashImage(b64: string): string {
  const id = `img_${Math.random().toString(36).slice(2, 10)}`;
  pendingImages.set(id, b64);
  while (pendingImages.size > 20) {
    const first = pendingImages.keys().next().value;
    if (first === undefined) break;
    pendingImages.delete(first);
  }
  return id;
}

// Side-effecting tools require explicit user approval. Read-only tools run
// directly. Shared with chatWithTools so audit events record the decision.
const GATED_TOOLS = new Set([
  "shell_run",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_back",
  "git_commit",
  "fs_rename",
  "fs_delete",
]);

export async function runTool(
  name: string,
  args: Record<string, any>,
  policy?: ToolPolicy,
): Promise<string> {
  const needsApproval = GATED_TOOLS;
  try {
    if (needsApproval.has(name) && policy?.requestApproval) {
      const ok = await policy.requestApproval(name, args);
      if (!ok) return `user rejected ${name} - do not retry without changing the plan`;
    }
    switch (name) {
      case "fs_list":
        return JSON.stringify(await fsList(args.path));
      case "fs_read":
        return (await fsRead(args.path)).slice(0, 60000);
      case "skill_list":
        return JSON.stringify(await skillList());
      case "skill_read":
        return (await skillRead(String(args.name ?? ""))).slice(0, 30000);
      case "fs_create":
        return await fsCreate(String(args.path ?? ""), !!args.is_dir);
      case "fs_rename":
        return await fsRename(String(args.old_path ?? ""), String(args.new_path ?? ""));
      case "fs_delete":
        await fsDelete(String(args.path ?? ""), !!args.recursive);
        return `deleted ${args.path}`;
      case "fs_search": {
        const res = await fsSearch(
          String(args.query ?? ""),
          args.path ? String(args.path) : undefined,
          args.glob ? String(args.glob) : undefined,
          !!args.case_sensitive,
          !!args.regex,
        );
        return JSON.stringify(res).slice(0, 30000);
      }
      case "fs_glob": {
        const res = await fsGlob(
          String(args.pattern ?? ""),
          args.path ? String(args.path) : undefined,
        );
        return JSON.stringify(res).slice(0, 30000);
      }
      case "fs_write": {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!path || !path.startsWith("/")) return "error: fs_write path must be absolute";
        if (content.length > 4 * 1024 * 1024) return "error: fs_write content too large (4MB max)";
        if (policy?.onProposeWrite) {
          await policy.onProposeWrite(path, content);
          return `staged ${path} (${content.length} chars) to Diff review gate - awaiting user Approve. Do not re-send unless content changes.`;
        }
        await fsWrite(path, content);
        return "ok (direct write - no review gate configured)";
      }
      case "shell_run": {
        const cmd = String(args.cmd ?? "");
        if (cmd.length > 20000) return "error: cmd too long";
        return JSON.stringify(await shellRun(args.cwd ?? ".", cmd));
      }
      case "git_status":
        return JSON.stringify(await gitStatus(String(args.cwd ?? ".")));
      case "git_diff": {
        const d = await gitDiff(
          String(args.cwd ?? "."),
          args.path ? String(args.path) : undefined,
          !!args.staged,
        );
        return d.slice(0, 30000);
      }
      case "git_log":
        return JSON.stringify(
          await gitLog(String(args.cwd ?? "."), args.limit ? Number(args.limit) : undefined),
        );
      case "git_commit": {
        const files = Array.isArray(args.files) ? args.files.map((f: unknown) => String(f)) : undefined;
        return JSON.stringify(
          await gitCommit(String(args.cwd ?? "."), String(args.message ?? ""), files),
        );
      }
      case "browser_navigate":
        await browserStart(39317, false).catch(() => {});
        return JSON.stringify(await browserNavigate(args.url));
      case "browser_snapshot":
        await browserStart(39317, false).catch(() => {});
        return JSON.stringify(await browserSnapshot()).slice(0, 6000);
      case "browser_click":
        return JSON.stringify(await browserClick(Number(args.target_ref)));
      case "browser_type":
        return JSON.stringify(await browserType(Number(args.target_ref), args.text ?? "", !!args.submit));
      case "browser_screenshot": {
        const s = await browserScreenshot();
        const b64 = s.imageBase64 ?? "";
        const kb = Math.round(((b64.length * 3) / 4 / 1024) * 10) / 10;
        if (b64) {
          const id = stashImage(b64);
          return JSON.stringify({
            url: s.url,
            kb,
            image: id,
            note: "screenshot attached to conversation - you can SEE it. Also viewable in the Browser tab.",
          });
        }
        return JSON.stringify({ url: s.url, note: "screenshot came back empty" });
      }
      case "browser_back":
        return JSON.stringify(await browserBack());
      case "browser_scroll":
        return JSON.stringify(await browserScroll(Number(args.dx ?? 0), Number(args.dy ?? 600)));
      case "nexa_read": {
        const kind = (args.kind === "plan" || args.kind === "memory" ? args.kind : "pad") as NexaKind;
        return await nexaRead(kind);
      }
      case "nexa_write": {
        const kind = (args.kind === "plan" || args.kind === "memory" ? args.kind : "pad") as NexaKind;
        const content = String(args.content ?? "");
        if (content.length > 16 * 1024) return "error: nexa content too large (16KB max - keep notes short)";
        await nexaWrite(kind as NexaKind, content);
        policy?.onNexaWrite?.(kind as NexaKind, content);
        return `ok - ${kind} updated (${content.length} chars), visible in sidebar`;
      }
      default:
        return `unknown tool: ${name}`;
    }
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

export async function chatWithTools(
  cfg: ProviderConfig,
  messages: { role: string; content: string }[],
  onEvent: (text: string) => void,
  opts?: {
    policy?: ToolPolicy;
    /** AbortSignal from the Stop button: kills in-flight fetches and ends the loop. */
    signal?: AbortSignal;
    onUsage?: (u: { input: number; output: number; model: string; cost?: number }) => void;
    onToolActivity?: (a: { name: string; ms: number; ok: boolean }) => void;
    onAudit?: (e: {
      tool: string;
      args: string;
      decision: "auto" | "approved" | "rejected";
      ok: boolean;
      ms: number;
      note?: string;
    }) => void;
  },
): Promise<string> {
  // Multi-backend agent loop (OpenAI-compatible, Anthropic, Gemini) with tool
  // calling. Models without tool support (e.g. some Ollama vision models) get
  // a plain-chat retry instead of a hard failure.
  const MAX_ROUNDS = 8;
  // History window: a long lane currently resends EVERYTHING each turn —
  // unbounded payloads that gateways kill mid-flight ("Load failed").
  // Keep sys + last 20, cutting only at user boundaries so tool
  // request/response pairs are never orphaned (orphans → provider 400).
  const HIST_KEEP = 20;
  // Normalized message shared by all backends. Assistant entries may carry
  // tool_calls; tool results use role "tool" + tool_call_id.
  interface NormMsg {
    role: string;
    content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    /** JPEG base64 screenshots (vision). Set on synthetic user messages. */
    images?: string[];
  }
  function windowConvo<T extends { role: string }>(msgs: T[], keep: number = HIST_KEEP): T[] {
    if (msgs.length <= keep + 1) return [...msgs];
    const sys = msgs[0];
    let tail = msgs.slice(-keep);
    const cut = tail.findIndex((m) => m.role === "user");
    if (cut > 0) tail = tail.slice(cut);
    else if (cut < 0) tail = tail.filter((m) => m.role !== "tool");
    const out = (sys.role === "system" ? [sys, ...tail] : [...tail]) as T[];
    // Trimming may have dropped tool results while keeping their assistant
    // calls. A dangling tool_calls is a 400 on strict backends, so demote any
    // assistant call without a recorded result back to plain text.
    const resultIds = new Set(
      out
        .filter((m) => (m as unknown as NormMsg).role === "tool")
        .map((m) => (m as unknown as NormMsg).tool_call_id ?? ""),
    );
    for (let i = 0; i < out.length; i++) {
      const m = out[i] as unknown as NormMsg;
      if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const kept = m.tool_calls.filter((tc) => resultIds.has(tc.id));
        if (kept.length === 0) {
          const { tool_calls: _dropped, ...rest } = m;
          out[i] = rest as unknown as T;
        } else if (kept.length !== m.tool_calls.length) {
          out[i] = { ...m, tool_calls: kept } as unknown as T;
        }
      }
    }
    // Trimming + demotion can leave consecutive same-role messages (e.g. two
    // plain assistants at the tail). Strict gateways 400 on those, so merge
    // their text. Tool messages are never merged (each carries its own
    // tool_call_id), nor are messages with pending calls or images.
    const merged: T[] = [];
    for (const m of out) {
      const nm = m as unknown as NormMsg;
      const last = (merged.length > 0 ? merged[merged.length - 1] : undefined) as unknown as
        | NormMsg
        | undefined;
      if (
        last &&
        (nm.role === "user" || nm.role === "assistant") &&
        last.role === nm.role &&
        typeof last.content === "string" &&
        typeof nm.content === "string" &&
        !last.tool_calls?.length &&
        !nm.tool_calls?.length &&
        !last.images?.length &&
        !nm.images?.length
      ) {
        const joined = last.content ? (nm.content ? `${last.content}\n${nm.content}` : last.content) : (nm.content ?? "");
        merged[merged.length - 1] = { ...(merged[merged.length - 1] as object), content: joined } as unknown as T;
      } else {
        merged.push(m);
      }
    }
    return merged;
  }
  // Tool results kept in conversation history are capped: full outputs
  // (fs_read allows 60KB) would blow small models' context and kill the
  // final summary round with a 400/413. Display slice stays 2000 chars.
  const CONVO_TOOL_CAP = 4000;
  const capForConvo = (out: string) =>
    out.length > CONVO_TOOL_CAP ? out.slice(0, CONVO_TOOL_CAP) + `\n…[trimmed ${out.length - CONVO_TOOL_CAP} chars]` : out;
  let convo: NormMsg[] = [...messages];
  let useTools = true;
  const signal = opts?.signal;
  const abortError = () => {
    const e = new Error("turn stopped");
    e.name = "AbortError";
    return e;
  };
  // Some OpenAI-compatible servers (older vLLM, certain proxies) reject
  // stream_options outright with a 400. One retry without it, not always.
  let preferStreamOptions = true;
  // Loop guard: weak models re-issue the same calls forever. 3x identical = stuck.
  const seen = new Map<string, number>();
  const usedTools: string[] = [];
  let loopNote = "";

  // ---- Provider backends ----
  interface BackendUsage {
    input: number;
    output: number;
  }

  interface BackendResult {
    content: string;
    toolCalls: ToolCall[];
    usage?: BackendUsage;
  }

  function resolveKind(): "openai" | "anthropic" | "gemini" {
    const k = cfg.kind as ProviderKind | undefined;
    if (k && k !== "auto") return k;
    const base = cfg.baseUrl;
    if (/api\.anthropic\.com/.test(base)) return "anthropic";
    if (/generativelanguage\.googleapis\.com/.test(base)) return "gemini";
    return "openai";
  }

  // POST JSON with connect-level retry. Only the fetch() is retried (never a
  // partially-read body). HTTP errors throw with {status, body} attached.
  async function postJSON(
    url: string,
    headers: Record<string, string>,
    payload: unknown,
  ): Promise<Response> {
    let res: Response | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw abortError();
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
        break;
      } catch (e) {
        if (signal?.aborted) throw abortError();
        lastErr = e;
      }
    }
    if (!res) {
      const detail =
        lastErr instanceof TypeError ? `${lastErr.message} (network)` : String((lastErr as Error)?.message ?? lastErr);
      throw new Error(`request failed: ${detail} - check connection/baseUrl, then retry`);
    }
    if (!res.ok) {
      const txt = await res.text();
      const err = new Error(`provider ${res.status}: ${txt}`) as Error & { status?: number; body?: string };
      err.status = res.status;
      err.body = txt;
      throw err;
    }
    return res;
  }

  // Invoke onData(parsed JSON) for every `data:` line of an SSE stream.
  async function forEachSSE(res: Response, onData: (json: any) => void): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          onData(JSON.parse(payload));
        } catch {
          /* skip malformed chunk */
        }
      }
    }
  }

  function reportUsage(u: BackendUsage | undefined) {
    if (!u) return;
    opts?.onUsage?.({
      input: u.input,
      output: u.output,
      model: cfg.model,
      cost: estimateCost(cfg.baseUrl, cfg.model, u.input, u.output),
    });
  }

  // Normalized convo → OpenAI chat format. User vision images become
  // content-part arrays; assistant tool_calls gain the spec-required
  // `type: "function"` (strict gateways 500 without it); the internal
  // `images` key is stripped everywhere.
  function toOpenAI(convo: NormMsg[]): any[] {
    return convo.map((m) => {
      if (m.role === "user" && m.images?.length) {
        return {
          role: "user",
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.images.map((b64) => ({
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${b64}` },
            })),
          ],
        };
      }
      const { images: _dropped, ...rest } = m;
      if (rest.role === "assistant" && Array.isArray((rest as NormMsg).tool_calls)) {
        return {
          ...rest,
          tool_calls: (rest as NormMsg).tool_calls!.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        };
      }
      return rest;
    });
  }

  async function openaiComplete(
    convo: NormMsg[],
    useTools: boolean,
    onDelta: (text: string) => void,
  ): Promise<BackendResult> {
    const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    };
    const res = await postJSON(url, headers, {
      model: cfg.model,
      messages: toOpenAI(convo),
      ...(useTools ? { tools: TOOL_DEFS } : {}),
      stream: true,
      ...(preferStreamOptions ? { stream_options: { include_usage: true } } : {}),
    });

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      const data = (await res.json()) as {
        choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = data.choices?.[0]?.message;
      const content = (msg?.content ?? "") as string;
      if (content) onDelta(content);
      const u = data.usage;
      return {
        content,
        toolCalls: (msg?.tool_calls ?? []) as ToolCall[],
        usage: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 } : undefined,
      };
    }

    let content = "";
    interface StreamTool {
      index: number;
      id: string;
      name: string;
      argsBuf: string;
    }
    const toolAcc: StreamTool[] = [];
    let usage: BackendUsage | undefined;
    await forEachSSE(res, (chunk) => {
      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number(tc.index ?? 0);
          let slot = toolAcc.find((t) => t.index === idx);
          if (!slot) {
            slot = { index: idx, id: "", name: "", argsBuf: "" };
            toolAcc.push(slot);
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = slot.name ? slot.name + tc.function.name : tc.function.name;
          if (tc.function?.arguments) slot.argsBuf += tc.function.arguments;
        }
      }
    });
    return {
      content,
      toolCalls: toolAcc.map((t) => ({
        id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        function: { name: t.name, arguments: t.argsBuf },
      })),
      usage,
    };
  }

  // Normalized convo → Anthropic Messages API. Merges consecutive same-role
  // messages (Anthropic requires strict user/assistant alternation) and drops
  // orphan tool results (a tool_result must follow its tool_use).
  function toAnthropic(convo: NormMsg[]): { system: string; messages: any[] } {
    const systemParts: string[] = [];
    const messages: any[] = [];
    const seenToolIds = new Set<string>();
    const push = (role: "user" | "assistant", content: any) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) {
        if (typeof last.content === "string" && typeof content === "string") {
          last.content += "\n" + content;
        } else {
          const a = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
          const b = typeof content === "string" ? [{ type: "text", text: content }] : content;
          last.content = [...a, ...b];
        }
        return;
      }
      messages.push({ role, content });
    };
    for (const m of convo) {
      if (m.role === "system") {
        if (m.content) systemParts.push(m.content);
        continue;
      }
      if (m.role === "user") {
        if (m.images?.length) {
          const blocks: any[] = [];
          if (m.content) blocks.push({ type: "text", text: m.content });
          for (const b64 of m.images) {
            blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
          }
          push("user", blocks);
        } else if (m.content) {
          push("user", m.content);
        }
        continue;
      }
      if (m.role === "assistant") {
        const tools = m.tool_calls ?? [];
        if (!tools.length) {
          if (m.content) push("assistant", m.content);
          continue;
        }
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of tools) {
          seenToolIds.add(tc.id);
          let input: any = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* keep {} */
          }
          if (typeof input !== "object" || input === null || Array.isArray(input)) input = {};
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        push("assistant", blocks);
        continue;
      }
      if (m.role === "tool") {
        const id = m.tool_call_id ?? "";
        if (!seenToolIds.has(id)) continue;
        push("user", [{ type: "tool_result", tool_use_id: id, content: m.content ?? "" }]);
        continue;
      }
    }
    return { system: systemParts.join("\n"), messages };
  }

  async function anthropicComplete(
    convo: NormMsg[],
    useTools: boolean,
    onDelta: (text: string) => void,
  ): Promise<BackendResult> {
    const base = cfg.baseUrl.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      // Required for browser/WebView fetch; without it Anthropic blocks CORS.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    const { system, messages } = toAnthropic(convo);
    const res = await postJSON(base + "/messages", headers, {
      model: cfg.model,
      max_tokens: 8192,
      ...(system ? { system } : {}),
      messages,
      ...(useTools
        ? {
            tools: TOOL_DEFS.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            })),
          }
        : {}),
      stream: true,
    });

    let content = "";
    const toolByIndex = new Map<number, { id: string; name: string; argsBuf: string }>();
    let usage: BackendUsage | undefined;
    await forEachSSE(res, (ev) => {
      const t = ev.type;
      if (t === "message_start") {
        const u = ev.message?.usage;
        if (u) usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
      } else if (t === "content_block_start") {
        const b = ev.content_block;
        const idx = Number(ev.index ?? 0);
        if (b?.type === "tool_use") {
          toolByIndex.set(idx, { id: b.id ?? "", name: b.name ?? "", argsBuf: "" });
        }
      } else if (t === "content_block_delta") {
        const d = ev.delta;
        const idx = Number(ev.index ?? 0);
        if (d?.type === "text_delta" && typeof d.text === "string" && d.text) {
          content += d.text;
          onDelta(d.text);
        } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
          const slot = toolByIndex.get(idx);
          if (slot) slot.argsBuf += d.partial_json;
        }
      } else if (t === "message_delta") {
        const u = ev.usage;
        if (u) usage = { input: usage?.input ?? 0, output: u.output_tokens ?? usage?.output ?? 0 };
      }
    });
    return {
      content,
      toolCalls: [...toolByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, s]) => ({
          id: s.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          function: { name: s.name, arguments: s.argsBuf },
        })),
      usage,
    };
  }

  // Gemini function schemas use UPPERCASE type enums; convert ours recursively.
  function toGeminiSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(toGeminiSchema);
    if (schema && typeof schema === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
        out[k] = k === "type" && typeof v === "string" ? v.toUpperCase() : toGeminiSchema(v);
      }
      return out;
    }
    return schema;
  }

  // Normalized convo → Gemini contents. Merges consecutive same-role parts
  // (Gemini requires user/model alternation); tool results carry the function
  // name looked up from the preceding functionCall.
  function toGemini(convo: NormMsg[]): { systemInstruction?: any; contents: any[] } {
    let system = "";
    const contents: any[] = [];
    const idToName = new Map<string, string>();
    const push = (role: "user" | "model", parts: any[]) => {
      if (!parts.length) return;
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
        return;
      }
      contents.push({ role, parts });
    };
    for (const m of convo) {
      if (m.role === "system") {
        if (m.content) system += (system ? "\n" : "") + m.content;
        continue;
      }
      if (m.role === "user") {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const b64 of m.images ?? []) {
          parts.push({ inlineData: { mimeType: "image/jpeg", data: b64 } });
        }
        push("user", parts);
        continue;
      }
      if (m.role === "assistant") {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls ?? []) {
          idToName.set(tc.id, tc.function.name);
          let args: any = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* keep {} */
          }
          if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
        push("model", parts);
        continue;
      }
      if (m.role === "tool") {
        const name = idToName.get(m.tool_call_id ?? "");
        if (!name) continue;
        push("user", [{ functionResponse: { name, response: { result: m.content ?? "" } } }]);
        continue;
      }
    }
    return {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
    };
  }

  async function geminiComplete(
    convo: NormMsg[],
    useTools: boolean,
    onDelta: (text: string) => void,
  ): Promise<BackendResult> {
    const base = cfg.baseUrl.replace(/\/$/, "");
    const url = `${base}/models/${cfg.model}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { "x-goog-api-key": cfg.apiKey } : {}),
    };
    const { systemInstruction, contents } = toGemini(convo);
    const res = await postJSON(url, headers, {
      ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
      contents,
      ...(useTools
        ? {
            tools: [
              {
                functionDeclarations: TOOL_DEFS.map((t) => ({
                  name: t.function.name,
                  description: t.function.description,
                  parameters: toGeminiSchema(t.function.parameters),
                })),
              },
            ],
          }
        : {}),
    });

    let content = "";
    const fnArgs = new Map<string, any>();
    const fnOrder: string[] = [];
    let usage: BackendUsage | undefined;
    const handleChunk = (chunk: any) => {
      const um = chunk.usageMetadata;
      if (um) {
        usage = { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0 };
      }
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === "string" && p.text) {
          content += p.text;
          onDelta(p.text);
        }
        if (p.functionCall) {
          const name = String(p.functionCall.name ?? "");
          const args = p.functionCall.args;
          if (name) {
            if (!fnArgs.has(name)) {
              fnArgs.set(name, {});
              fnOrder.push(name);
            }
            if (args && typeof args === "object" && !Array.isArray(args)) {
              fnArgs.set(name, { ...fnArgs.get(name), ...args });
            }
          }
        }
      }
    };

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      const data = await res.json();
      for (const c of Array.isArray(data) ? data : [data]) handleChunk(c);
    } else {
      await forEachSSE(res, handleChunk);
    }
    return {
      content,
      toolCalls: fnOrder.map((name, i) => ({
        id: `call_g${i}_${Math.random().toString(36).slice(2, 8)}`,
        function: { name, arguments: JSON.stringify(fnArgs.get(name) ?? {}) },
      })),
      usage,
    };
  }

  // Keep only the newest `keep` screenshots in what we SEND. Old images age
  // out of context instead of eating it forever. Operates on a copy - the
  // live history is untouched (and images never persist to session.json).
  function pruneImages(convo: NormMsg[], keep = 2): NormMsg[] {
    let remaining = keep;
    const out = convo.map((m) => ({ ...m }));
    for (let i = out.length - 1; i >= 0; i--) {
      const imgs = out[i].images;
      if (!imgs?.length) continue;
      if (remaining <= 0) {
        delete out[i].images;
      } else if (imgs.length > remaining) {
        out[i] = { ...out[i], images: imgs.slice(-remaining) };
        remaining = 0;
      } else {
        remaining -= imgs.length;
      }
    }
    return out;
  }

  async function backendComplete(
    convo: NormMsg[],
    useTools: boolean,
    onDelta: (text: string) => void,
  ): Promise<BackendResult> {
    const pruned = pruneImages(convo, 2);
    const kind = resolveKind();
    if (kind === "anthropic") return anthropicComplete(pruned, useTools, onDelta);
    if (kind === "gemini") return geminiComplete(pruned, useTools, onDelta);
    return openaiComplete(pruned, useTools, onDelta);
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) throw abortError();
    let content: string;
    let toolCalls: ToolCall[];
    try {
      const r = await backendComplete(windowConvo(convo), useTools, (delta) => onEvent(delta));
      reportUsage(r.usage);
      content = r.content;
      toolCalls = r.toolCalls;
    } catch (e) {
      const err = e as Error & { status?: number; body?: string };
      if (useTools && err.status === 400 && /tool/i.test(err.body ?? "")) {
        useTools = false;
        onEvent("\n[note: this model does not support tools - continuing in plain chat mode]\n");
        continue;
      }
      if (preferStreamOptions && err.status === 400 && /stream_options/i.test(err.body ?? "")) {
        preferStreamOptions = false;
        onEvent("\n[note: endpoint rejected stream_options - retrying without usage stats]\n");
        continue;
      }
      throw e;
    }

    if (toolCalls.length === 0) {
      return content;
    }

    convo.push({ role: "assistant", content, tool_calls: toolCalls });
    const roundImages: string[] = [];
    for (const tc of toolCalls) {
      let args: Record<string, string> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      const sig = `${tc.function.name}:${tc.function.arguments || "{}"}`;
      seen.set(sig, (seen.get(sig) ?? 0) + 1);
      usedTools.push(tc.function.name);
      const t0 = performance.now();
      const out = await runTool(tc.function.name, args, opts?.policy);
      const ms = performance.now() - t0;
      const rejected = out.startsWith("user rejected");
      const failed = out.startsWith("error:");
      opts?.onToolActivity?.({ name: tc.function.name, ms, ok: !(failed || rejected) });
      // Audit trail: what ran, with what args, under whose decision.
      opts?.onAudit?.({
        tool: tc.function.name,
        args: JSON.stringify(args).slice(0, 1000),
        decision:
          GATED_TOOLS.has(tc.function.name) && opts?.policy?.requestApproval
            ? rejected
              ? "rejected"
              : "approved"
            : "auto",
        ok: !(failed || rejected),
        ms,
        ...(rejected
          ? { note: "rejected by user - not retried without changing the plan" }
          : failed
            ? { note: out.slice(0, 200) }
            : {}),
      });
      // Screenshot vision: pull stashed JPEGs out of the result and attach
      // them to a synthetic user message below, so the model SEES the page.
      for (const m of out.matchAll(/"image":"(img_[a-z0-9]+)"/g)) {
        const b64 = pendingImages.get(m[1]);
        if (b64) {
          roundImages.push(b64);
          pendingImages.delete(m[1]);
        }
      }
      onEvent(`\n[tool ${tc.function.name} · step ${round + 1}/${MAX_ROUNDS}]\n${out.slice(0, 2000)}\n`);
      convo.push({ role: "tool", tool_call_id: tc.id, content: capForConvo(out) });
      if (signal?.aborted) throw abortError();
      if ((seen.get(sig) ?? 0) >= 3) {
        loopNote = `\n[note: stopped after repeating \`${tc.function.name}\` with identical arguments 3× - loop detected]\n`;
        round = MAX_ROUNDS; // break outer loop, go finalize
        break;
      }
    }
    // Runs even on loop-break (break exits only the inner loop): the final
    // summary round sees the screenshots too.
    if (roundImages.length > 0) {
      const imgs = roundImages.slice(-3);
      convo.push({
        role: "user",
        content: `[vision] ${imgs.length} screenshot${imgs.length > 1 ? "s" : ""} captured via browser_screenshot this round - you can SEE the page (layout, styling, errors). Use what you see; describe it when relevant.`,
        images: imgs,
      });
    }
  }
  // Cap reached (or loop): final no-tools rounds so the user gets an answer
  // synthesized from the tool results instead of a dead end. Retried - weak
  // models sometimes answer with more tool_calls or empty content first.
  // Only the tail of the convo is sent: 8 rounds of output drown small models.
  // windowConvo keeps tool request/response pairs intact.
  const tail = windowConvo(convo, 14);
  const counts = [...new Set(usedTools)].map((n) => `${n}×${usedTools.filter((t) => t === n).length}`).join(", ");
  let finErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    // Back off before retries: "Load failed" usually means the server is
    // momentarily down/restarting - instant retries all fail the same way.
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const fin = await backendComplete(
        [
          ...tail,
          {
            role: "user",
            content:
              `${loopNote}Tool budget exhausted. Write your final answer now using only the tool results above. ` +
              `Reply with PLAIN TEXT ONLY - no tool calls, no JSON: what you found/did, and what remains.` +
              (attempt > 0 ? ` This is attempt ${attempt + 1}: your previous reply was not plain text. Text only.` : ""),
          },
        ],
        false,
        (delta) => onEvent(delta),
      );
      reportUsage(fin.usage);
      const ftext = fin.content.trim();
      if (ftext) {
        return ftext;
      }
      finErr = "empty reply";
    } catch (e) {
      if (signal?.aborted) throw abortError();
      finErr = String((e as Error)?.message ?? e);
    }
  }
  return `(tool budget exhausted${finErr ? ` - final summary failed (${finErr})` : ""}; tools used: ${counts || "none"} - see [tool …] results above)`;
}
