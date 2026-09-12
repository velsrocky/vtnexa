export interface PendingTool {
  tool: string;
  args: Record<string, any>;
  resolve: (ok: boolean) => void;
}

export function shellEscapeWarning(tool: string, args: Record<string, any>): string | null {
  if (tool !== "shell_run") return null;
  const cmd = String((args as any)?.cmd ?? "");
  if (!cmd) return null;
  const pats: [RegExp, string][] = [
    [/(^|[\s;&|])(sudo|doas)\b/, "runs as superuser (sudo/doas)"],
    [/rm\s+-rf\s+(\/|~|\$HOME)/, "recursive delete outside workspace"],
    [/\b(dd|mkfs(\.\w+)?)\b/, "raw disk operation (dd/mkfs)"],
    [/\.ssh\b|\.gnupg\b|\.aws\/credentials\b/, "touches credentials (.ssh/.gnupg/.aws)"],
    [/(^|[\s;&|])cat\s+~?\/(|\.ssh\/)/, "reads files outside workspace"],
    [/\/(etc|root|proc|sys|dev|boot)\//, "touches system path (/etc//root//proc/…)"],
    [/~\//, "uses ~ (home dir, outside workspace)"],
    [/\$HOME\b/, "uses $HOME (outside workspace)"],
    [/curl[^\n]*\|\s*sh|wget[^\n]*\|\s*sh/, "pipes network download into shell"],
    [/^\/|\s\/[a-z]/, "references absolute path (may be outside workspace)"],
  ];
  const hits = pats.filter(([re]) => re.test(cmd)).map(([, msg]) => msg);
  if (!hits.length) return null;
  return `⚠ escapes workspace sandbox: ${hits.join("; ")} — only Approve if you inspected the command.`;
}

export default function ApprovalModal({ queue, onResolve }: {
  queue: PendingTool[];
  onResolve: (ok: boolean) => void;
}) {
  if (!queue.length) return null;
  const head = queue[0];
  const warn = shellEscapeWarning(head.tool, head.args);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--accent)",
          borderRadius: 10,
          padding: 16,
          maxWidth: 560,
          width: "90%",
        }}
      >
        <h3 style={{ margin: "0 0 8px" }}>
          Agent wants approval: {head.tool}{" "}
          {queue.length > 1 && <span className="muted small">· +{queue.length - 1} waiting</span>}
        </h3>
        {warn && (
          <div
            className="small"
            style={{
              background: "var(--deeper)",
              border: "1px solid var(--warn)",
              color: "var(--warn)",
              padding: 8,
              borderRadius: 6,
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            {warn}
          </div>
        )}
        <pre
          style={{
            background: "var(--deeper)",
            padding: 8,
            borderRadius: 6,
            maxHeight: 240,
            overflow: "auto",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {JSON.stringify(head.args, null, 2).slice(0, 4000)}
        </pre>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button onClick={() => onResolve(false)}>Reject</button>
          <button
            style={{ background: "var(--accent)", color: "var(--accent-text)" }}
            onClick={() => onResolve(true)}
          >
            Approve & run
          </button>
        </div>
        <div className="muted small">shell + browser writes never run without this click.</div>
      </div>
    </div>
  );
}
