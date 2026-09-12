import { useRef, useState } from "react";
import type { Lane, ProviderConfig, Routine } from "../types";
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
  lanes: Lane[];
  workspaceRoot: string;
  cwd: string;
  busyLanes: Record<string, boolean>;
  runAgentTurn: (laneId: string, prompt: string) => void;
  /** Created by useLanes: owns numbering/activation. Isolation follows. */
  addLane: (workspaceRoot: string, cwd: string, provider: ProviderConfig, opts?: { name?: string; activate?: boolean }) => string;
  isolateLane: (id: string, workspaceRoot: string) => Promise<void>;
  inheritProvider: ProviderConfig;
}) {
  const { lanes, workspaceRoot, cwd, busyLanes, runAgentTurn, addLane, isolateLane, inheritProvider } = opts;
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
          for (const r of data.routines as any[]) {
            if (!r || typeof r.name !== "string" || typeof r.prompt !== "string" || !r.prompt.trim()) continue;
            const em = Number(r.everyMs) || 0;
            valid.push({
              id: typeof r.id === "string" ? r.id : uid(),
              name: r.name.slice(0, 80),
              prompt: r.prompt.slice(0, 8000),
              everyMs: em <= 0 ? 0 : Math.max(MIN_EVERY_MS, em),
              enabled: r.enabled !== false,
              laneId: typeof r.laneId === "string" ? r.laneId : undefined,
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

  // Run one routine in its dedicated lane (created lazily, isolated
  // immediately, reused after).
  async function runRoutine(r: Routine) {
    let lid = r.laneId;
    if (!lid || !lanes.some((l) => l.id === lid)) {
      lid = addLane(workspaceRoot, cwd, inheritProvider, {
        name: r.name.slice(0, 40) || "Routine",
        activate: false,
      });
      persistRoutines(routines.map((x) => (x.id === r.id ? { ...x, laneId: lid } : x)));
      await isolateLane(lid, workspaceRoot);
    }
    if (busyLanes[lid]) {
      persistRoutines(routines.map((x) => (x.id === r.id ? { ...x, nextRun: Date.now() + 5 * 60 * 1000 } : x)));
      return;
    }
    const now = Date.now();
    setRoutines((prev) =>
      prev.map((x) =>
        x.id === r.id ? { ...x, lastRun: now, runCount: x.runCount + 1, nextRun: x.everyMs > 0 ? now + x.everyMs : undefined } : x,
      ),
    );
    try {
      await routinesSave(
        JSON.stringify({
          version: 1,
          routines: routines.map((x) =>
            x.id === r.id ? { ...x, lastRun: now, runCount: x.runCount + 1, nextRun: x.everyMs > 0 ? now + x.everyMs : undefined } : x,
          ),
        }),
      );
    } catch {
      /* ignore */
    }
    runAgentTurn(
      lid,
      `🔁 Routine "${r.name}" scheduled run:\n${r.prompt}\n\n[Be concise. Record durable outcomes/decisions in Memory via nexa_write.]`,
    );
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
