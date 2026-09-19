import { memo } from "react";
import type { SessionMeta } from "../lib/tauri";
import { useSessionBar } from "../context/AppContext";
import { useConfirm } from "../context/ConfirmContext";

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
    busy,
    onNew,
    onResume,
    onDelete,
    onRefresh,
  } = useSessionBar();
  const confirm = useConfirm();
  const others = sessions.filter((s) => s.id !== currentId);
  return (
    <div className="configbar">
      <span className="muted small">session</span>
      <button onClick={onNew} disabled={busy} title="Start a fresh session (current auto-saves first)">
        + New
      </button>
      <select
        value={currentId}
        onChange={(e) => {
          if (e.target.value && e.target.value !== currentId) void onResume(e.target.value);
        }}
        disabled={busy}
        title="Resume a previous session in this folder"
        className="grow"
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
          if (await confirm(`Delete session "${currentTitle}"? This cannot be undone.`))
            void onDelete(currentId);
        }}
        disabled={busy || !currentId}
        title="Delete the current session file and start fresh"
      >
        Delete
      </button>
      <button onClick={() => void onRefresh()} title="Refresh session list">
        ↻
      </button>
      <span className="muted small" title="Sessions stored in <workspace>/.nexa/sessions/">
        {sessions.length} saved
      </span>
    </div>
  );
}

const SessionBar = memo(SessionBarInner);
export default SessionBar;
