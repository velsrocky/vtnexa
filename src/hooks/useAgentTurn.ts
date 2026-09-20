import { useRef } from "react";
import type { MutableRefObject } from "react";
import type { AuditInput, CenterTab, ChatMsg, ProviderConfig, SkillInfo, UndoEntry, Workspace } from "../types";
import { fsRead, skillRead, type NexaKind } from "../lib/tauri";
import { actionFor, approvalIssue, detailFor } from "../lib/approval";
import { chatWithTools, asksAuthQuestion, extractExplicitPaths, skillConfinement, type ToolDef } from "../lib/providers";
import { isMcpEnabled, mcpListTools, setMcpToolCache, toMcpToolDefs } from "../lib/mcp";
import { recordTurnRepairs, resolvePromptTier } from "../lib/modelBands";
import { uid } from "../lib/utils";
import type { ToolEvent } from "../types";

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
  setCenterTab: (t: CenterTab) => void;
  setPadText: (v: string) => void;
  setPlanText: (v: string) => void;
  setMemoryText: (v: string) => void;
  setNexaState: (s: "idle" | "loading" | "saving" | "saved" | "error") => void;
  setShowJump: (v: boolean) => void;
  flushStreamFrame: () => void;
  /** UI toggle state (manual chat default). Routines always force Build. */
  planMode?: boolean;
  /** Opencode-style auto-approval: in-workspace ops skip the dialog. */
  autoApproveWorkspace?: boolean;
  /** Reversible agent file op applied this turn (rename/delete capture). */
  pushUndo?: (e: UndoEntry) => void;
}

