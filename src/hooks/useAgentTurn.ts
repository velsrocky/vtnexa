import type { MutableRefObject } from "react";
import type { CenterTab, ChatMsg, Lane, ProviderConfig, SkillInfo } from "../types";
import { fsRead, skillRead, type NexaKind } from "../lib/tauri";
import { chatWithTools } from "../lib/providers";
import { uid } from "../lib/utils";
import type { PendingTool } from "../components/ApprovalModal";

export interface AgentAuditInput {
  tool: string;
  args: string;
  decision: "auto" | "approved" | "rejected";
  ok: boolean;
  ms: number;
  note?: string;
}

interface Deps {
  lanes: Lane[];
  lane: Lane;
  workspaceRoot: string;
  conventions: string;
  conventionsName: string;
  skills: SkillInfo[];
  provHistLength: number;
  busyLanes: Record<string, boolean>;
  activeIdRef: MutableRefObject<string>;
  turnAborts: MutableRefObject<Map<string, AbortController>>;
  streamRafs: MutableRefObject<Map<string, number>>;
  stickBottom: MutableRefObject<boolean>;
  lastSynced: MutableRefObject<{ pad: string; plan: string; memory: string }>;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
  setLaneBusy: (id: string, v: boolean) => void;
  logAudit: (laneId: string, e: AgentAuditInput) => void;
  rememberProvider: (used: ProviderConfig) => void;
  setUnseen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setPendingTools: React.Dispatch<React.SetStateAction<PendingTool[]>>;
  setCenterTab: (t: CenterTab) => void;
  setPadText: (v: string) => void;
  setPlanText: (v: string) => void;
  setMemoryText: (v: string) => void;
  setNexaState: (s: "idle" | "loading" | "saving" | "saved" | "error") => void;
  setShowJump: (v: boolean) => void;
  flushStreamFrame: (laneId: string) => void;
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

  // Core agent turn in any lane (manual chat or scheduled routine). Never
  // throws - errors become a chat message. Background lanes never steal the
  // chat scroll, the Diff tab, or the input.
  async function runAgentTurn(laneId: string, promptText: string) {
    const target = d.lanes.find((l) => l.id === laneId) ?? d.lane;
    if (d.busyLanes[laneId]) return;
    if (laneId === d.activeIdRef.current) {
      d.stickBottom.current = true;
      d.setShowJump(false);
    }
    const userMsg: ChatMsg = { id: uid(), role: "user", content: promptText };
    const usedCfg = { ...target.provider };
    d.updateLane(laneId, (l) => ({ ...l, messages: [...l.messages, userMsg] }));
    d.setLaneBusy(laneId, true);
    const ac = new AbortController();
    d.turnAborts.current.set(laneId, ac);
    let acc = "";
    try {
      const history = [...target.messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
      const sys = {
        role: "system",
        content: `You are Commander driving a Linux workspace. workspace=${d.workspaceRoot || target.cwd} cwd=${target.cwd}${target.worktree ? ` (this lane is ISOLATED in git worktree ${target.worktree.path}, branch ${target.worktree.branch} - commit freely here; the user merges to main)` : ""}. Tools: fs_list, fs_read, fs_search (grep content), fs_glob (find files by name), fs_create (empty file/dir) - all read-only-ish, auto-approved; use these to understand the codebase before editing. fs_write STAGES to Diff review gate (user must Approve - never writes directly). fs_rename/fs_delete REQUIRE approval (destructive). Git: git_status/git_diff/git_log are read-only auto-approved; git_commit stages ONLY the listed files and REQUIRES approval popup - prefer small commits with clear messages. shell_run, browser_navigate/click/type/back REQUIRE explicit user approval via popup - explain what you want before calling. browser_snapshot/screenshot/scroll are auto-approved. browser_screenshot gives you VISION - you SEE the attached page image, so use it to verify layout, styling, and errors visually. Absolute paths only, MUST stay inside workspace ${d.workspaceRoot}. Sensitive paths (.ssh, browser profile, /etc) are blocked. Nexa Pad/Plan/Memory are live shared notes at .nexa/pad.md, .nexa/plan.md and .nexa/memory.md - read them with nexa_read, update with nexa_write (direct, visible in sidebar, no approval needed, keep short). Memory is durable cross-session context (decisions, what we agreed); prefer it over Pad for anything that should survive a restart. Browser Use tab runs real Chromium with a persistent profile.${d.conventions ? `\nProject conventions (${d.conventionsName} - follow these):\n${d.conventions}` : ""}${d.skills.length ? `\nProject skills (user may invoke /name, or load full text with skill_read when the task matches):\n${d.skills.map((s) => `- ${s.name}${s.description ? ` - ${s.description}` : ""}`).join("\n")}` : "\nProject skills: none yet (markdown files in .vtnexa/skills/)"}`,
      };
      const text = await chatWithTools(
        usedCfg,
        [sys, ...history],
        (ev) => {
          acc += ev;
          if (!d.streamRafs.current.has(laneId)) {
            d.streamRafs.current.set(
              laneId,
              requestAnimationFrame(() => {
                d.streamRafs.current.delete(laneId);
                const snapshot = acc;
                d.updateLane(laneId, (l) => {
                  const msgs = [...l.messages];
                  const last = msgs[msgs.length - 1];
                  if (last && last.role === "assistant" && last.id === "stream") {
                    msgs[msgs.length - 1] = { ...last, content: snapshot };
                  } else {
                    msgs.push({ id: "stream", role: "assistant", content: snapshot });
                  }
                  return { ...l, messages: msgs };
                });
              }),
            );
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
              d.updateLane(laneId, (l) => ({ ...l, pendingDiff: { path, content, original } }));
              if (laneId === d.activeIdRef.current) d.setCenterTab("diff");
            },
            requestApproval: (tool, args) =>
              new Promise<boolean>((resolve) => {
                d.setPendingTools((q) => [...q, { laneId, tool, args, resolve }]);
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
            d.updateLane(laneId, (l) => ({
              ...l,
              usage: {
                input: l.usage.input + u.input,
                output: l.usage.output + u.output,
                cost: l.usage.cost + (u.cost ?? 0),
                tools: l.usage.tools,
                toolMs: l.usage.toolMs,
              },
            }));
          },
          onToolActivity: (a) => {
            d.updateLane(laneId, (l) => ({
              ...l,
              usage: { ...l.usage, tools: l.usage.tools + 1, toolMs: l.usage.toolMs + a.ms },
            }));
          },
          onAudit: (e) => {
            d.logAudit(laneId, e);
          },
        },
      );
      d.flushStreamFrame(laneId);
      d.rememberProvider(usedCfg);
      d.updateLane(laneId, (l) => ({
        ...l,
        messages: l.messages.filter((m) => m.id !== "stream").concat([{ id: uid(), role: "assistant", content: text || acc || "(empty)" }]),
      }));
      if (laneId !== d.activeIdRef.current) {
        d.setUnseen((u) => ({ ...u, [laneId]: true }));
      }
    } catch (e) {
      d.flushStreamFrame(laneId);
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
      d.updateLane(laneId, (l) => ({
        ...l,
        messages: l.messages.filter((m) => m.id !== "stream").concat([{ id: uid(), role: "assistant", content: errText }]),
      }));
      if (laneId !== d.activeIdRef.current) {
        d.setUnseen((u) => ({ ...u, [laneId]: true }));
      }
    } finally {
      d.setLaneBusy(laneId, false);
      d.turnAborts.current.delete(laneId);
    }
  }

  return { expandSkill, runAgentTurn };
}
