// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRoutines } from "./useRoutines";
import type { Routine } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

afterEach(() => {
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup(opts?: { busy?: boolean; saved?: unknown; impl?: (cmd: string, args?: any) => Promise<any> }) {
  setInvokeImpl(
    opts?.impl ??
      (async (cmd: string) => {
        if (cmd === "routines_load") return opts?.saved ?? "";
        if (cmd === "routines_save") return {};
        throw new Error(`unexpected ${cmd}`);
      }),
  );
  const runAgentTurn = vi.fn();
  const hook = renderHook(() =>
    useRoutines({ busy: opts?.busy ?? false, runAgentTurn }),
  );
  return { ...hook, runAgentTurn };
}

describe("useRoutines.loadRoutines", () => {
  it("normalizes, clamps intervals and staggers fresh schedules", async () => {
    const { result } = setup({
      saved: JSON.stringify({
        routines: [
          { id: "r1", name: "triage", prompt: "do triage", everyMs: 60 * 60 * 1000, enabled: true, runCount: 2 },
          { name: "", prompt: "" },
          { name: "no-prompt", prompt: "   " },
        ],
      }),
    });
    const before = Date.now();
    await act(async () => {
      await result.current.loadRoutines();
    });
    expect(result.current.routines).toHaveLength(1);
    const [r] = result.current.routines;
    expect(r.name).toBe("triage");
    expect(r.runCount).toBe(2);
    expect(r.nextRun).toBeGreaterThanOrEqual(before);
    expect(result.current.routinesReady.current).toBe(true);
  });

  it("clamps short intervals to the 15-minute minimum", async () => {
    const { result } = setup({
      saved: JSON.stringify({ routines: [{ id: "r1", name: "fast", prompt: "x", everyMs: 1000 }] }),
    });
    await act(async () => {
      await result.current.loadRoutines();
    });
    expect(result.current.routines[0].everyMs).toBe(15 * 60 * 1000);
  });

  it("starts empty on missing or corrupt data", async () => {
    const empty = setup({ saved: "" });
    await act(async () => {
      await empty.result.current.loadRoutines();
    });
    expect(empty.result.current.routines).toEqual([]);
  });
});

describe("useRoutines.addRoutine", () => {
  it("validates, persists and resets the draft", async () => {
    const saves: any[] = [];
    const { result } = setup({
      impl: async (cmd: string, args?: any) => {
        if (cmd === "routines_load") return "";
        if (cmd === "routines_save") {
          saves.push(JSON.parse(args.content));
          return {};
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await act(async () => {
      await result.current.addRoutine();
    });
    expect(result.current.routines).toHaveLength(0);
    act(() => {
      result.current.setNewRoutine({ name: "  Morning triage  ", prompt: "check inbox", everyMs: 0 });
    });
    await act(async () => {
      await result.current.addRoutine();
    });
    expect(result.current.routines).toHaveLength(1);
    expect(result.current.routines[0]).toMatchObject({ name: "Morning triage", everyMs: 0 });
    expect(result.current.newRoutine).toMatchObject({ name: "", prompt: "" });
    expect(saves[saves.length - 1].routines).toHaveLength(1);
  });
});

describe("useRoutines.runRoutine", () => {
  const routine = (over: Partial<Routine> = {}): Routine => ({
    id: "r1",
    name: "Triage",
    prompt: "check inbox",
    everyMs: 0,
    enabled: true,
    runCount: 0,
    ...over,
  });

  it("runs in this window and fires the agent turn", async () => {
    const { result, runAgentTurn } = setup();
    await act(async () => {
      await result.current.runRoutine(routine());
    });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(runAgentTurn.mock.calls[0][0]).toMatch(/Triage.*check inbox/s);
  });

  it("defers when busy instead of piling up", async () => {
    const { result, runAgentTurn } = setup({ busy: true });
    await act(async () => {
      await result.current.runRoutine(routine());
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
