import type { Lane } from "../types";
import { THEMES, asThemeId, type ThemeId } from "../lib/theme";

export default function TopBar({ lanes, activeLaneId, busyLanes, unseen, scheduledCount, themeId, onSelectLane, onAddLane, onOpenRoutines, onThemeChange, onCloseLane }: {
  lanes: Lane[];
  activeLaneId: string;
  busyLanes: Record<string, boolean>;
  unseen: Record<string, boolean>;
  scheduledCount: number;
  themeId: ThemeId;
  onSelectLane: (id: string) => void;
  onAddLane: () => void;
  onOpenRoutines: () => void;
  onThemeChange: (id: ThemeId) => void;
  onCloseLane: (id: string) => void;
}) {
  return (
    <header className="topbar">
      <strong>VTNexa</strong>
      <span className="muted">private agent workspace</span>
      <div className="lanes">
        {lanes.map((l) => (
          <button
            key={l.id}
            className={l.id === activeLaneId ? "lane active" : "lane"}
            onClick={() => onSelectLane(l.id)}
            title={
              busyLanes[l.id] ? "working in background…" : unseen[l.id] ? "finished - review the result" : l.name
            }
          >
            {busyLanes[l.id] ? "⏳ " : unseen[l.id] ? "● " : ""}
            {l.name}
          </button>
        ))}
        <button onClick={onAddLane}>
          +
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
        <button
          title="Close active lane (kills its PTY)"
          onClick={() => onCloseLane(activeLaneId)}
        >
          ×
        </button>
      </div>
    </header>
  );
}
