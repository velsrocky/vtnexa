import { useState } from "react";
import { useTrustedPaths } from "../hooks/useTrustedPaths";
import { invoke } from "@tauri-apps/api/core";

export default function SettingsModal({
  onClose,
  autoApproveWorkspace,
  onAutoApproveChange,
}: {
  onClose: () => void;
  autoApproveWorkspace: boolean;
  onAutoApproveChange: (v: boolean) => void;
}) {
  const { paths, addPath, removePath } = useTrustedPaths();
  const [pattern, setPattern] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pattern.trim()) return;
    const err = addPath(pattern, reason);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    // Sync the normalized list (addPath already normalized/deduped).
    const norm = pattern.trim().replace(/\\/g, "/").split("/").map((s) => s.trim()).filter(Boolean).join("/");
    const next = paths.some((p) => p.pattern.toLowerCase() === norm.toLowerCase())
      ? paths
      : paths.concat({ pattern: norm, reason: reason.slice(0, 256) });
    invoke("update_trusted_paths", {
      newPaths: next,
    }).catch((ex) => setError(String(ex)));
    setPattern("");
    setReason("");
  }

  function handleRemove(i: number) {
    const next = paths.filter((_, j) => j !== i);
    removePath(i);
    invoke("update_trusted_paths", { newPaths: next }).catch((ex) => setError(String(ex)));
  }

  return (
    <div className="settings-modal">
      <div style={{display:'flex',justifyContent:'space-between'}}>
        <h3>Commander autonomy</h3>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={autoApproveWorkspace}
          onChange={(e) => onAutoApproveChange(e.target.checked)}
        />
        <span>
          Auto-approve in-workspace operations (opencode-style).
          {autoApproveWorkspace
            ? " File writes, shell, git and renames inside the workspace run free; only outside access pops a dialog."
            : " Every side effect pops an approval dialog (review-gated)."}
        </span>
      </label>
      <div style={{display:'flex',justifyContent:'space-between'}}>
        <h3>Trusted Paths</h3>
        <button onClick={onClose}>×</button>
      </div>
      <p>Patterns that skip approval dialogs:</p>
      <ul>
        {paths.map((p, i) => (
          <li key={i}>
            <code>{p.pattern}</code> — {p.reason}
            <button onClick={() => handleRemove(i)}>×</button>
          </li>
        ))}
      </ul>
      {error && <p style={{ color: "var(--danger, #c00)" }}>{error}</p>}
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="e.g. docs/, src/generated/"
          value={pattern}
          onChange={e => setPattern(e.target.value)}
        />
        <input
          type="text"
          placeholder="Reason (optional)"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
