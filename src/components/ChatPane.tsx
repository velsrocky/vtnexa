import { Fragment, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { SkillInfo, SideTab, ToolEvent, Workspace } from "../types";
import type { NexaState } from "../hooks/useNexa";
import { useInputHistory } from "../hooks/useInputHistory";
import { renderChatMarkdown } from "../lib/chatMarkdown";
import { toolArgsSummary } from "../lib/toolCard";

/** Assistant replies render as sanitized markdown: the finalized message
 *  directly, the in-flight one through StreamingBody (throttled, with an
 *  auto-closed code fence so partial markup never shows raw backticks) plus a
 *  muted reasoning tail. */
/** Compact, expandable trail of the tool calls behind an assistant reply. */
function ToolCards({ tools }: { tools: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const okCount = tools.filter((t) => t.ok).length;
  const approved = tools.filter((t) => t.decision === "approved").length;
  const rejected = tools.filter((t) => t.decision === "rejected").length;
  const totalMs = tools.reduce((s, t) => s + t.ms, 0);
  return (
    <div className="tool-cards">
      <button className="tool-cards-toggle" onClick={() => setOpen(!open)}>
        <span className={`tri ${open ? "open" : ""}`}>▶</span>
        {tools.length} tool call{tools.length === 1 ? "" : "s"}
        {rejected > 0 ? ` · ${rejected} rejected` : ` · ${okCount}/${tools.length} ok`}
        {approved > 0 ? ` · ${approved} approved` : ""}
        {totalMs >= 1000 ? ` · ${(totalMs / 1000).toFixed(1)}s` : ""}
      </button>
      {open && (
        <div className="tool-cards-list">
          {tools.map((t, i) => (
            <div key={i} className="tool-card">
              <span className={`dot ${t.ok ? "ok" : "err"}`} />
              <b>{t.tool}</b>
              <span className="tool-card-args">{toolArgsSummary(t.tool, t.args)}</span>
              {t.decision !== "auto" && <span className={`badge ${t.decision}`}>{t.decision}</span>}
              <span className="tool-card-ms">{t.ms >= 1000 ? `${(t.ms / 1000).toFixed(1)}s` : `${t.ms}ms`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Leading+trailing throttle: at most ~one update per `ms` while text streams
 *  in, plus a guaranteed final flush. Keeps markdown parsing off the rAF path. */
function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const lastAt = useRef(0);
  const timer = useRef<number | null>(null);
  latest.current = value;
  useEffect(() => {
    const flush = () => {
      timer.current = null;
      lastAt.current = Date.now();
      setShown(latest.current);
    };
    const since = Date.now() - lastAt.current;
    if (since >= ms) flush();
    else if (timer.current == null) timer.current = window.setTimeout(flush, ms - since);
    return () => {
      if (timer.current != null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [value, ms]);
  return shown;
}

export function MarkdownBody({ content }: { content: string }) {
  const [html, setHtml] = useState(() => renderChatMarkdown(content));
  useEffect(() => {
    setHtml(renderChatMarkdown(content));
  }, [content]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** In-flight assistant message: muted reasoning tail + markdown answer
 *  (throttled - partial markdown is safe to render, see chatMarkdown.ts). */
export function StreamingBody({ content, thinking }: { content: string; thinking?: string }) {
  const shown = useThrottledValue(content, 120);
  return (
    <>
      {thinking ? (
        <pre className="thinking-tail" title="Live reasoning - display only, never saved">
          {`⏺ thinking\n${thinking}`}
        </pre>
      ) : null}
      <MarkdownBody content={shown} />
    </>
  );
}

export default function ChatPane({ ws, busy, sideTab, setSideTab, width, skills, msgsRef, stickBottom, showJump, setShowJump, scrollMsgsToBottom, input, setInput, sendChat, stopTurn, planMode, onTogglePlan, showContinue, onContinue, padText, setPadText, planText, setPlanText, memoryText, setMemoryText, nexaState, auditNote, setAuditNote, ratings, onRateMessage }: {
  ws: Workspace;
  busy: boolean;
  sideTab: SideTab;
  setSideTab: (t: SideTab) => void;
  width: number;
  skills: SkillInfo[];
  msgsRef: MutableRefObject<HTMLDivElement | null>;
  stickBottom: MutableRefObject<boolean>;
  showJump: boolean;
  setShowJump: (v: boolean) => void;
  scrollMsgsToBottom: (smooth?: boolean) => void;
  input: string;
  setInput: (v: string) => void;
  sendChat: () => void;
  stopTurn: (id: string) => void;
  planMode: boolean;
  onTogglePlan: () => void;
  showContinue: boolean;
  onContinue: () => void;
  padText: string;
  setPadText: (v: string) => void;
  planText: string;
  setPlanText: (v: string) => void;
  memoryText: string;
  setMemoryText: (v: string) => void;
  nexaState: NexaState;
  auditNote: string;
  setAuditNote: (v: string) => void;
  ratings?: Record<string, 1 | -1>;
  onRateMessage?: (messageId: string, rating: 1 | -1) => void;
}) {
  const hist = useInputHistory();
  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      hist.push(input);
      sendChat();
      return;
    }
    // Tab completes /skill names (longest common prefix; spaces on unique).
    if (e.key === "Tab" && input.startsWith("/")) {
      const m = input.match(/^\/([A-Za-z0-9_-]*)$/);
      if (m) {
        const names = skills.map((s) => s.name).filter((n) => n.startsWith(m[1]));
        if (names.length) {
          const common = names.reduce((a, b) => {
            let i = 0;
            while (i < a.length && i < b.length && a[i] === b[i]) i++;
            return a.slice(0, i);
          });
          setInput("/" + common + (names.length === 1 ? " " : ""));
          e.preventDefault();
        }
      }
      return;
    }
    if (hist.applyKey(e, () => input, setInput)) e.preventDefault();
  }
  const nexaStatus =
    nexaState === "saving" ? "saving…" : nexaState === "saved" ? "✓ saved, agent sees it" : nexaState === "error" ? "⚠ save failed" : "…";
  return (
    <aside className="chat" style={{ width }}>
      <div className="tabs">
        {(["chat", "pad", "plan", "memory", "audit"] as const).map((t) => (
          <button
            key={t}
            className={sideTab === t ? "active" : ""} onClick={() => setSideTab(t)}
            title={t === "audit" ? "Every tool call + your approve/reject decisions, this window" : undefined}
          >
            {t === "chat"
              ? "Commander"
              : t === "pad"
                ? "Nexa Pad"
                : t === "plan"
                  ? "Nexa Plan"
                  : t === "memory"
                    ? "Memory"
                    : `Audit${ws.audit.length ? ` (${ws.audit.length})` : ""}`}
          </button>
        ))}
      </div>
      {sideTab === "chat" && (
        <>
          <div
            className="msgs"
            ref={msgsRef}
            onScroll={() => {
              const el = msgsRef.current;
              if (!el) return;
              const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              stickBottom.current = nearBottom;
              setShowJump(!nearBottom);
            }}
          >
            {ws.messages.map((m, i) => (
              <Fragment key={m.id}>
                {m.role === "user" && i > 0 && <div className="turn-sep" aria-hidden="true" />}
                <div className={`msg ${m.role}`}>
                  <div className="msg-head">
                    <b>{m.role === "user" ? "You" : m.role === "assistant" ? "Commander" : "Note"}</b>
                    {m.role === "assistant" && m.id !== "stream" && onRateMessage && (
                      <span className="rate" title="Rate this answer - helps improve Commander">
                        <button
                          className={ratings?.[m.id] === 1 ? "active" : ""}
                          onClick={() => onRateMessage(m.id, 1)}
                          title="Good answer"
                        >
                          👍
                        </button>
                        <button
                          className={ratings?.[m.id] === -1 ? "active" : ""}
                          onClick={() => onRateMessage(m.id, -1)}
                          title="Bad answer"
                        >
                          👎
                        </button>
                      </span>
                    )}
                  </div>
                  {m.role === "assistant" ? (
                    m.id === "stream" ? (
                      <StreamingBody content={m.content} thinking={m.thinking} />
                    ) : (
                      <MarkdownBody content={m.content} />
                    )
                  ) : (
                    <pre>{m.content}</pre>
                  )}
                  {m.role === "assistant" && m.tools && m.tools.length > 0 && (
                    <ToolCards tools={m.tools} />
                  )}
                </div>
              </Fragment>
            ))}
          </div>
          {showJump && (
            <div className="row" style={{ justifyContent: "center", margin: "2px 0" }}>
              <button
                onClick={() => {
                  stickBottom.current = true;
                  setShowJump(false);
                  scrollMsgsToBottom(true);
                }}
              >
                ↓ jump to latest
              </button>
            </div>
          )}
          <div className="row">
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onInputKeyDown} placeholder="Talk. It drives the workspace. /skill for skills, /undo /redo file ops, Tab completes, ↑/↓ history." className="grow" />
            <button
              onClick={onTogglePlan}
              title={planMode ? "Plan mode ON: Commander investigates read-only and ends with a plan (no writes, shell, commits). Click for Build mode." : "Build mode: Commander can act (writes stage to Diff gate, side effects need approval). Click for Plan mode."}
              style={planMode ? { borderColor: "var(--accent)", fontWeight: "bold" } : undefined}
            >
              {planMode ? "◔ Plan" : "◑ Build"}
            </button>
            <button onClick={sendChat} disabled={busy}>
              Send
            </button>
            {showContinue && !busy && (
              <button
                onClick={onContinue}
                title="The last turn ran out of tool budget. Continue it with fresh rounds over the full history (nothing is repeated or lost)."
              >
                ▶ Continue
              </button>
            )}
            {busy && (
              <button
                onClick={() => stopTurn(ws.id)}
                title="Stop this turn: aborts the request (applied side effects are not undone; answer the native approval dialog if one is open)"
              >
                ■ Stop
              </button>
            )}
            {busy && (
              <span className="agent-status" title="Agent is thinking...">
                <span className="spinner" />
                thinking
              </span>
            )}
          </div>
          <div
            className="muted small"
            title="Cumulative tokens, estimated cost, tool calls and tool time for this window (persisted in session.json)"
          >
            {ws.usage.input + ws.usage.output > 0 || ws.usage.tools > 0 ? (
              <>
                {(ws.usage.input / 1000).toFixed(1)}k in · {(ws.usage.output / 1000).toFixed(1)}k out
                {ws.usage.cost > 0 ? <> · ~${ws.usage.cost.toFixed(4)}</> : null}
                {ws.usage.tools > 0 ? (
                  <> · {ws.usage.tools} tools ({(ws.usage.toolMs / 1000).toFixed(1)}s)</>
                ) : null}
              </>
            ) : (
              <>no usage yet</>
            )}
          </div>
        </>
      )}
      {sideTab === "pad" && (
        <>
          <textarea value={padText} onChange={(e) => setPadText(e.target.value)} className="pad" />
          <div className="muted small">.nexa/pad.md · {nexaStatus}</div>
        </>
      )}
      {sideTab === "plan" && (
        <>
          <textarea value={planText} onChange={(e) => setPlanText(e.target.value)} className="pad" />
          <div className="muted small">.nexa/plan.md · {nexaStatus}</div>
        </>
      )}
      {sideTab === "memory" && (
        <>
          <textarea value={memoryText} onChange={(e) => setMemoryText(e.target.value)} className="pad" />
          <div className="muted small">.nexa/memory.md · {nexaStatus}</div>
        </>
      )}
      {sideTab === "audit" && (
        <>
          <div className="row">
            <span className="muted small">
              {ws.audit.length} event{ws.audit.length === 1 ? "" : "s"} · {ws.id} · persisted in session.json
            </span>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(ws.audit, null, 2));
                  setAuditNote(`copied ${ws.audit.length} events`);
                } catch {
                  setAuditNote("copy failed");
                }
                setTimeout(() => setAuditNote(""), 2500);
              }}
              disabled={!ws.audit.length}
              title="Copy this window's audit trail as JSON"
            >
              Copy JSON
            </button>
          </div>
          {auditNote && <div className="muted small">{auditNote}</div>}
          <div className="msgs">
            {[...ws.audit].reverse().map((e) => (
              <div key={e.id} className="msg">
                <div className="row" style={{ gap: 6 }}>
                  <span className="muted small">{new Date(e.ts).toLocaleTimeString()}</span>
                  <b>{e.tool}</b>
                  <span
                    className="small"
                    style={{
                      color:
                        e.decision === "rejected"
                          ? "var(--err)"
                          : e.decision === "approved"
                            ? "var(--ok)"
                            : "var(--muted)",
                    }}
                  >
                    {e.decision}
                  </span>
                  <span className="small" style={{ color: e.ok ? "var(--ok)" : "var(--err)" }}>
                    {e.ok ? "ok" : "fail"}
                  </span>
                  <span className="muted small">{(e.ms / 1000).toFixed(1)}s</span>
                </div>
                <pre>{e.args || "{}"}</pre>
                {e.note && <div className="muted small">{e.note}</div>}
              </div>
            ))}
            {ws.audit.length === 0 && <div className="muted">no tool calls yet</div>}
          </div>
        </>
      )}
    </aside>
  );
}
