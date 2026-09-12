import type { MutableRefObject } from "react";
import type { AuditInput, CenterTab, ChatMsg, ProviderConfig, SkillInfo, Workspace } from "../types";
import { fsRead, skillRead, type NexaKind } from "../lib/tauri";
import { chatWithTools } from "../lib/providers";
import { uid } from "../lib/utils";
import type { PendingTool } from "../components/ApprovalModal";

interface Deps {
  ws: Workspace;
  workspaceRoot: string;
  conventions: string;
  conventionsName: string;
  skills: SkillInfo[];
  provHistLength: number;
  busy: boolean;
  turnAbort: MutableRefObject<AbortController | null>;
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
  // Never throws - errors become a chat message.
  async function runAgentTurn(promptText: string) {
    const target = d.ws;
    if (d.busy) return;
    d.stickBottom.current = true;
    d.setShowJump(false);
    const userMsg: ChatMsg = { id: uid(), role: "user", content: promptText };
    const usedCfg = { ...target.provider };
    d.updateWs((w) => ({ ...w, messages: [...w.messages, userMsg] }));
    d.setBusy(true);
    const ac = new AbortController();
    d.turnAbort.current = ac;
    let acc = "";
    try {
      const history = [...target.messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
      const sys = {
        role: "system",
        content: `You are Commander driving a Linux workspace. workspace=${d.workspaceRoot || target.cwd} cwd=${target.cwd}${target.worktree ? ` (this window is ISOLATED in git worktree ${target.worktree.path}, branch ${target.worktree.branch} - commit freely here; the user merges to main)` : ""}. Tools: fs_list, fs_read, fs_search (grep content), fs_glob (find files by name), fs_create (empty file/dir) - all read-only-ish, auto-approved; use these to understand the codebase before editing. fs_write STAGES to Diff review gate (user must Approve - never writes directly). fs_rename/fs_delete REQUIRE approval (destructive). Git: git_status/git_diff/git_log are read-only auto-approved; git_commit stages ONLY the listed files and REQUIRES approval popup - prefer small commits with clear messages. shell_run, browser_navigate/click/type/back REQUIRE explicit user approval via popup - explain what you want before calling. browser_snapshot/screenshot/scroll are auto-approved. browser_screenshot gives you VISION - you SEE the attached page image, so use it to verify layout, styling, and errors visually. Absolute paths only, MUST stay inside workspace ${d.workspaceRoot}. Sensitive paths (.ssh, browser profile, /etc) are blocked and destructive shell patterns are refused by the backend. Nexa Pad/Plan/Memory are live shared notes at .nexa/pad.md, .nexa/plan.md and .nexa/memory.md - read them with nexa_read, update with nexa_write (direct, visible in sidebar, no approval needed, keep short). Memory is durable cross-session context (decisions, what we agreed); prefer it over Pad for anything that should survive a restart. Browser Use tab runs real Chromium with a persistent profile.${d.conventions ? `\nProject conventions (${d.conventionsName} - follow these):\n${d.conventions}` : ""}${d.skills.length ? `\nProject skills (user may invoke /name, or load full text with skill_read when the task matches):\n${d.skills.map((s) => `- ${s.name}${s.description ? ` - ${s.description}` : ""}`).join("\n")}` : "\nProject skills: none yet (markdown files in .vtnexa/skills/)"}`,
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
          onAudit: (e) => {
            d.logAudit(e);
          },
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
      if (d.turnAbort.current === ac) d.turnAbort.current = null;
    }
  }

  return { expandSkill, runAgentTurn };
}
