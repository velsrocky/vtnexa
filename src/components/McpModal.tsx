import type { McpServerRow } from "../hooks/useMcp";
import AccessibleDialog from "./AccessibleDialog";

function fmtExpiry(secs: number): string {
  if (secs < 90) return "expires in <2m";
  const m = Math.round(secs / 60);
  if (m < 90) return `expires in ${m}m`;
  return `expires in ${Math.round(m / 60)}h`;
}

function serverState(s: McpServerRow): string {
  if (!s.configured_enabled) return s.consent_required ? "disabled · consent required" : "disabled";
  if (s.consent_required) return "consent required";
  if (!s.trusted) return "not trusted";
  return s.enabled ? "enabled" : "not enabled";
}

export default function McpModal({ mcpOn, setMcpOn, servers, toolCount, errorCount, loading, signingIn, note, onToggleServer, onSignIn, onSignOut, onRefresh, onClose }: {
  mcpOn: boolean;
  setMcpOn: (on: boolean) => void;
  servers: McpServerRow[];
  toolCount: number;
  errorCount: number;
  loading: boolean;
  signingIn: string | null;
  note: string;
  onToggleServer: (name: string, on: boolean) => void;
  onSignIn: (name: string) => void;
  onSignOut: (name: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const pending = loading || signingIn !== null;
  return (
    <AccessibleDialog
      title="MCP - external tools"
      onClose={onClose}
      pending={pending}
      closeLabel="Close MCP settings"
    >
      <div className="muted small">
        Configured servers are listed without starting them. Global entries keep their global trust; workspace entries require native trust consent and are bound to the current configuration. Workspace header <code>{`{env:}`}</code> placeholders stay stripped, and local workspace processes receive only explicitly configured environment values.
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={mcpOn}
          onChange={(e) => setMcpOn(e.target.checked)}
          title="Enable MCP tools for Commander turns"
          aria-label="Enable MCP"
        />
        <b>{mcpOn ? "MCP on" : "MCP off"}</b>
        <span className="muted small">
          {toolCount} tool{toolCount === 1 ? "" : "s"}
          {errorCount > 0 ? ` · ${errorCount} server${errorCount === 1 ? "" : "s"} failing` : ""}
        </span>
        <button type="button" onClick={onRefresh} disabled={pending} title="Reload servers and tools">
          {loading ? "…" : "⟳ Refresh"}
        </button>
      </div>
      {note && <div className="muted small" role="status">{note}</div>}
      {!mcpOn && <div className="muted">MCP is off — Commander runs on built-ins only.</div>}
      {mcpOn && servers.length === 0 && !loading && (
        <div className="muted">
          no servers configured — copy <code>.vtnexa/vtnexa.json.example</code> to <code>.vtnexa/vtnexa.json</code> and refresh.
        </div>
      )}
      {mcpOn &&
        servers.map((s) => (
          <div key={s.name} className="msg">
            <div className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={!s.workspace_controlled || pending}
                onChange={(e) => onToggleServer(s.name, e.target.checked)}
                title={s.workspace_controlled ? `Trust and enable server ${s.name}` : "Global-only server; edit the global config to change it"}
                aria-label={`Enable ${s.name}`}
              />
              <b>{s.name}</b>
              <span className="muted small">{s.kind}</span>
              <span className="muted small">configured</span>
              <span className="muted small">{serverState(s)}</span>
              {s.workspace_controlled && !s.trusted && (
                <button type="button" onClick={() => onToggleServer(s.name, true)} disabled={pending}>
                  Trust &amp; enable
                </button>
              )}
              <span className="muted small">
                {s.enabled ? `${s.tools} tool${s.tools === 1 ? "" : "s"}` : "no tools until enabled"}
              </span>
              {s.kind === "remote" && s.enabled && s.trusted && (
                s.auth?.signed_in ? (
                  <>
                    <span className="muted small" title={s.auth.has_refresh ? "Refresh token stored - renews silently" : "No refresh token - you will sign in again on expiry"}>
                      ✓ signed in{s.auth.expires_in != null ? ` · ${fmtExpiry(s.auth.expires_in)}` : ""}
                    </span>
                    <button type="button" onClick={() => onSignOut(s.name)} disabled={pending} title="Delete stored OAuth tokens from the OS keychain">
                      Sign out
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSignIn(s.name)}
                    disabled={pending}
                    title="OAuth sign-in: opens the system browser, tokens go to the OS keychain"
                  >
                    {signingIn === s.name ? "Waiting for browser…" : "Sign in"}
                  </button>
                )
              )}
            </div>
            {s.error && <pre className="small">{s.error.slice(0, 300)}</pre>}
          </div>
        ))}
    </AccessibleDialog>
  );
}
