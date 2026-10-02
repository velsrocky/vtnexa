import { beforeEach, describe, expect, it } from "vitest";
import type { Routine } from "../types";
import {
  canonicalWorkspaceKey,
  grantRoutineTrust,
  isRoutineTrusted,
  reconcileRoutineTrust,
  revokeRoutineTrust,
  routineCanAutoRun,
  type TrustStorage,
} from "./routineTrust";

const routine: Routine = {
  id: "routine-1",
  name: "Daily",
  prompt: "check",
  everyMs: 60_000,
  enabled: true,
  runCount: 0,
};

class MemoryStorage implements TrustStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe("routine trust", () => {
  it("canonicalizes workspace scope", () => {
    expect(canonicalWorkspaceKey("C:\\Repo\\")).toBe("c:\\repo");
    expect(canonicalWorkspaceKey("/tmp/repo/")).toBe("/tmp/repo");
  });

  it("requires a matching local record", () => {
    expect(isRoutineTrusted(routine, "/repo", "main", storage)).toBe(false);
    grantRoutineTrust(routine, "/repo", "main", storage);
    expect(isRoutineTrusted(routine, "/repo", "main", storage)).toBe(true);
    expect(isRoutineTrusted({ ...routine, prompt: "changed" }, "/repo", "main", storage)).toBe(false);
    expect(isRoutineTrusted(routine, "/other", "main", storage)).toBe(false);
  });

  it("preserves reload approval and clears it on disable or delete", () => {
    grantRoutineTrust(routine, "/repo", "main", storage);
    expect(reconcileRoutineTrust([routine], "/repo", "main", storage)).toEqual(new Set(["routine-1"]));
    const changed = { ...routine, prompt: "changed" };
    expect(reconcileRoutineTrust([changed], "/repo", "main", storage)).toEqual(new Set());
    grantRoutineTrust(changed, "/repo", "main", storage);
    revokeRoutineTrust(changed, "/repo", "main", storage);
    expect(isRoutineTrusted(changed, "/repo", "main", storage)).toBe(false);
    grantRoutineTrust(changed, "/repo", "main", storage);
    expect(reconcileRoutineTrust([{ ...changed, enabled: false }], "/repo", "main", storage)).toEqual(new Set());
    grantRoutineTrust(changed, "/repo", "main", storage);
    expect(reconcileRoutineTrust([], "/repo", "main", storage)).toEqual(new Set());
  });

  it("only auto-runs trusted enabled schedules", () => {
    expect(routineCanAutoRun({ ...routine, nextRun: 1 }, false, 2)).toBe(false);
    expect(routineCanAutoRun({ ...routine, nextRun: 1 }, true, 2)).toBe(true);
    expect(routineCanAutoRun({ ...routine, enabled: false, nextRun: 1 }, true, 2)).toBe(false);
  });
});
