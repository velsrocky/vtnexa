import type { MutableRefObject } from "react";
import type { Lane, SideTab } from "../types";
import type { NexaState } from "../hooks/useNexa";

export default function ChatPane({ lane, laneBusy, sideTab, setSideTab, width, msgsRef, stickBottom, showJump, setShowJump, scrollMsgsToBottom, input, setInput, sendChat, stopTurn, padText, setPadText, planText, setPlanText, memoryText, setMemoryText, nexaState, auditNote, setAuditNote }: {
  lane: Lane;
  laneBusy: boolean;
  sideTab: SideTab;
  setSideTab: (t: SideTab) => void;
  width: number;
  msgsRef: MutableRefObject<HTMLDivElement | null>;
  stickBottom: MutableRefObject<boolean>;
  showJump: boolean;
  setShowJump: (v: boolean) => void;
  scrollMsgsToBottom: (smooth?: boolean) => void;
  input: string;
  setInput: (v: string) => void;
  sendChat: () => void;
  stopTurn: (id: string) => void;
  padText: string;
  setPadText: (v: string) => void;
  planText: string;
  setPlanText: (v: string) => void;
  memoryText: string;
  setMemoryText: (v: string) => void;
  nexaState: NexaState;
  auditNote: string;
  setAuditNote: (v: string) => void;
}) {
  const nexaStatus =
    nexaState === "saving" ? "saving…" : nexaState === "saved" ? "✓ saved, agent sees it" : nexaState === "error" ? "⚠ save failed" : "…";
  return (
    <aside className="chat" style={{ width }}>
      <div className="tabs">
        {(["chat", "pad", "plan", "memory", "audit"] as const).map((t) => (
          <button
            key={t}
            className={sideTab === t ? "active" : ""} onClick={() => setSideTab(t)}
            title={t === "audit" ? "Every tool call + your approve/reject decisions, this lane" : undefined}
          >
            {t === "chat"
              ? "Commander"
              : t === "pad"
                ? "Nexa Pad"
                : t === "plan"
                  ? "Nexa Plan"
                  : t === "memory"
                    ? "Memory"
                    : `Audit${lane.audit.length ? ` (${lane.audit.length})` : ""}`}
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
            {lane.messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <b>{m.role}</b>
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
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendChat()} placeholder="Talk. It drives the workspace. /skill for skills." className="grow" />
            <button onClick={sendChat} disabled={laneBusy}>
              Send
            </button>
            {laneBusy && (
              <button
                onClick={() => stopTurn(lane.id)}
                title="Stop this turn: aborts the request and releases waiting approvals (applied side effects are not undone)"
              >
                ■ Stop
              </button>
            )}
          </div>
          <div
            className="muted small"
            title="Cumulative tokens, estimated cost, tool calls and tool time for this lane (persisted in session.json)"
          >
            {lane.usage.input + lane.usage.output > 0 || lane.usage.tools > 0 ? (
              <>
                {(lane.usage.input / 1000).toFixed(1)}k in · {(lane.usage.output / 1000).toFixed(1)}k out
                {lane.usage.cost > 0 ? <> · ~${lane.usage.cost.toFixed(4)}</> : null}
                {lane.usage.tools > 0 ? (
                  <> · {lane.usage.tools} tools ({(lane.usage.toolMs / 1000).toFixed(1)}s)</>
                ) : null}
              </>
            ) : (
              <>no usage yet this lane</>
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
              {lane.audit.length} event{lane.audit.length === 1 ? "" : "s"} · {lane.name} · persisted in session.json
            </span>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(lane.audit, null, 2));
                  setAuditNote(`copied ${lane.audit.length} events`);
                } catch {
                  setAuditNote("copy failed");
                }
                setTimeout(() => setAuditNote(""), 2500);
              }}
              disabled={!lane.audit.length}
              title="Copy this lane's audit trail as JSON"
            >
              Copy JSON
            </button>
          </div>
          {auditNote && <div className="muted small">{auditNote}</div>}
          <div className="msgs">
            {[...lane.audit].reverse().map((e) => (
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
            {lane.audit.length === 0 && <div className="muted">no tool calls yet this lane</div>}
          </div>
        </>
      )}
    </aside>
  );
}
