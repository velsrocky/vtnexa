import { memo } from "react";
import type { SessionMeta } from "../lib/tauri";
import { useSessionBar } from "../context/AppContext";
import { useConfirm } from "../context/ConfirmContext";
import OperationStatus from "./OperationStatus";

function fmtAge(ts: number): string {
  if (!ts || !isFinite(ts)) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function optionLabel(s: SessionMeta): string {
  const age = fmtAge(s.updated || s.created);
  const count = s.message_count > 0 ? ` · ${s.message_count} msgs` : "";
  const prev = s.preview ? ` — ${s.preview.slice(0, 60)}` : "";
  return `${s.title || "Untitled session"}${age ? ` · ${age}` : ""}${count}${prev}`;
}

// OpenCode-style session picker: always boots fresh; previous sessions in
// this folder are resumed explicitly. Delete removes the current session
// file and starts fresh.
export function SessionBarInner() {
  const {
    sessions,
    currentId,
    currentTitle,
    operation,
    listOperation,
    workspaceOperation,
    agentActive = false,
    conflictReason = "Session actions remain available; active turn output stays with its original session.",
    onNew,
    onResume,
    onDelete,
    onRefresh,
    onRetrySave,
  } = useSessionBar();
  const confirm = useConfirm();
  const others = sessions.filter((s) => s.id !== currentId);
  const pending = operation?.status === "pending";
  const workspacePending = workspaceOperation?.status === "pending";
  const listPending = listOperation?.status === "pending";
  const actionBlocked = pending || workspacePending;
  return (
    <div className="configbar">
      <span className="muted small">session</span>
      <button
        onClick={onNew}
        disabled={actionBlocked}
        title={workspacePending ? "Waiting for the workspace change to finish." : "Start a fresh session (current auto-saves first)"}
      >
        + New
      </button>
      <select
        value={currentId}
        onChange={(e) => {
          if (e.target.value && e.target.value !== currentId) void onResume(e.target.value);
        }}
        disabled={actionBlocked}
        title={workspacePending ? "Waiting for the workspace change to finish." : "Resume a previous session in this folder"}
        className="grow"
        aria-label="Session"
      >
        <option value={currentId}>{currentTitle} (current)</option>
        {others.map((s) => (
          <option key={s.id} value={s.id}>
            {optionLabel(s)}
          </option>
        ))}
      </select>
      <button
        onClick={async () => {
          if (await confirm(`Delete session "${currentTitle}"? This cannot be undone.`)) void onDelete(currentId);
        }}
        disabled={actionBlocked || !currentId}
        title={workspacePending ? "Waiting for the workspace change to finish." : "Delete the current session file and start fresh"}
      >
        Delete
      </button>
      <button onClick={() => void onRefresh()} disabled={listPending} title="Refresh session list">
        ↻
      </button>
      <span className="muted small" title="Sessions stored in <workspace>/.nexa/sessions/">
        {sessions.length} saved
      </span>
      {workspacePending && <span className="muted small" role="status">Waiting for the workspace change to finish.</span>}
      {agentActive && <span className="muted small" role="status">{conflictReason}</span>}
      <OperationStatus state={operation} />
      <OperationStatus state={listOperation} />
      {operation?.status === "error" && onRetrySave && (
        <button onClick={() => void onRetrySave()} title="Retry saving this session">
          Retry save
        </button>
      )}
    </div>
  );
}

const SessionBar = memo(SessionBarInner);
export default SessionBar;
