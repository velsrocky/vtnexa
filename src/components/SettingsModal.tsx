import { useState } from "react";
import { normalizeTrustedPattern, useTrustedPaths } from "../hooks/useTrustedPaths";
import { useUpdater } from "../hooks/useUpdater";
import { invoke } from "@tauri-apps/api/core";
import AccessibleDialog from "./AccessibleDialog";

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
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const updaterPending = updater.status === "checking" || updater.status === "downloading";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!pattern.trim() || pending) return;
    const validationError = addPath(pattern, reason);
    if (validationError) {
      setError(validationError);
      setStatus(null);
      return;
    }
    const normalized = normalizeTrustedPattern(pattern);
    const alreadyPresent = paths.some((item) => item.pattern.toLowerCase() === normalized.toLowerCase());
    const next = alreadyPresent
      ? paths
      : paths.concat({ pattern: normalized, reason: reason.slice(0, 256) });
    setError(null);
    setStatus(null);
    setPending(true);
    try {
      await invoke("update_trusted_paths", { newPaths: next });
      setStatus("Trusted path saved.");
      setPattern("");
      setReason("");
    } catch (caught) {
      if (!alreadyPresent) removePath(paths.length);
      setError(`Trusted path save failed: ${caught}`);
    } finally {
      setPending(false);
    }
  }

  async function handleRemove(index: number) {
    if (pending) return;
    const next = paths.filter((_, itemIndex) => itemIndex !== index);
    setError(null);
    setStatus(null);
    setPending(true);
    try {
      await invoke("update_trusted_paths", { newPaths: next });
      removePath(index);
      setStatus("Trusted path removed.");
    } catch (caught) {
      setError(`Trusted path removal failed: ${caught}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AccessibleDialog
      title="Settings"
      className="settings-modal"
      testId="settings-dialog"
      onClose={onClose}
      pending={pending || updaterPending}
      closeLabel="Close settings"
    >
      <section>
        <h3>Commander autonomy</h3>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={autoApproveWorkspace}
            onChange={(event) => onAutoApproveChange(event.target.checked)}
          />
          <span>
            Auto-approve in-workspace operations (opencode-style).
            {autoApproveWorkspace
              ? " File writes, shell, git and renames inside the workspace run free; only outside access pops a dialog."
              : " Every side effect pops an approval dialog (review-gated)."}
          </span>
        </label>
      </section>
      <section>
        <h3>Trusted Paths</h3>
        <p>Patterns that skip approval dialogs:</p>
        <ul>
          {paths.map((item, index) => (
            <li key={`${item.pattern}-${index}`}>
              <code>{item.pattern}</code> — {item.reason}
              <button type="button" onClick={() => void handleRemove(index)} disabled={pending} aria-label={`Remove ${item.pattern}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="operation-status error" role="alert">{error}</p>}
        {status && <p className="operation-status success" role="status">{status}</p>}
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="e.g. docs/, src/generated/"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            disabled={pending}
            aria-label="Trusted path pattern"
          />
          <input
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={pending}
            aria-label="Trusted path reason"
          />
          <button type="submit" disabled={pending || !pattern.trim()}>
            {pending ? "Saving…" : "Add"}
          </button>
        </form>
      </section>
      <section>
        <h3>Updates</h3>
        <p role="status">
          {updater.status === "idle" && "Check for signed updates from GitHub releases."}
          {updater.status === "checking" && "Checking for updates…"}
          {updater.status === "up-to-date" && "VTNexa is up to date."}
          {updater.status === "available" && `Update available: v${updater.version}.`}
          {updater.status === "downloading" && `Downloading…${updater.progress ?? 0}%`}
          {updater.status === "ready" && "Update installed — restart VTNexa to apply it."}
          {updater.status === "error" && `Update check failed: ${updater.error}`}
          {updater.status === "unavailable" && "Updater unavailable in this build (browser preview)."}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={() => void updater.checkForUpdates()} disabled={updaterPending}>
            Check for updates
          </button>
          {updater.status === "available" && (
            <button type="button" onClick={() => void updater.downloadAndInstall()} disabled={updaterPending}>
              Download &amp; install
            </button>
          )}
        </div>
      </section>
    </AccessibleDialog>
  );
}
