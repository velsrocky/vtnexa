// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRoutines } from "./useRoutines";
import { newLane } from "../lib/utils";
import type { Lane, Routine } from "../types";

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

function setup(opts?: {
  lanes?: Lane[];
  busyLanes?: Record<string, boolean>;
  saved?: unknown;
}) {
  setInvokeImpl(async (cmd) => {
    if (cmd === "routines_load") return opts?.saved ?? "";
    if (cmd === "routines_save") return {};
    throw new Error(`unexpected ${cmd}`);
  });
  const addLane = vi.fn((_root: string, _cwd: string, _p: unknown, _o?: unknown) => "new-lane");
  const isolateLane = vi.fn(async (_id: string, _root: string) => {});
  const runAgentTurn = vi.fn();
  const inheritProvider = { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "q", kind: "auto" as const };
  const hook = renderHook(() =>
    useRoutines({
      lanes: opts?.lanes ?? [],
      workspaceRoot: "/w",
      cwd: "/w",
      busyLanes: opts?.busyLanes ?? {},
      runAgentTurn,
      addLane: addLane as any,
      isolateLane,
      inheritProvider,
    }),
  );
  return { ...hook, addLane, isolateLane, runAgentTurn };
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

    setInvokeImpl(async () => {
      throw new Error("io gone");
    });
    const broken = setup({});
    await act(async () => {
      await broken.result.current.loadRoutines();
    });
    expect(broken.result.current.routines).toEqual([]);
  });
});

describe("useRoutines.addRoutine", () => {
  it("validates, persists and resets the draft", async () => {
    const saves: any[] = [];
    setInvokeImpl(async (cmd, args) => {
      if (cmd === "routines_load") return "";
      if (cmd === "routines_save") {
        saves.push(JSON.parse((args as any).content));
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { result } = renderHook(() =>
      useRoutines({
        lanes: [],
        workspaceRoot: "/w",
        cwd: "/w",
        busyLanes: {},
        runAgentTurn: vi.fn(),
        addLane: vi.fn(() => "x"),
        isolateLane: vi.fn(async () => {}),
        inheritProvider: { baseUrl: "b", apiKey: "", model: "m", kind: "auto" },
      }),
    );
    // Empty draft is a no-op.
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

  it("reuses the dedicated lane and fires the agent turn", async () => {
    const lane = newLane("Triage", "/w");
    const { result, runAgentTurn, addLane, isolateLane } = setup({ lanes: [lane] });
    await act(async () => {
      await result.current.runRoutine(routine({ laneId: lane.id }));
    });
    expect(addLane).not.toHaveBeenCalled();
    expect(isolateLane).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(runAgentTurn.mock.calls[0][0]).toBe(lane.id);
    expect(runAgentTurn.mock.calls[0][1]).toMatch(/Triage.*check inbox/s);
  });

  it("creates and isolates a lane lazily on first run", async () => {
    const { result, runAgentTurn, addLane, isolateLane } = setup({ lanes: [] });
    await act(async () => {
      await result.current.runRoutine(routine());
    });
    expect(addLane).toHaveBeenCalledTimes(1);
    expect(addLane.mock.calls[0][3]).toMatchObject({ name: "Triage", activate: false });
    expect(isolateLane).toHaveBeenCalledWith("new-lane", "/w");
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(runAgentTurn.mock.calls[0][0]).toBe("new-lane");
  });

  it("defers when the lane is busy instead of piling up", async () => {
    const lane = newLane("Triage", "/w");
    const { result, runAgentTurn } = setup({ lanes: [lane], busyLanes: { [lane.id]: true } });
    await act(async () => {
      await result.current.runRoutine(routine({ laneId: lane.id }));
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
