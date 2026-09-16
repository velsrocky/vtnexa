import type { MutableRefObject } from "react";
import type { SkillInfo, SideTab, Workspace } from "../types";
import type { NexaState } from "../hooks/useNexa";
import { useInputHistory } from "../hooks/useInputHistory";

export default function ChatPane({ ws, busy, sideTab, setSideTab, width, skills, msgsRef, stickBottom, showJump, setShowJump, scrollMsgsToBottom, input, setInput, sendChat, stopTurn, planMode, onTogglePlan, showContinue, onContinue, padText, setPadText, planText, setPlanText, memoryText, setMemoryText, nexaState, auditNote, setAuditNote, pendingToolsCount, ratings, onRateMessage }: {
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
  pendingToolsCount?: number;
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
            {ws.messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <b>{m.role}</b>
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
                <pre>{m.content}</pre>
              </div>
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
                title="Stop this turn: aborts the request and releases waiting approvals (applied side effects are not undone)"
              >
                ■ Stop
              </button>
            )}
            {busy && (
              <span
                className="agent-status"
                title={
                  (pendingToolsCount ?? 0) > 0
                    ? "Waiting for approval"
                    : "Agent is thinking..."
                }
              >
                <span className="spinner" />
                {(pendingToolsCount ?? 0) > 0 ? "approval" : "thinking"}
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