export function useAgentTurn(d: Deps) {
  // Cross-turn stall: consecutive turns that ended asking for direction with
  // zero tools run. Per window, transient (resets on reload) - the visible
  // chat already carries the evidence; this just counts it.
  const stallRef = useRef({ questionTurns: 0 });

  async function expandSkill(text: string): Promise<string> {
    const m = text.match(/^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/);
    if (m) {
      const found = d.skills.find((s) => s.name === m[1]);
      if (!found) return text;
      try {
        const body = await skillRead(found.name);
        return buildSkillPrompt(found.name, body, m[2].trim());
      } catch {
        return text;
      }
    }
    // Bare-name invocation ("rate the app", "explain auth"): only for
    // READ-ONLY skills, only when the skill exists, only as the first word.
    // Anything that mutates (fix, commit, test, docs, ...) still needs the
    // slash — "commit this" must never auto-fire.
    const bare = text.match(/^([A-Za-z0-9_-]+)\b\s*([\s\S]*)$/);
    if (bare && BARE_SKILLS.has(bare[1]) && d.skills.some((s) => s.name === bare[1])) {
      try {
        const body = await skillRead(bare[1]);
        return buildSkillPrompt(bare[1], body, bare[2].trim());
      } catch {
        return text;
      }
    }
    return text;
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
    // Skill confinement: a read-only skill (e.g. /rate) narrows this turn's
    // tool surface to exactly its prescribed tools. runTool refuses the rest
    // fail-closed BEFORE any approval dialog can appear.
    const confinement = skillConfinement(promptText);
    const usedCfg = { ...target.provider };
    d.updateWs((w) => ({ ...w, messages: [...w.messages, userMsg] }));
    d.setBusy(true);
    const ac = new AbortController();
    d.turnAbort.current = ac;
    d.stopTurnIdRef.current = target.id;
    let acc = "";
    let turnRepairs = 0;
    let toolCallsThisTurn = 0;
    // Set when the last approval was auto-claimed (no dialog); the matching
    // onAudit call tags it "auto". Sequential tool loop: no races.
    let lastAuto = false;
    // Reasoning-model CoT tail (live display only — never part of the final
    // message). Capped, newest kept.
    let thinkingAcc = "";
    // One shared frame publisher: content deltas AND reasoning deltas both
    // need it, otherwise a reasoning phase (which emits reasoning_content but
    // no content) leaves the transcript frozen until the answer starts.
    // Thinking rides in its own field (not concatenated into content) so the
    // UI can render it as a muted block and markdown-parse the answer alone.
    const publishStream = () => {
      if (d.streamRaf.current != null) return;
      d.streamRaf.current = requestAnimationFrame(() => {
        d.streamRaf.current = null;
        d.updateWs((w) => {
          const msgs = [...w.messages];
          const last = msgs[msgs.length - 1];
          const streamMsg: ChatMsg = {
            id: "stream",
            role: "assistant",
            content: acc,
            ...(thinkingAcc ? { thinking: thinkingAcc } : {}),
          };
          if (last && last.role === "assistant" && last.id === "stream") {
            msgs[msgs.length - 1] = streamMsg;
          } else {
            msgs.push(streamMsg);
          }
          return { ...w, messages: msgs };
        });
      });
    };
    // Tool calls this turn, for inline tool cards on the final message.
    const turnTools: ToolEvent[] = [];
    const stalledTurns = stallRef.current.questionTurns;
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
      const explicitPaths = extractExplicitPaths(promptText).slice(0, 5);
      // Opencode-style autonomy: when ON, in-workspace operations skip all
      // approval UI; only outside-workspace access pops the native dialog.
      // Tests omit the flag (undefined) and get the review-gated wording.
      const auto = d.autoApproveWorkspace === true;
      const sys = {
        role: "system",
        content: [
          `You are Commander, the VTNexa workspace agent. If asked who you are or who made you, answer Commander - never adopt another name, never discuss model identity. Driving a Linux workspace.`,
          weak
            ? `Rules for this turn: ONE tool call per reply, sent as a real tool_call - talking about a tool does nothing, to act emit the call. Never narrate calls in prose, never write meta-commentary about the conversation - just answer or call tools. An invoked skill's output format is followed exactly: no extra notes, no renamed sections. Surveying without changing is stalling - after looking with read-only tools, act. Memory/Plan/Pad context is ALREADY pasted above - never call nexa_read unless the user explicitly asks about the notes. A greeting or "what can you do" needs NO tools - answer briefly and oriented (workspace, one line of state, what to work on). A bare "ok / go ahead / continue" means do the last proposed step NOW - don't re-list, don't ask. Write with fs_write directly. First reply: a tool call or the final answer - never a question. After each tool result: one line on what you learned, then the next call. Long commands go to shell_bg + shell_poll, not repeated shell_run calls. Output comes ONLY from a shell_run tool result, never from pasting a command. Grounding: never claim a file exists, is staged, or was saved, and never claim calls or results beyond THIS turn - unsure? Call fs_list/fs_read first. You CAN run shell commands and read files - never claim to be text-only.`
            : `Answer contract: Start acting on your first reply - no intent restatement, no upfront plan, and never open with a question when a tool can make progress. Bare continuations ("ok", "go ahead", "continue", "proceed", "yes", "do it") mean EXECUTE the last proposed next step immediately: never re-survey the workspace, never re-list what this chat already established, never ask what to do - the plan is in the history above, pick it up mid-stride. A plain greeting or smalltalk is the exception: answer briefly and oriented - workspace name, one line of live state from the context above, what to work on - no tools, no tool talk. Reconnaissance is not completion: listing files or reporting what is missing is never the final answer to a work request - after read-only discovery, immediately take the first mutating step. While working, each reply is one line stating what the last tool result showed, then the next tool call. Before the final summary, verify: re-read edited files and run lsp_diagnostics on edited ts/rs/py files. The final reply (task done or truly blocked) is the only long one: files changed, commands run, what remains - at most 5 lines, ending on a statement, never a question. Grounding: never assert a file exists, is staged, was saved, or is (un)available, and never claim tool calls or results beyond THIS turn's history - unsure? Call fs_list/fs_read first. You have shell/file tools: never claim to be text-only, and never present a command as its output - only shell_run results count as output.`,
          `Ambiguity rule (act-first, don't interrogate): reversible work needs no question - act on the obvious interpretation and state your assumption in one line. Investigate with read-only tools first, then ask WITH findings. Questions are for two cases only: destructive/irreversible actions (delete, rename across locations, commit message content) or a genuinely unknowable must-have (which of several same-named targets), at most 2. Authorization lives in the Diff gate and native OS dialogs, never in chat. Never guess paths, filenames, or commit messages.`,
          `Lost context (asked to proceed/continue but this chat is empty)? sessions_list finds the prior thread, session_read loads its messages - re-orient with tools instead of asking the user to re-explain. Never invent prior work.`,
          `Prior turns in THIS chat are evidence: toolchain versions, paths and decisions established earlier (or in Memory below) may be reused directly - do not re-ask the user for them, and do not re-run discovery for them unless a tool result contradicts them. Re-read files before editing; that rule is unchanged. When you verify durable setup facts (toolchain, layout), record them with nexa_write to memory in one line so future turns keep them.`,
          SKILL_SCOPE_NOTE,
          stalledTurns > 0
            ? `Stall warning: the last ${stalledTurns >= 3 ? "3+" : stalledTurns} turn(s) produced questions but zero tool calls. The user has ALREADY authorized this work - approvals happen via a native OS dialog, never in text. This turn, your first reply contains a real tool call or the final answer. No questions.`
            : "",
          `Read-before-edit: always fs_read a file before fs_write/fs_rename on it. Never re-send an identical staged write.`,
          plan
            ? `PLAN MODE (read-only turn): investigate with read-only tools only (fs_list/read/search/glob, skill_read, git_status/diff/log, nexa_read, browser_snapshot/screenshot, lsp_diagnostics, lsp hover/definition/references/symbols). All writes, shell, browser actions, commits and MCP tools are DISABLED and error if called - do not attempt them, do not narrate them. End with a short numbered plan (files to touch, commands to run, risks). Ask the user to switch to Build to execute.`
            : auto
              ? `Tools: fs_list, fs_read, fs_search (grep content), fs_glob (find files by name), fs_create (empty file/dir), lsp_diagnostics (typecheck one file: ts/rs/py), lsp (hover/definition/references/symbols via language servers) - read-only-ish, auto-approved. fs_write writes DIRECTLY (no Diff staging, /undo still covers it). fs_rename/fs_delete run free inside the workspace. Git: git_status/git_diff/git_log are read-only auto-approved; git_commit stages ONLY the listed files, no approval inside the workspace - prefer small commits with clear messages. shell_run/shell_bg/kill inside the workspace run with NO approval; browser_navigate/click/type/back and anything reaching OUTSIDE the workspace REQUIRE approval - a native OS dialog shows the exact command, so don't ask for or announce approval in chat. NEVER use shell for listing, reading, or searching files (fs_list/fs_read/fs_search/fs_glob do that with no popup), and combine dependent shell steps into ONE call with &&. Commands that may exceed ~25s (installs, builds, test suites, servers) go to shell_bg (returns job_id) + shell_poll until done - never re-run a running job, never let shell_run time out twice on the same command. browser_snapshot/screenshot/scroll/shell_poll are auto-approved. browser_screenshot gives you VISION - you SEE the attached page image, so use it to verify layout, styling, and errors visually.`
              : `Tools: fs_list, fs_read, fs_search (grep content), fs_glob (find files by name), fs_create (empty file/dir), lsp_diagnostics (typecheck one file: ts/rs/py), lsp (hover/definition/references/symbols via language servers) - read-only-ish, auto-approved. fs_write STAGES to the Diff review gate (user must Approve - never writes directly). fs_rename/fs_delete REQUIRE approval (destructive). Git: git_status/git_diff/git_log are read-only auto-approved; git_commit stages ONLY the listed files and REQUIRES approval - prefer small commits with clear messages. shell_run, shell_bg/kill, browser_navigate/click/type/back REQUIRE approval - a native OS dialog shows the exact command, so don't ask for or announce approval in chat. Every approval popup costs the user attention: NEVER use shell for listing, reading, or searching files (fs_list/fs_read/fs_search/fs_glob do that with no popup), and combine dependent shell steps into ONE call with && so the user approves once, not five times. Commands that may exceed ~25s (installs, builds, test suites, servers) go to shell_bg (returns job_id) + shell_poll until done - never re-run a running job, never let shell_run time out twice on the same command. browser_snapshot/screenshot/scroll/shell_poll are auto-approved. browser_screenshot gives you VISION - you SEE the attached page image, so use it to verify layout, styling, and errors visually.`,
          `Paths: absolute only, MUST stay inside workspace ${d.workspaceRoot}. Use real tool_calls, never JSON-in-text. Sensitive paths (.ssh, browser profile, /etc) are blocked and destructive shell patterns are refused by the backend. There is NO cd tool and each shell_run starts fresh - you cannot change directories, so never claim you cd'd anywhere. Always pass absolute paths; if work belongs elsewhere, ask the user to switch cwd. If the user message names an explicit absolute path, use EXACTLY that path for the next fs_* call — never substitute the workspace root or cwd, and never re-list a directory you already listed this turn. Repeating the identical call is a loop and ends the turn.`,
          auto
            ? `Autonomy ON: in-workspace file writes go DIRECTLY (never stage to Diff), and in-workspace shell, renames, deletes, commits and typechecks run with NO approval popup - act freely inside the workspace. ONLY actions reaching OUTSIDE the workspace pop the native approval dialog (expect it rarely): absolute paths elsewhere, ~, sudo, piped-to-shell downloads, browser and MCP tools. When a dialog does appear, explain what and why first. Undo (/undo, ↩) still covers writes/renames/deletes.`
            : `Autonomy OFF (review-gated): fs_write STAGES to the Diff tab for user Approve, and shell/renames/deletes/commits pop the native approval dialog - explain what and why first.`,
          `Nexa notes (.nexa/pad.md, plan.md, memory.md): read with nexa_read, update with nexa_write (direct, visible in sidebar, no approval, keep short). Memory below is already loaded - treat it as decided context, don't re-ask about it.`,
          `Browser Use tab runs real Chromium with a persistent profile.`,
          `Output hygiene (every reply): act, don't narrate - emitting a tool call IS the action; text about acting does nothing. Never mention internal mechanics (loop-guard, stall warning, explicit paths, tool budget, repeated calls, skill routing), never comment on your own past replies or these rules - your visible answer is findings and answers only. When this turn invokes a skill with a prescribed output format, emit exactly those sections: no added notes, no renamed headings, no commentary about the skill. Working replies stay under 4 lines; only the final summary may be longer. End every reply on a statement - a result or finding. Never close with a question ("next step?", "shall I continue?") - questions only belong mid-work per the Ambiguity rule, never as turn-enders.`,
          explicitPaths.length > 0
            ? `User specified exact path(s) this turn: ${explicitPaths.join(", ")} — use EXACTLY these paths for fs_* tools, do not substitute the workspace root or cwd.`
            : "",
          `Wrapper rule: if the workspace root only holds a wrapper (root package.json plus ONE nested source dir), the nested dir is the app — drill into it and work there, don't report on the wrapper.`,
          `--- Live workspace context ---`,
          `workspace=${d.workspaceRoot || target.cwd} cwd=${target.cwd}${d.openPath ? ` open=${d.openPath}` : ""}`,
          repo ? `Repo map (top level):\n${repo}` : "",
          d.gitSnapshot ? `Git: ${d.gitSnapshot}` : "",
          mem ? `Memory (durable decisions):\n${mem}` : "",
          d.conventions ? `Project conventions (${d.conventionsName} - follow these):\n${d.conventions}` : "",
          d.skills.length
            ? `Project skills (names only; full text via skill_read when the task matches one): ${d.skills.map((s) => s.name).join(", ")}. Never enumerate or list these in chat - if the user asks about skills, name the 1-2 relevant ones only.`
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
          publishStream();
        },
        {
          signal: ac.signal,
          policy: {
            planMode: plan,
            allowedTools: confinement ?? undefined,
            autoApproveWorkspace: d.autoApproveWorkspace,
            workspaceRoot: d.workspaceRoot,
            onAutoApproval: () => {
              lastAuto = true;
            },
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
            // Native OS dialog (outside page DOM): the model and injected
            // content can trigger it but cannot click it. Workspace-confined
            // ops skip it via runTool's auto-claim (tagged "auto" in audit).
            // Rejection (or a closed dialog) maps to null = turn reports
            // `user rejected …`. Backend failures are NOT silent: they land
            // in the audit trail and shell log so "dialog never appeared" is
            // distinguishable from "user clicked Reject".
            requestApproval: async (tool, args) => {
              try {
                return await approvalIssue(actionFor(tool), detailFor(args));
              } catch (e) {
                const msg = String(e);
                d.logAudit({
                  tool,
                  args: JSON.stringify(args).slice(0, 1000),
                  decision: "rejected",
                  ok: false,
                  ms: 0,
                  note: `approval dialog failed: ${msg.slice(0, 200)}`,
                });
                d.updateWs((w) => ({
                  ...w,
                  shellOut: w.shellOut + `\n⚠ approval dialog failed for ${tool}: ${msg}`,
                }));
                return null;
              }
            },
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
            toolCallsThisTurn++;
            d.updateWs((w) => ({
              ...w,
              usage: { ...w.usage, tools: w.usage.tools + 1, toolMs: w.usage.toolMs + a.ms },
            }));
          },
          onRepair: () => {
            turnRepairs++;
          },
          onAudit: (e) => {
            // Tag auto-claimed approvals honestly: no dialog was shown.
            const entry = lastAuto && e.decision === "approved"
              ? { ...e, decision: "auto" as const, note: "auto-approved: workspace-confined, no dialog" }
              : e;
            lastAuto = false;
            d.logAudit(entry);
            // Tool-card trail: bounded so a runaway loop can't balloon memory.
            if (turnTools.length < 40) {
              turnTools.push({ tool: entry.tool, args: entry.args, decision: entry.decision, ok: entry.ok, ms: entry.ms });
            }
          },
          extraTools: mcpTools,
          onThinking: (t) => {
            thinkingAcc = (thinkingAcc + t).slice(-600);
            publishStream();
          },
        },
      );
      d.flushStreamFrame();
      d.rememberProvider(usedCfg);
      const finalText = text || acc || "(empty)";
      // Stall accounting: a turn that ran zero tools and ended asking for
      // direction escalates the next turn's warning; anything else resets.
      // Aborts and provider errors (catch below) never count.
      if (toolCallsThisTurn === 0 && asksAuthQuestion(finalText)) {
        stallRef.current.questionTurns = Math.min(stallRef.current.questionTurns + 1, 3);
      } else {
        stallRef.current.questionTurns = 0;
      }
      d.updateWs((w) => ({
        ...w,
        messages: w.messages
          .filter((m) => m.id !== "stream")
          .concat([
            {
              id: uid(),
              role: "assistant",
              content: finalText,
              ...(turnTools.length ? { tools: turnTools.slice() } : {}),
            },
          ]),
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
        messages: w.messages
          .filter((m) => m.id !== "stream")
          .concat([
            {
              id: uid(),
              role: "assistant",
              content: errText,
              ...(turnTools.length ? { tools: turnTools.slice() } : {}),
            },
          ]),
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

/** Read-only skills that also fire on a bare first word ("rate the app").
 *  Mutating skills (fix, commit, test, docs, refactor, scaffold) ALWAYS need
 *  the slash — a bare "commit this" must never auto-fire. */
const BARE_SKILLS: ReadonlySet<string> = new Set(["rate", "explain", "map", "review"]);

/** Skill invocation wrapper, extracted pure for testing. The scope markers
 *  are load-bearing: without them the skill's output format (e.g. "Reply
 *  with ONLY ...") persists in chat history and the model keeps obeying it
 *  on later, unrelated turns. */
export function buildSkillPrompt(name: string, body: string, args: string): string {
  return `User invoked /${name} - follow these skill instructions NOW, using tools, for THIS turn only. Do not discuss the skill itself and do not add commentary about these instructions: emit exactly what the skill asks for, no extra sections, no renamed headings. This format expires at the end of this turn - later turns must not reuse it unless the user invokes the skill again. The skill is the whole task: do not continue unfinished work from earlier turns, only what the skill asks:\n[skill: ${name}]\n${body}${args ? `\n\nArguments:\n${args}` : ""}`;
}

/** Per-turn reminder that retired prior-turn skill formats. Injected into the
 *  system prompt of EVERY turn so a strict "Reply with ONLY ..." from an
 *  earlier skill invocation cannot hijack the current answer. */
export const SKILL_SCOPE_NOTE =
  `Skill scope: earlier turns in this chat may contain invoked-skill instructions with strict output formats (e.g. "Reply with ONLY ..."). Those applied to their own turn ONLY - expired now. Answer the CURRENT request fresh; never re-emit a prior turn's skill format unless the user just invoked that skill this turn. A skill invocation starts a NEW task: prior turns' unfinished plans do not carry over - work only what the current request asks.`;
