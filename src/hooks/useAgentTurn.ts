import type { MutableRefObject } from "react";
import type { AuditInput, CenterTab, ChatMsg, ProviderConfig, SkillInfo, UndoEntry, Workspace } from "../types";
import { fsRead, skillRead, type NexaKind } from "../lib/tauri";
import { chatWithTools, type ToolDef } from "../lib/providers";
import { isMcpEnabled, mcpListTools, setMcpToolCache, toMcpToolDefs } from "../lib/mcp";
import { recordTurnRepairs, resolvePromptTier } from "../lib/modelBands";
import { uid } from "../lib/utils";
import type { PendingTool } from "../components/ApprovalModal";

interface Deps {
  ws: Workspace;
  workspaceRoot: string;
  conventions: string;
  conventionsName: string;
  skills: SkillInfo[];
  provHistLength: number;
  /** Durable project memory (auto-injected, truncated) — model no longer has to discover it via tools. */
  memoryText?: string;
  /** Pre-built repo map (top-level entries) so the model starts oriented. */
  repoMap?: string;
  /** One-line git snapshot: branch + changed files. */
  gitSnapshot?: string;
  /** Currently open file in the editor. */
  openPath?: string;
  busy: boolean;
  turnAbort: MutableRefObject<AbortController | null>;
  stopTurnIdRef: MutableRefObject<string>;
  streamRaf: MutableRefObject<number | null>;
  stickBottom: MutableRefObject<boolean>;
  lastSynced: MutableRefObject<{ pad: string; plan: string; memory: string }>;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  setBusy: (v: boolean) => void;
  logAudit: (e: AuditInput) => void;
  rememberProvider: (used: ProviderConfig) => void;
  setPendingTools: React.Dispatch<React.SetStateAction<PendingTool[]>>;
  setCenterTab: (t: CenterTab) => void;
  setPadText: (v: string) => void;
  setPlanText: (v: string) => void;
  setMemoryText: (v: string) => void;
  setNexaState: (s: "idle" | "loading" | "saving" | "saved" | "error") => void;
  setShowJump: (v: boolean) => void;
  flushStreamFrame: () => void;
  /** UI toggle state (manual chat default). Routines always force Build. */
  planMode?: boolean;
  /** Reversible agent file op applied this turn (rename/delete capture). */
  pushUndo?: (e: UndoEntry) => void;
}

