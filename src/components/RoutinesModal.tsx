import type { Routine } from "../types";
import { ROUTINE_PRESETS } from "../hooks/useRoutines";
import { fmtDur } from "../lib/utils";

export interface NewRoutineDraft {
  name: string;
  prompt: string;
  everyMs: number;
}

export default function RoutinesModal({ routines, newRoutine, setNewRoutine, persistRoutines, addRoutine, runRoutine, onClose }: {
  routines: Routine[];
  newRoutine: NewRoutineDraft;
  setNewRoutine: (v: NewRoutineDraft) => void;
  persistRoutines: (next: Routine[]) => void;
  addRoutine: () => void;
  runRoutine: (r: Routine) => void;
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
          <h3 style={{ margin: 0 }}>Routines - scheduled agent runs</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="muted small">
          Each routine runs in its own lane in the background. Review results via the lane's ● dot.
          Stored per-project in .nexa/routines.json.
        </div>
        {routines.map((r) => (
          <div key={r.id} className="msg">
            <div className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={() => persistRoutines(routines.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))}
                title="Enabled"
              />
              <b>{r.name}</b>
              <span className="muted small">{r.everyMs > 0 ? `every ${fmtDur(r.everyMs)}` : "manual"}</span>
              <span className="muted small">
                {r.lastRun ? `last ${new Date(r.lastRun).toLocaleString()}` : "never run"}
                {r.nextRun && r.everyMs > 0 && r.enabled ? ` · next in ${fmtDur(r.nextRun - Date.now())}` : ""}
              </span>
              <span className="muted small">×{r.runCount}</span>
            </div>
            <pre className="small">{r.prompt.slice(0, 300)}</pre>
            <div className="row" style={{ gap: 6 }}>
              <select
                value={r.everyMs}
                onChange={(e) => {
                  const em = Number(e.target.value);
                  persistRoutines(
                    routines.map((x) =>
                      x.id === r.id
                        ? { ...x, everyMs: em, nextRun: em > 0 ? Date.now() + em : undefined }
                        : x,
                    ),
                  );
                }}
                title="Repeat interval"
              >
                {ROUTINE_PRESETS.map((p) => (
                  <option key={p.label} value={p.ms}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button onClick={() => runRoutine(r)} title="Run now in its lane">
                Run now
              </button>
              <button
                onClick={() => persistRoutines(routines.filter((x) => x.id !== r.id))}
                title="Delete routine (its lane history is kept)"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {routines.length === 0 && <div className="muted">no routines yet - add one below</div>}
        <div className="pane-title">new routine</div>
        <input
          value={newRoutine.name}
          onChange={(e) => setNewRoutine({ ...newRoutine, name: e.target.value })}
          placeholder="name - e.g. Morning triage"
          className="grow"
        />
        <textarea
          value={newRoutine.prompt}
          onChange={(e) => setNewRoutine({ ...newRoutine, prompt: e.target.value })}
          placeholder="prompt - what should the agent do each run?"
          className="pad"
          rows={3}
        />
        <div className="row">
          <select
            value={newRoutine.everyMs}
            onChange={(e) => setNewRoutine({ ...newRoutine, everyMs: Number(e.target.value) })}
            title="Repeat interval"
          >
            {ROUTINE_PRESETS.map((p) => (
              <option key={p.label} value={p.ms}>
                {p.label}
              </option>
            ))}
          </select>
          <button onClick={addRoutine} disabled={!newRoutine.name.trim() || !newRoutine.prompt.trim()}>
            Add routine
          </button>
        </div>
      </div>
    </div>
  );
}
