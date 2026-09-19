import { invoke } from "@tauri-apps/api/core";
import { THEMES, asThemeId, type ThemeId } from "../lib/theme";
import { APPROVAL_PROTO } from "../lib/approval";

export default function TopBar({ workspaceLabel, windowLabel, scheduledCount, mcpOn, mcpTools, themeId, onOpenRoutines, onOpenMcp, onThemeChange, onOpenSettings }: {
  workspaceLabel: string;
  windowLabel: string;
  scheduledCount: number;
  mcpOn: boolean;
  mcpTools: number;
  themeId: ThemeId;
  onOpenRoutines: () => void;
  onOpenMcp: () => void;
  onThemeChange: (id: ThemeId) => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="topbar">
      <strong>VTNexa</strong>
      <span className="muted">private agent workspace</span>
      <span
        className="muted small"
        title={`Review-gate protocol v${APPROVAL_PROTO} (native OS dialogs + bound tokens). If agent approvals misbehave, check this matches the latest commit — a stale window serves old gate code.`}
      >
        gate v{APPROVAL_PROTO}
      </span>
      <div className="lanes">
        <span className="muted small" title={`Window: ${windowLabel}`}>
          {workspaceLabel || "(no workspace)"}
          {windowLabel !== "main" ? ` · ${windowLabel}` : ""}
        </span>
        <button
          onClick={() => invoke("create_window").catch(() => {})}
          title="New window - an independent VTNexa instance (Ctrl/Cmd+Shift+N)"
        >
          ⧉ New Window
        </button>
        <button
          onClick={onOpenRoutines}
          title={
            scheduledCount > 0
              ? `${scheduledCount} routine(s) scheduled`
              : "Scheduled routines - named agents on a timer"
          }
        >
          ◷{scheduledCount > 0 ? ` ${scheduledCount}` : ""}
        </button>
        <button
          onClick={onOpenMcp}
          title={
            mcpOn
              ? `MCP on - ${mcpTools} tool(s). Every mcp_* call requires approval`
              : "MCP off - external tools (local stdio) for Commander"
          }
          style={mcpOn ? undefined : { opacity: 0.55 }}
        >
          ⛁{mcpOn && mcpTools > 0 ? ` ${mcpTools}` : ""}
        </button>
        <button
          onClick={onOpenSettings}
          title="Settings (trusted paths, etc)"
        >
          ⚙️
        </button>
        <select
          value={themeId}
          onChange={(e) => onThemeChange(asThemeId(e.target.value))}
          title="Theme / color palette"
        >
          {(Object.keys(THEMES) as ThemeId[]).map((id) => (
            <option key={id} value={id}>
              {THEMES[id].label}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