export function useAgentTurn(d: Deps) {
  async function expandSkill(text: string): Promise<string> {
    const m = text.match(/^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/);
    if (!m) return text;
    const found = d.skills.find((s) => s.name === m[1]);
    if (!found) return text;
    try {
      const body = await skillRead(found.name);
      const args = m[2].trim();
      return `[skill: ${found.name}]\n${body}${args ? `\n\nArguments:\n${args}` : ""}`;
    } catch {
      return text;
    }
  }

  // Core agent turn for this window (manual chat or scheduled routine).
  // Never throws - errors become a chat message. Plan mode (read-only turn)
  // defaults to the UI toggle; callers pass {plan} to override (routines
  // always run Build).
  async function runAgentTurn(promptText: string, opts?: { plan?: boolean }) {
    const target = d.ws;
    if (d.busy) return;
    const plan = opts?.plan ?? d.planMode ?? false;
    d.stickBottom.current = true;
    d.setShowJump(false);
    const userMsg: ChatMsg = { id: uid(), role: "user", content: promptText };
    const usedCfg = { ...target.provider };
    d.updateWs((w) => ({ ...w, messages: [...w.messages, userMsg] }));
    d.setBusy(true);
    const ac = new AbortController();
    d.turnAbort.current = ac;
    d.stopTurnIdRef.current = target.id;
    let acc = "";
    let turnRepairs = 0;
    try {
      const history = [...target.messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
      // Prompt tier: observed repair behavior overrides the name heuristic
      // in both directions (auto-banding) - no per-model prose anywhere.
      const weak = resolvePromptTier(usedCfg.baseUrl, usedCfg.model) === "weak";
      const mem = (d.memoryText ?? "").trim().slice(0, weak ? 1000 : 2000);
      const repo = (d.repoMap ?? "").split("\n").slice(0, weak ? 20 : 40).join("\n");
      // MCP tools (opt-in, Build turns only): loaded once per turn, capped to
      // protect context. Fail-closed: a broken server never breaks the turn.
      let mcpTools: ToolDef[] = [];
      let mcpNote = "";
      if (!plan && isMcpEnabled()) {
        try {
          const infos = await mcpListTools();
          setMcpToolCache(infos);
          mcpTools = toMcpToolDefs(infos).slice(0, weak ? 10 : 30);
          if (mcpTools.length > 0) {
            mcpNote = `MCP tools (external, REQUIRE approval, prefer built-ins when equivalent):\n${mcpTools.map((t) => `- ${t.function.name} - ${t.function.description.slice(0, 120)}`).join("\n")}`;
          }
        } catch {
          setMcpToolCache([]);
        }
      }
      const sys = {
        role: "system",
        content: [
          `You are Commander driving a Linux workspace.`,
          weak
            ? `Rules for this turn: ONE tool call per reply. Use real tool_calls only - never prose JSON, never "Fs_read /path" narration. NEVER narrate or announce a call in prose ("please approve...", "next action:...") - talking about a tool does nothing; to act, emit the call. NEVER write meta-commentary about the conversation itself ("I learned nothing...", "Please try again") - just answer or call tools. Memory/Plan/Pad context is ALREADY pasted above - never call nexa_read unless the user explicitly asks about the notes. A greeting or "what can you do" needs NO tools - just answer briefly. Call fs_write directly (its review happens in the Diff tab) - never ask the user for permission in text. Grounding: never claim a file exists, is staged, or was saved, and never claim you called tools or saw results that are not in THIS turn - unsure? Call fs_list/fs_read first. You CAN run shell commands via shell_run (user approves via popup) and read files - never claim you are text-only or unable to run commands. Long commands go to shell_bg + shell_poll, not repeated shell_run calls. Never paste a command as its output - output comes ONLY from a shell_run tool result (stdout/stderr/exit code). Keep replies short. After each tool result, say what you learned in one line, then the next single tool call.${plan ? ` PLAN MODE OVERRIDE: this turn is READ-ONLY - use only fs_list/fs_read/fs_search/fs_glob/skill_read/git_status/git_diff/git_log/nexa_read/browser_snapshot/browser_screenshot/lsp_diagnostics/lsp. Do NOT call fs_write, shell_run, or any other tool - they error. End with a short numbered plan.` : ""}`
            : `Answer contract: 1) restate intent in one line, 2) plan (numbered, short), 3) act with tools (emit real calls - never narrate them in prose), 4) verify (re-read edited files; run lsp_diagnostics on edited ts/rs/py files, or lint/tests when relevant), 5) final summary: files changed, commands run, what remains. Grounding: never assert a file exists, is staged, was saved, or is (un)available, and never claim tool calls or results beyond THIS turn's history - unsure? Call fs_list/fs_read first. You have shell/file tools: never claim to be text-only, and never present a command as its output - only shell_run results count as output.`,
          `Ambiguity rule: if the request is ambiguous OR the action is destructive/irreversible, ask 1-2 targeted questions BEFORE acting. Never guess paths, filenames, or commit messages.`,
          `Lost context (asked to proceed/continue but this chat is empty)? sessions_list finds the prior thread, session_read loads its messages - re-orient with tools instead of asking the user to re-explain. Never invent prior work.`,
          `Read-before-edit: always fs_read a file before fs_write/fs_rename on it. Never re-send an identical staged write.`,
          plan
            ? `PLAN MODE (read-only turn): investigate with read-only tools only (fs_list/read/search/glob, skill_read, git_status/diff/log, nexa_read, browser_snapshot/screenshot, lsp_diagnostics, lsp hover/definition/references/symbols). All writes, shell, browser actions, commits and MCP tools are DISABLED and error if called - do not attempt them, do not narrate them. End with a short numbered plan (files to touch, commands to run, risks). Ask the user to switch to Build to execute.`
            :           `Tools: fs_list, fs_read, fs_search (grep content), fs_glob (find files by name), fs_create (empty file/dir), lsp_diagnostics (typecheck one file: ts/rs/py), lsp (hover/definition/references/symbols via language servers) - read-only-ish, auto-approved. fs_write STAGES to the Diff review gate (user must Approve - never writes directly). fs_rename/fs_delete REQUIRE approval (destructive). Git: git_status/git_diff/git_log are read-only auto-approved; git_commit stages ONLY the listed files and REQUIRES approval - prefer small commits with clear messages. shell_run, shell_bg/kill, browser_navigate/click/type/back REQUIRE explicit user approval via popup - explain what you want before calling. Commands that may exceed ~25s (installs, builds, test suites, servers) go to shell_bg (returns job_id) + shell_poll until done - never re-run a running job, never let shell_run time out twice on the same command. browser_snapshot/screenshot/scroll/shell_poll are auto-approved. browser_screenshot gives you VISION - you SEE the attached page image, so use it to verify layout, styling, and errors visually.`,
          `Paths: absolute only, MUST stay inside workspace ${d.workspaceRoot}. Use real tool_calls, never JSON-in-text. Sensitive paths (.ssh, browser profile, /etc) are blocked and destructive shell patterns are refused by the backend. There is NO cd tool and each shell_run starts fresh - you cannot change directories, so never claim you cd'd anywhere. Always pass absolute paths; if work belongs elsewhere, ask the user to switch cwd.`,
          `Nexa notes (.nexa/pad.md, plan.md, memory.md): read with nexa_read, update with nexa_write (direct, visible in sidebar, no approval, keep short). Memory below is already loaded - treat it as decided context, don't re-ask about it.`,
          `Browser Use tab runs real Chromium with a persistent profile.`,
          `--- Live workspace context ---`,
          `workspace=${d.workspaceRoot || target.cwd} cwd=${target.cwd}${d.openPath ? ` open=${d.openPath}` : ""}`,
          repo ? `Repo map (top level):\n${repo}` : "",
          d.gitSnapshot ? `Git: ${d.gitSnapshot}` : "",
          mem ? `Memory (durable decisions):\n${mem}` : "",
          d.conventions ? `Project conventions (${d.conventionsName} - follow these):\n${d.conventions}` : "",
          d.skills.length
            ? `Project skills (user may invoke /name, or load full text with skill_read when the task matches):\n${d.skills.map((s) => `- ${s.name}${s.description ? ` - ${s.description}` : ""}`).join("\n")}`
            : "Project skills: none yet (markdown files in .vtnexa/skills/)",
          mcpNote,
        ]
          .filter((s) => s.length > 0)
          .join("\n"),
      };
      const text = await chatWithTools(
        usedCfg,
        [sys, ...history],
        (ev) => {
          acc += ev;
          if (d.streamRaf.current == null) {
            d.streamRaf.current = requestAnimationFrame(() => {
              d.streamRaf.current = null;
              const snapshot = acc;
              d.updateWs((w) => {
                const msgs = [...w.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === "assistant" && last.id === "stream") {
                  msgs[msgs.length - 1] = { ...last, content: snapshot };
                } else {
                  msgs.push({ id: "stream", role: "assistant", content: snapshot });
                }
                return { ...w, messages: msgs };
              });
            });
          }
        },
        {
          signal: ac.signal,
          policy: {
            planMode: plan,
            onUndoCapture: d.pushUndo,
            onProposeWrite: async (path, content) => {
              let original = "";
              try {
                original = await fsRead(path);
              } catch {
                /* new or unreadable file */
              }
              d.updateWs((w) => ({ ...w, pendingDiff: { path, content, original } }));
              d.setCenterTab("diff");
            },
            requestApproval: (tool, args) =>
              new Promise<boolean>((resolve) => {
                d.setPendingTools((q) => [...q, { tool, args, resolve }]);
              }),
            onNexaWrite: (kind: NexaKind, content: string) => {
              d.lastSynced.current = { ...d.lastSynced.current, [kind]: content };
              if (kind === "pad") d.setPadText(content);
              else if (kind === "plan") d.setPlanText(content);
              else d.setMemoryText(content);
              d.setNexaState("saved");
            },
          },
          onUsage: (u) => {
            d.updateWs((w) => ({
              ...w,
              usage: {
                input: w.usage.input + u.input,
                output: w.usage.output + u.output,
                cost: w.usage.cost + (u.cost ?? 0),
                tools: w.usage.tools,
                toolMs: w.usage.toolMs,
              },
            }));
          },
          onToolActivity: (a) => {
            d.updateWs((w) => ({
              ...w,
              usage: { ...w.usage, tools: w.usage.tools + 1, toolMs: w.usage.toolMs + a.ms },
            }));
          },
          onRepair: () => {
            turnRepairs++;
          },
          onAudit: (e) => {
            d.logAudit(e);
          },
          extraTools: mcpTools,
        },
      );
      d.flushStreamFrame();
      d.rememberProvider(usedCfg);
      d.updateWs((w) => ({
        ...w,
        messages: w.messages.filter((m) => m.id !== "stream").concat([{ id: uid(), role: "assistant", content: text || acc || "(empty)" }]),
      }));
    } catch (e) {
      d.flushStreamFrame();
      const stopped = ac.signal.aborted;
      let errText = stopped ? "⏹ turn stopped by user (side effects already applied are not undone)" : `provider error: ${e}`;
      const msg = String(e);
      if (
        !stopped &&
        d.provHistLength === 0 &&
        /localhost|127\.0\.0\.1/.test(usedCfg.baseUrl) &&
        /network|failed|fetch|refused|Load failed|request failed/i.test(msg)
      ) {
        errText += `\n\n[first run?] Nothing is listening at ${usedCfg.baseUrl}. Start Ollama (\`ollama serve\`) and pull a model (\`ollama pull ${usedCfg.model}\`), or point baseUrl at any OpenAI-compatible endpoint (or pick Anthropic/Gemini above with an API key).`;
      }
      d.updateWs((w) => ({
        ...w,
        messages: w.messages.filter((m) => m.id !== "stream").concat([{ id: uid(), role: "assistant", content: errText }]),
      }));
    } finally {
      d.setBusy(false);
      recordTurnRepairs(usedCfg.baseUrl, usedCfg.model, turnRepairs);
      if (d.turnAbort.current === ac) {
        d.turnAbort.current = null;
        d.stopTurnIdRef.current = "";
      }
    }
  }

  return { expandSkill, runAgentTurn };
}
