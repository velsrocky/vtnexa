import type { McpServerRow } from "../hooks/useMcp";

function fmtExpiry(secs: number): string {
  if (secs < 90) return "expires in <2m";
  const m = Math.round(secs / 60);
  if (m < 90) return `expires in ${m}m`;
  return `expires in ${Math.round(m / 60)}h`;
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
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
      }}
    >
      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--accent)",
          borderRadius: 10,
          padding: 16,
          maxWidth: 640,
          width: "92%",
          maxHeight: "84%",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>MCP - external tools</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="muted small">
          Local-stdio servers from <code>vtnexa.json</code> (global{" "}
          <code>~/.config/vtnexa/vtnexa.json</code> + workspace{" "}
          <code>.vtnexa/vtnexa.json</code>). Every <code>mcp_*</code> call
          requires your approval; failures never break the turn.
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={mcpOn}
            onChange={(e) => setMcpOn(e.target.checked)}
            title="Enable MCP tools for Commander turns"
          />
          <b>{mcpOn ? "MCP on" : "MCP off"}</b>
          <span className="muted small">
            {toolCount} tool{toolCount === 1 ? "" : "s"}
            {errorCount > 0 ? ` · ${errorCount} server${errorCount === 1 ? "" : "s"} failing` : ""}
          </span>
          <button onClick={onRefresh} disabled={loading} title="Reload servers + tools">
            {loading ? "…" : "⟳ Refresh"}
          </button>
        </div>
        {note && <div className="muted small">{note}</div>}
        {!mcpOn && <div className="muted">MCP is off — Commander runs on built-ins only.</div>}
        {mcpOn && servers.length === 0 && !loading && (
          <div className="muted">
            no servers configured — copy <code>.vtnexa/vtnexa.json.example</code> to{" "}
            <code>.vtnexa/vtnexa.json</code> and refresh.
          </div>
        )}
        {mcpOn &&
          servers.map((s) => (
            <div key={s.name} className="msg">
              <div className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => onToggleServer(s.name, e.target.checked)}
                  title={`Enable server ${s.name} (saved to workspace vtnexa.json)`}
                />
                <b>{s.name}</b>
                <span className="muted small">{s.kind}</span>
                <span className="muted small">
                  {s.enabled ? `${s.tools} tool${s.tools === 1 ? "" : "s"}` : "disabled"}
                </span>
                {s.kind === "remote" && s.enabled && (
                  s.auth?.signed_in ? (
                    <>
                      <span className="muted small" title={s.auth.has_refresh ? "Refresh token stored - renews silently" : "No refresh token - you will sign in again on expiry"}>
                        ✓ signed in{s.auth.expires_in != null ? ` · ${fmtExpiry(s.auth.expires_in)}` : ""}
                      </span>
                      <button onClick={() => onSignOut(s.name)} title="Delete stored OAuth tokens from the OS keychain">
                        Sign out
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => onSignIn(s.name)}
                      disabled={signingIn !== null}
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
      </div>
    </div>
  );
}
