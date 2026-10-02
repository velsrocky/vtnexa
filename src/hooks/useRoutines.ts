import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { OperationState, Routine } from "../types";
import { routinesLoad, routinesSave } from "../lib/tauri";
import {
  canonicalWorkspaceKey,
  grantRoutineTrust,
  isRoutineTrusted,
  reconcileRoutineTrust,
  revokeRoutineTrust,
  routineCanAutoRun,
  routineForPersistence,
} from "../lib/routineTrust";
import { uid } from "../lib/utils";

const MIN_EVERY_MS = 15 * 60 * 1000;
export const ROUTINE_PRESETS = [
  { label: "Manual only", ms: 0 },
  { label: "Every 15 min", ms: 15 * 60 * 1000 },
  { label: "Hourly", ms: 60 * 60 * 1000 },
  { label: "Every 3 hours", ms: 3 * 60 * 60 * 1000 },
  { label: "Every 6 hours", ms: 6 * 60 * 60 * 1000 },
  { label: "Every 12 hours", ms: 12 * 60 * 60 * 1000 },
  { label: "Daily", ms: 24 * 60 * 60 * 1000 },
  { label: "Weekly", ms: 7 * 24 * 60 * 60 * 1000 },
];

export function useRoutines(opts: {
  agentActive?: boolean;
  workspaceRoot?: string;
  windowLabel?: string;
  runAgentTurn: (prompt: string, turnOpts?: { plan?: boolean }) => void | Promise<void>;
}) {
  const agentActiveRef = useRef(opts.agentActive ?? false);
  agentActiveRef.current = opts.agentActive ?? false;
  const workspaceRootRef = useRef(canonicalWorkspaceKey(opts.workspaceRoot ?? ""));
  workspaceRootRef.current = canonicalWorkspaceKey(opts.workspaceRoot ?? "");
  const windowLabelRef = useRef(opts.windowLabel ?? "main");
  windowLabelRef.current = opts.windowLabel ?? "main";
  const [routines, setRoutinesState] = useState<Routine[]>([]);
  const routinesRef = useRef<Routine[]>([]);
  const routinesReady = useRef(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [newRoutine, setNewRoutine] = useState({ name: "", prompt: "", everyMs: 60 * 60 * 1000 });
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const operationSequenceRef = useRef(0);

  const setRoutines: Dispatch<SetStateAction<Routine[]>> = (value) => {
    setRoutinesState((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      routinesRef.current = next;
      return next;
    });
  };

  async function persistRoutines(next: Routine[]): Promise<boolean> {
    const previous = routinesRef.current;
    const sequence = ++operationSequenceRef.current;
    const trusted = reconcileRoutineTrust(next, workspaceRootRef.current, windowLabelRef.current);
    const normalized = next.map((routine) => ({
      ...routine,
      trusted: trusted.has(routine.id),
    }));
    setRoutines(normalized);
    setOperation({ status: "pending", message: "Saving routines…" });
    try {
      await routinesSave(
        JSON.stringify({
          version: 1,
          routines: normalized.map(routineForPersistence),
        }),
      );
      if (sequence === operationSequenceRef.current) {
        setOperation({ status: "success", message: "Routines saved." });
      }
      return true;
    } catch (error) {
      const restored = reconcileRoutineTrust(previous, workspaceRootRef.current, windowLabelRef.current);
      setRoutines(previous.map((routine) => ({ ...routine, trusted: restored.has(routine.id) })));
      if (sequence === operationSequenceRef.current) {
        setOperation({ status: "error", message: `Routine save failed: ${error}` });
      }
      return false;
    }
  }

  async function loadRoutines() {
    setOperation({ status: "pending", message: "Loading routines…" });
    try {
      const raw = await routinesLoad();
      if (raw) {
        const data = JSON.parse(raw) as { routines?: unknown };
        if (Array.isArray(data.routines)) {
          const now = Date.now();
          const valid: Routine[] = [];
          const seenIds = new Set<string>();
          for (const value of data.routines as Record<string, unknown>[]) {
            if (
              !value ||
              typeof value.name !== "string" ||
              typeof value.prompt !== "string" ||
              !value.prompt.trim()
            ) {
              continue;
            }
            const id = typeof value.id === "string" ? value.id : uid();
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const everyMs = Number(value.everyMs) || 0;
            valid.push({
              id,
              name: value.name.slice(0, 80),
              prompt: value.prompt.slice(0, 8000),
              everyMs: everyMs <= 0 ? 0 : Math.max(MIN_EVERY_MS, everyMs),
              enabled: value.enabled !== false,
              lastRun: typeof value.lastRun === "number" ? value.lastRun : undefined,
              nextRun: undefined,
              runCount: typeof value.runCount === "number" ? value.runCount : 0,
            });
          }
          const trusted = reconcileRoutineTrust(valid, workspaceRootRef.current, windowLabelRef.current);
          setRoutines(
            valid.map((routine, index) => ({
              ...routine,
              trusted: trusted.has(routine.id),
              nextRun:
                routine.enabled && routine.everyMs > 0 ? now + index * 60_000 : undefined,
            })),
          );
        } else {
          reconcileRoutineTrust([], workspaceRootRef.current, windowLabelRef.current);
          setRoutines([]);
        }
      } else {
        reconcileRoutineTrust([], workspaceRootRef.current, windowLabelRef.current);
        setRoutines([]);
      }
      setOperation({ status: "success", message: "Routines loaded." });
    } catch (error) {
      reconcileRoutineTrust([], workspaceRootRef.current, windowLabelRef.current);
      setRoutines([]);
      setOperation({ status: "error", message: `Routine load failed: ${error}` });
    } finally {
      routinesReady.current = true;
    }
  }

  async function addRoutine() {
    const name = newRoutine.name.trim().slice(0, 80);
    const prompt = newRoutine.prompt.trim().slice(0, 8000);
    if (!name || !prompt) return false;
    const everyMs = newRoutine.everyMs <= 0 ? 0 : Math.max(MIN_EVERY_MS, newRoutine.everyMs);
    const routine: Routine = {
      id: uid(),
      name,
      prompt,
      everyMs,
      enabled: true,
      runCount: 0,
      nextRun: everyMs > 0 ? Date.now() + everyMs : undefined,
      trusted: true,
    };
    grantRoutineTrust(routine, workspaceRootRef.current, windowLabelRef.current);
    const saved = await persistRoutines([...routinesRef.current, routine]);
    if (saved) setNewRoutine({ name: "", prompt: "", everyMs: 60 * 60 * 1000 });
    return saved;
  }

  async function setRoutineEnabled(id: string, enabled: boolean): Promise<boolean> {
    const current = routinesRef.current.find((routine) => routine.id === id);
    if (!current) return false;
    const nextRoutine: Routine = {
      ...current,
      enabled,
      trusted: enabled,
      nextRun: enabled && current.everyMs > 0 ? Date.now() + current.everyMs : undefined,
    };
    if (enabled) {
      grantRoutineTrust(nextRoutine, workspaceRootRef.current, windowLabelRef.current);
    } else {
      revokeRoutineTrust(nextRoutine, workspaceRootRef.current, windowLabelRef.current);
    }
    return persistRoutines(
      routinesRef.current.map((routine) => (routine.id === id ? nextRoutine : routine)),
    );
  }

  async function runRoutine(routine: Routine, runOptions: { automatic?: boolean } = {}) {
    const current = routinesRef.current.find((item) => item.id === routine.id) ?? routine;
    const automatic = runOptions.automatic === true;
    const trusted = isRoutineTrusted(current, workspaceRootRef.current, windowLabelRef.current);
    if (automatic && !routineCanAutoRun(current, trusted, Date.now())) {
      setOperation({
        status: "pending",
        message: `Routine "${current.name}" needs explicit local trust before scheduling.`,
      });
      return false;
    }
    if (!automatic && current.enabled) {
      grantRoutineTrust(current, workspaceRootRef.current, windowLabelRef.current);
    }
    if (agentActiveRef.current) {
      const deferMs = current.everyMs > 0 ? current.everyMs : MIN_EVERY_MS;
      setOperation({ status: "pending", message: "Routine deferred while Commander is working." });
      await persistRoutines(
        routinesRef.current.map((item) =>
          item.id === current.id
            ? {
                ...item,
                trusted: !automatic && item.enabled ? true : item.trusted,
                nextRun: Date.now() + deferMs,
              }
            : item,
        ),
      );
      return false;
    }
    const now = Date.now();
    const next = routinesRef.current.map((item) =>
      item.id === current.id
        ? {
            ...item,
            trusted: !automatic && item.enabled ? true : item.trusted,
            lastRun: now,
            runCount: item.runCount + 1,
            nextRun: item.enabled && item.everyMs > 0 ? now + item.everyMs : undefined,
          }
        : item,
    );
    if (!(await persistRoutines(next))) return false;
    setOperation({ status: "pending", message: `Running routine "${current.name}"…` });
    try {
      await opts.runAgentTurn(
        `🔁 Routine "${current.name}" scheduled run:\n${current.prompt}\n\n[Be concise. Record durable outcomes/decisions in Memory via nexa_write.]`,
        { plan: false },
      );
      setOperation({ status: "success", message: `Routine "${current.name}" finished.` });
      return true;
    } catch (error) {
      setOperation({ status: "error", message: `Routine "${current.name}" failed: ${error}` });
      return false;
    }
  }

  return {
    routines,
    setRoutines,
    persistRoutines,
    loadRoutines,
    addRoutine,
    runRoutine,
    routinesReady,
    setRoutineEnabled,
    showRoutines,
    setShowRoutines,
    newRoutine,
    setNewRoutine,
    operation,
    pending: operation.status === "pending",
  };
}
