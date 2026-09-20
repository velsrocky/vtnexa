import { useRef, useState } from "react";
import type { Routine } from "../types";
import { routinesLoad, routinesSave } from "../lib/tauri";
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
  busy: boolean;
  runAgentTurn: (prompt: string, turnOpts?: { plan?: boolean }) => void;
}) {
  const { busy, runAgentTurn } = opts;
  const [routines, setRoutines] = useState<Routine[]>([]);
  const routinesReady = useRef(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [newRoutine, setNewRoutine] = useState({ name: "", prompt: "", everyMs: 60 * 60 * 1000 });

  async function persistRoutines(next: Routine[]) {
    setRoutines(next);
    try {
      await routinesSave(JSON.stringify({ version: 1, routines: next }));
    } catch {
      /* ignore save failures */
    }
  }

  async function loadRoutines() {
    try {
      const raw = await routinesLoad();
      if (raw) {
        const data = JSON.parse(raw) as { routines?: unknown };
        if (Array.isArray(data.routines)) {
          const now = Date.now();
          const valid: Routine[] = [];
          for (const r of data.routines as Record<string, unknown>[]) {
            if (!r || typeof r.name !== "string" || typeof r.prompt !== "string" || !r.prompt.trim()) continue;
            const em = Number(r.everyMs) || 0;
            valid.push({
              id: typeof r.id === "string" ? r.id : uid(),
              name: r.name.slice(0, 80),
              prompt: r.prompt.slice(0, 8000),
              everyMs: em <= 0 ? 0 : Math.max(MIN_EVERY_MS, em),
              enabled: r.enabled !== false,
              lastRun: typeof r.lastRun === "number" ? r.lastRun : undefined,
              nextRun: typeof r.nextRun === "number" ? r.nextRun : undefined,
              runCount: typeof r.runCount === "number" ? r.runCount : 0,
            });
          }
          setRoutines(
            valid.map((r, i) => ({
              ...r,
              nextRun: r.nextRun ?? (r.enabled && r.everyMs > 0 ? now + i * 60_000 : undefined),
            })),
          );
        } else {
          setRoutines([]);
        }
      } else {
        setRoutines([]);
      }
    } catch {
      setRoutines([]);
    } finally {
      routinesReady.current = true;
    }
  }

  async function addRoutine() {
    const name = newRoutine.name.trim().slice(0, 80);
    const prompt = newRoutine.prompt.trim().slice(0, 8000);
    if (!name || !prompt) return;
    const em = newRoutine.everyMs <= 0 ? 0 : Math.max(MIN_EVERY_MS, newRoutine.everyMs);
    const r: Routine = {
      id: uid(),
      name,
      prompt,
      everyMs: em,
      enabled: true,
      runCount: 0,
      nextRun: em > 0 ? Date.now() + em : undefined,
    };
    persistRoutines([...routines, r]);
    setNewRoutine({ name: "", prompt: "", everyMs: 60 * 60 * 1000 });
  }

  // Run a routine in THIS window (it is this window's scheduled job).
  // If a turn is already running, defer instead of piling up.
  async function runRoutine(r: Routine) {
    if (busy) {
      // Defer using the routine's own interval (or minimum) so a busy window
      // doesn't lose the job; it'll retry on the next tick.
      const deferMs = r.everyMs > 0 ? r.everyMs : MIN_EVERY_MS;
      setRoutines((prev) =>
        saveNow(prev.map((x) => (x.id === r.id ? { ...x, nextRun: Date.now() + deferMs } : x))),
      );
      return;
    }
    const now = Date.now();
    setRoutines((prev) =>
      saveNow(
        prev.map((x) =>
          x.id === r.id ? { ...x, lastRun: now, runCount: x.runCount + 1, nextRun: x.everyMs > 0 ? now + x.everyMs : undefined } : x,
        ),
      ),
    );
    runAgentTurn(
      `🔁 Routine "${r.name}" scheduled run:\n${r.prompt}\n\n[Be concise. Record durable outcomes/decisions in Memory via nexa_write.]`,
      // Scheduled jobs always run Build: a read-only routine could never act.
      { plan: false },
    );
  }

  function saveNow(next: Routine[]): Routine[] {
    routinesSave(JSON.stringify({ version: 1, routines: next })).catch(() => {});
    return next;
  }

  return {
    routines,
    setRoutines,
    persistRoutines,
    loadRoutines,
    addRoutine,
    runRoutine,
    routinesReady,
    showRoutines,
    setShowRoutines,
    newRoutine,
    setNewRoutine,
  };
}
