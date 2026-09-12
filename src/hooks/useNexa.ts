import { useCallback, useEffect, useRef, useState } from "react";
import { nexaRead, nexaWrite } from "../lib/tauri";

export const PAD_DEFAULT = "# Nexa Pad\nAgents can read/write this.\n";
export const PLAN_DEFAULT = "# Nexa Plan\n1. Agree the work first\n2. Then execute in windows\n";
export const MEMORY_DEFAULT =
  "# Nexa Memory\nDurable project memory: decisions, context, and what we agreed. Survives across sessions.\n";

export type NexaState = "idle" | "loading" | "saving" | "saved" | "error";

// Nexa Pad/Plan/Memory: live files at <workspace>/.nexa/{pad,plan,memory}.md.
// Loaded on workspace set; user edits auto-save (debounced); agent writes
// via nexa_write come back through onNexaWrite and update state directly.
export function useNexa(opts: { workspaceRoot: string }) {
  const [padText, setPadText] = useState(PAD_DEFAULT);
  const [planText, setPlanText] = useState(PLAN_DEFAULT);
  const [memoryText, setMemoryText] = useState(MEMORY_DEFAULT);
  const [nexaState, setNexaState] = useState<NexaState>("idle");
  // Guard the debounced saver until the initial .nexa/ load completes, and
  // remember last-synced contents so agent writes don't trigger rewrite loops.
  const nexaReady = useRef(false);
  const lastSynced = useRef<{ pad: string; plan: string; memory: string }>({ pad: "", plan: "", memory: "" });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNexa = useCallback(async () => {
    setNexaState("loading");
    try {
      const [pad, plan, memory] = await Promise.all([nexaRead("pad"), nexaRead("plan"), nexaRead("memory")]);
      const nextPad = pad || PAD_DEFAULT;
      const nextPlan = plan || PLAN_DEFAULT;
      const nextMemory = memory || MEMORY_DEFAULT;
      setPadText(nextPad);
      setPlanText(nextPlan);
      setMemoryText(nextMemory);
      lastSynced.current = { pad: nextPad, plan: nextPlan, memory: nextMemory };
      setNexaState("saved");
    } catch {
      setNexaState("error");
    } finally {
      nexaReady.current = true;
    }
  }, []);

  useEffect(() => {
    if (!nexaReady.current || !opts.workspaceRoot) return;
    if (
      padText === lastSynced.current.pad &&
      planText === lastSynced.current.plan &&
      memoryText === lastSynced.current.memory
    ) {
      return;
    }
    setNexaState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const jobs: Promise<void>[] = [];
        if (padText !== lastSynced.current.pad) jobs.push(nexaWrite("pad", padText));
        if (planText !== lastSynced.current.plan) jobs.push(nexaWrite("plan", planText));
        if (memoryText !== lastSynced.current.memory) jobs.push(nexaWrite("memory", memoryText));
        await Promise.all(jobs);
        lastSynced.current = { pad: padText, plan: planText, memory: memoryText };
        setNexaState("saved");
      } catch {
        setNexaState("error");
      }
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [padText, planText, memoryText, opts.workspaceRoot]);

  return {
    padText,
    setPadText,
    planText,
    setPlanText,
    memoryText,
    setMemoryText,
    nexaState,
    setNexaState,
    nexaReady,
    lastSynced,
    loadNexa,
  };
}
