import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { OperationState, ProviderConfig } from "../types";
import type { InitPhase } from "../hooks/useInit";
import OperationStatus from "./OperationStatus";

export default function FirstRunView({
  phase,
  workspaceRoot,
  error,
  details,
  operation,
  provider,
  onOpenFolder,
  onRetry,
  onChangePath,
  onProviderChange,
  onCheckProvider,
}: {
  phase: InitPhase;
  workspaceRoot: string;
  error: string | null;
  details: string | null;
  operation: OperationState;
  provider: ProviderConfig;
  onOpenFolder: () => void | Promise<boolean>;
  onRetry: () => void | Promise<void>;
  onChangePath: (path: string) => void | Promise<boolean>;
  onProviderChange: (patch: Partial<ProviderConfig>) => void;
  onCheckProvider: () => void | Promise<boolean>;
}) {
  const [pathDraft, setPathDraft] = useState(workspaceRoot);
  useEffect(() => setPathDraft(workspaceRoot), [workspaceRoot]);
  const workspacePhase = phase === "initializing" || phase === "workspace-required" || phase === "workspace-error";
  const operationPending = operation.status === "pending";
  const localProvider = /localhost|127\.0\.0\.1|\[::1\]|ollama/i.test(provider.baseUrl);

  if (phase === "ready") {
    return (
      <main className="first-run" data-testid="first-run">
        <section className="first-run-card" aria-labelledby="first-run-title">
          <h1 id="first-run-title">Workspace ready</h1>
          <p role="status">VTNexa is ready in this workspace.</p>
        </section>
      </main>
    );
  }

  function submitPath(event: FormEvent) {
    event.preventDefault();
    void onChangePath(pathDraft);
  }

  return (
    <main className="first-run" data-testid="first-run">
      <section className="first-run-card" aria-labelledby="first-run-title">
        <h1 id="first-run-title">Welcome to VTNexa</h1>
        {workspacePhase ? (
          <>
            <p>Choose the folder Commander should work in. Your files stay on this device and are only accessed through the workspace controls you choose.</p>
            {phase === "initializing" && <p role="status">Opening your workspace…</p>}
            {phase === "workspace-required" && <p role="status">No workspace folder is selected yet.</p>}
            {phase === "workspace-error" && <p className="operation-status error" role="alert">{error ?? "The workspace could not be opened."}</p>}
            <form onSubmit={submitPath}>
              <input
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                placeholder="Folder path, for example C:\\Users\\you\\project"
                aria-label="Workspace folder path"
                data-testid="workspace-path-input"
                disabled={phase === "initializing" || operationPending}
              />
              <button type="submit" data-testid="workspace-path-submit" disabled={phase === "initializing" || operationPending || !pathDraft.trim()}>
                Use Folder
              </button>
            </form>
            <div className="row">
              <button type="button" className="primary-action" onClick={() => void onOpenFolder()} disabled={phase === "initializing" || operationPending}>
                Open Folder
              </button>
              {(phase === "workspace-error" || phase === "initializing") && (
                <button type="button" onClick={() => void onRetry()} disabled={phase === "initializing" || operationPending}>
                  Retry
                </button>
              )}
            </div>
            {details && (
              <details>
                <summary>Show error details</summary>
                <pre>{details}</pre>
              </details>
            )}
          </>
        ) : (
          <>
            <h2>Check your model provider</h2>
            {phase === "provider-checking" && <p role="status">Checking provider settings…</p>}
            {phase === "provider-required" && <p className="operation-status error" role="alert">{error ?? "Provider details are required."}</p>}
            <p>
              {localProvider
                ? "The local provider is configured. VTNexa will let you start it when you send your first request."
                : "Enter the endpoint and model for your OpenAI-compatible, Anthropic, Gemini, or local provider."}
            </p>
            <div className="first-run-provider">
              <label>
                Endpoint
                <input value={provider.baseUrl} onChange={(event) => onProviderChange({ baseUrl: event.target.value })} placeholder="http://localhost:11434/v1" />
              </label>
              <label>
                Model
                <input value={provider.model} onChange={(event) => onProviderChange({ model: event.target.value })} placeholder="qwen2.5-coder:7b" />
              </label>
              <label>
                API key (optional for local providers)
                <input type="password" value={provider.apiKey} onChange={(event) => onProviderChange({ apiKey: event.target.value })} />
              </label>
            </div>
            <button type="button" className="primary-action" onClick={() => void onCheckProvider()} disabled={phase === "provider-checking" || operationPending}>
              {phase === "provider-checking" ? "Checking…" : "Check provider"}
            </button>
          </>
        )}
        {(operation.status !== "error" || (phase !== "workspace-error" && phase !== "provider-required")) && (
          <OperationStatus state={operation} />
        )}
        <p className="trust-note">
          Trust: VTNexa uses the selected folder as its workspace boundary. Review the folder path before continuing; actions outside it stay gated for your approval.
        </p>
      </section>
    </main>
  );
}
