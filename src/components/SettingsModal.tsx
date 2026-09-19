import { useState } from "react";
import { useTrustedPaths } from "../hooks/useTrustedPaths";
import { invoke } from "@tauri-apps/api/core";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { paths, addPath, removePath } = useTrustedPaths();
  const [pattern, setPattern] = useState("");
  const [reason, setReason] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pattern) {
      addPath(pattern, reason);
      invoke("update_trusted_paths", {
        newPaths: paths.concat({ pattern, reason }),
      }).catch(console.error);
      setPattern("");
      setReason("");
    }
  }

  return (
    <div className="settings-modal">
      <div style={{display:'flex',justifyContent:'space-between'}}>
        <h3>Trusted Paths</h3>
        <button onClick={onClose}>×</button>
      </div>
      <p>Patterns that skip approval dialogs:</p>
      <ul>
        {paths.map((p, i) => (
          <li key={i}>
            <code>{p.pattern}</code> — {p.reason}
            <button onClick={() => removePath(i)}>×</button>
          </li>
        ))}
      </ul>
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
