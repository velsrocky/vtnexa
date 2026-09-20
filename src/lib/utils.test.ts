// @vitest-environment node
import { describe, expect, it } from "vitest";
import { baseName, clampW, didExhaustBudget, dirName, fmtDur, isWithin, newWorkspace, uid } from "./utils";

describe("uid", () => {
  it("returns short unique strings", () => {
    const a = uid();
    const b = uid();
    expect(a).toMatch(/^[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe("fmtDur", () => {
  it("formats minutes, hours, days", () => {
    expect(fmtDur(0)).toBe("0m");
    expect(fmtDur(15 * 60 * 1000)).toBe("15m");
    expect(fmtDur(90 * 60 * 1000)).toBe("1h 30m");
    expect(fmtDur(72 * 60 * 60 * 1000)).toBe("3d 0h");
  });
  it("clamps negatives to zero", () => {
    expect(fmtDur(-5000)).toBe("0m");
  });
});

describe("isWithin", () => {
  it("allows the root itself and children", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b/", "/a/b/c")).toBe(true);
  });
  it("rejects siblings and prefix lookalikes", () => {
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
    expect(isWithin("/a/b", "/a/c")).toBe(false);
    expect(isWithin("/a/b", "/etc/passwd")).toBe(false);
  });
  it("allows everything before init (backend still enforces)", () => {
    expect(isWithin("", "/anything")).toBe(true);
  });
});

describe("baseName / dirName", () => {
  it("splits paths", () => {
    expect(baseName("/a/b/c.txt")).toBe("c.txt");
    expect(dirName("/a/b/c.txt")).toBe("/a/b");
    expect(dirName("c.txt")).toBe("");
  });
});

describe("clampW", () => {
  it("clamps and falls back", () => {
    expect(clampW(100, 160, 480, 240)).toBe(160);
    expect(clampW(300, 160, 480, 240)).toBe(300);
    expect(clampW(999, 160, 480, 240)).toBe(480);
    expect(clampW(NaN, 160, 480, 240)).toBe(240);
    expect(clampW(-5, 160, 480, 240)).toBe(240);
  });
});

describe("newWorkspace", () => {
  it("builds a workspace with zeroed usage and defaults", () => {
    const l = newWorkspace("main:ws", "/w");
    expect(l.id).toBe("main:ws");
    expect(l.cwd).toBe("/w");
    expect(l.messages).toEqual([]);
    expect(l.pendingDiff).toBeNull();
    expect(l.usage).toEqual({ input: 0, output: 0, cost: 0, tools: 0, toolMs: 0 });
    expect(l.id).toBeTruthy();
  });
});

describe("didExhaustBudget", () => {
  const msg = (role: string, content: string, id = "m") => ({ id, role, content }) as any;
  it("fires on the budget-exhausted fallback", () => {
    expect(
      didExhaustBudget([msg("user", "do it"), msg("assistant", "(tool budget exhausted; tools used: fs_list×3 - see results)")]),
    ).toBe(true);
  });
  it("fires on the loop marker even when echoed without the fallback", () => {
    expect(
      didExhaustBudget([msg("user", "do it"), msg("assistant", "stuck in a loop detected pattern, stopping")]),
    ).toBe(true);
  });
  it("stays quiet on normal answers and empty chats", () => {
    expect(didExhaustBudget([])).toBe(false);
    expect(didExhaustBudget([msg("user", "do it"), msg("assistant", "done: created the file")])).toBe(false);
  });
  it("clears once the conversation moves on", () => {
    expect(
      didExhaustBudget([
        msg("user", "do it"),
        msg("assistant", "(tool budget exhausted; tools used: none)"),
        msg("user", "thanks"),
        msg("assistant", "you are welcome"),
        msg("user", "another thing"),
      ]),
    ).toBe(false);
  });
});
