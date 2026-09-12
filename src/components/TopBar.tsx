import { invoke } from "@tauri-apps/api/core";
import { THEMES, asThemeId, type ThemeId } from "../lib/theme";

export default function TopBar({ workspaceLabel, windowLabel, scheduledCount, themeId, onOpenRoutines, onThemeChange }: {
  workspaceLabel: string;
  windowLabel: string;
  scheduledCount: number;
  themeId: ThemeId;
  onOpenRoutines: () => void;
  onThemeChange: (id: ThemeId) => void;
}) {
  return (
    <header className="topbar">
      <strong>VTNexa</strong>
      <span className="muted">private agent workspace</span>
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
