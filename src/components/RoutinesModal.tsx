import type { OperationState, Routine } from "../types";
import { ROUTINE_PRESETS } from "../hooks/useRoutines";
import { fmtDur } from "../lib/utils";
import AccessibleDialog from "./AccessibleDialog";
import OperationStatus from "./OperationStatus";

export interface NewRoutineDraft {
  name: string;
  prompt: string;
  everyMs: number;
}

export default function RoutinesModal({ routines, newRoutine, setNewRoutine, persistRoutines, setRoutineEnabled, addRoutine, runRoutine, onClose, operation }: {
  routines: Routine[];
  newRoutine: NewRoutineDraft;
  setNewRoutine: (v: NewRoutineDraft) => void;
  persistRoutines: (next: Routine[]) => void | Promise<boolean>;
  setRoutineEnabled: (id: string, enabled: boolean) => void | Promise<boolean>;
  addRoutine: () => void | Promise<boolean>;
  runRoutine: (r: Routine) => void | Promise<boolean>;
  onClose: () => void;
  operation?: OperationState;
}) {
  const pending = operation?.status === "pending";
  return (
    <AccessibleDialog
      title="Routines - scheduled agent runs"
      onClose={onClose}
      pending={pending}
      closeLabel="Close routines"
    >
      <div className="muted small">
        Each routine runs a scheduled turn in THIS window. Review results in the chat. Stored per-project in .nexa/routines.json.
      </div>
      <OperationStatus state={operation} />
      {routines.map((routine) => (
        <div key={routine.id} className="msg">
          <div className="row" style={{ gap: 6 }}>
             <input
               type="checkbox"
               checked={routine.enabled && routine.trusted === true}
               disabled={pending}
               onChange={() => void setRoutineEnabled(routine.id, !(routine.enabled && routine.trusted === true))}

              title="Enabled"
              aria-label={`Enable ${routine.name}`}
            />
            <b>{routine.name}</b>
             <span className="muted small">{routine.everyMs > 0 ? `every ${fmtDur(routine.everyMs)}` : "manual"}</span>
             {routine.enabled && !routine.trusted && <span className="muted small">paused · enable to trust</span>}

            <span className="muted small">
              {routine.lastRun ? `last ${new Date(routine.lastRun).toLocaleString()}` : "never run"}
              {routine.nextRun && routine.everyMs > 0 && routine.enabled ? ` · next in ${fmtDur(routine.nextRun - Date.now())}` : ""}
            </span>
            <span className="muted small">×{routine.runCount}</span>
          </div>
          <pre className="small">{routine.prompt.slice(0, 300)}</pre>
          <div className="row" style={{ gap: 6 }}>
            <select
              value={routine.everyMs}
              disabled={pending}
              onChange={(e) => {
                const everyMs = Number(e.target.value);
                void persistRoutines(
                  routines.map((item) =>
                    item.id === routine.id
                      ? { ...item, everyMs, nextRun: everyMs > 0 ? Date.now() + everyMs : undefined }
                      : item,
                  ),
                );
              }}
              title="Repeat interval"
              aria-label={`Repeat interval for ${routine.name}`}
            >
              {ROUTINE_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.ms}>
                  {preset.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void runRoutine(routine)} disabled={pending} title="Run now in this window">
              Run now
            </button>
            <button
              type="button"
              onClick={() => void persistRoutines(routines.filter((item) => item.id !== routine.id))}
              disabled={pending}
              title="Delete routine (chat history is kept)"
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
        disabled={pending}
        aria-label="Routine name"
      />
      <textarea
        value={newRoutine.prompt}
        onChange={(e) => setNewRoutine({ ...newRoutine, prompt: e.target.value })}
        placeholder="prompt - what should the agent do each run?"
        className="pad"
        rows={3}
        disabled={pending}
        aria-label="Routine prompt"
      />
      <div className="row">
        <select
          value={newRoutine.everyMs}
          onChange={(e) => setNewRoutine({ ...newRoutine, everyMs: Number(e.target.value) })}
          title="Repeat interval"
          aria-label="New routine interval"
          disabled={pending}
        >
          {ROUTINE_PRESETS.map((preset) => (
            <option key={preset.label} value={preset.ms}>
              {preset.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void addRoutine()} disabled={pending || !newRoutine.name.trim() || !newRoutine.prompt.trim()}>
          Add routine
        </button>
      </div>
    </AccessibleDialog>
  );
}
