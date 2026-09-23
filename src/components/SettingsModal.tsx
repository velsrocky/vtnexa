import { useState } from "react";
import { useTrustedPaths } from "../hooks/useTrustedPaths";
import { useUpdater } from "../hooks/useUpdater";
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
  const updater = useUpdater();
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
      <div style={{display:'flex',justifyContent:'space-between',marginTop:16}}>
        <h3>Updates</h3>
      </div>
      <p>
        {updater.status === "idle" && "Check for signed updates from GitHub releases."}
        {updater.status === "checking" && "Checking for updates…"}
        {updater.status === "up-to-date" && "VTNexa is up to date."}
        {updater.status === "available" && `Update available: v${updater.version}.`}
        {updater.status === "downloading" && `Downloading…${updater.progress ?? 0}%`}
        {updater.status === "ready" && "Update installed — restart VTNexa to apply it."}
        {updater.status === "error" && `Update check failed: ${updater.error}`}
        {updater.status === "unavailable" && "Updater unavailable in this build (browser preview)."}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => void updater.checkForUpdates()}>Check for updates</button>
        {updater.status === "available" && (
          <button onClick={() => void updater.downloadAndInstall()}>Download &amp; install</button>
        )}
      </div>
    </div>
  );
}
