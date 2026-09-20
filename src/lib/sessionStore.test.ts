// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildSessionFile,
  deriveTitle,
  isValidSessionId,
  newSessionId,
  reviveUndoStack,
  trimUndoStack,
  UNDO_PERSIST_MAX_ENTRIES,
  UNDO_PERSIST_MAX_CHARS,
} from "./sessionStore";
import { newWorkspace } from "./utils";
import type { UndoEntry } from "../types";

const w = (path: string, before: string, after: string): UndoEntry => ({
  kind: "write",
  path,
  before,
  after,
  existedBefore: true,
});

describe("newSessionId / isValidSessionId", () => {
  it("generates filesystem-safe ids", () => {
    const id = newSessionId(1234567890);
    expect(id).toMatch(/^ses_[a-z0-9]+_[a-z0-9]+$/);
    expect(isValidSessionId(id)).toBe(true);
  });

  it("rejects traversal and garbage", () => {
    for (const bad of ["", "../evil", "a/b", "a.json", "a b", ".hidden", "x".repeat(65), null, 42]) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });
});

describe("deriveTitle", () => {
  it("uses the first user message", () => {
    expect(
      deriveTitle([
        { id: "a", role: "assistant", content: "hi" },
        { id: "u", role: "user", content: "  Fix the login bug\nsecond line" },
      ]),
    ).toBe("Fix the login bug");
  });

  it("truncates long prompts and falls back when empty", () => {
    expect(deriveTitle([])).toBe("New session");
    expect(deriveTitle([{ id: "u", role: "user", content: "   " }])).toBe("New session");
    const long = "x".repeat(100);
    expect(deriveTitle([{ id: "u", role: "user", content: long }])).toBe(`${"x".repeat(60)}…`);
  });
});

describe("buildSessionFile", () => {
  it("keeps created, refreshes updated, preserves custom titles", () => {
    const ws = {
      ...newWorkspace("main:ws", "/w"),
      messages: [{ id: "u1", role: "user" as const, content: "hello" }],
    };
    const snap = { id: "main:ws" };
    const f = buildSessionFile("ses_1", ws, snap, { created: 1000, title: "My title" }, 2000);
    expect(f).toMatchObject({ version: 8, id: "ses_1", title: "My title", created: 1000, updated: 2000 });
    // Default titles are re-derived from the conversation.
    const g = buildSessionFile("ses_2", ws, snap, { created: 1000, title: "New session" }, 2000);
    expect(g.title).toBe("hello");
  });
});

describe("trimUndoStack", () => {
  it("keeps the newest entries within the entry cap", () => {
    const stack = Array.from({ length: UNDO_PERSIST_MAX_ENTRIES + 5 }, (_, i) => w(`/f${i}`, "a", "b"));
    const out = trimUndoStack(stack);
    expect(out).toHaveLength(UNDO_PERSIST_MAX_ENTRIES);
    expect(out[0].kind === "write" && out[0].path).toBe(`/f5`);
    const last = out[out.length - 1];
    expect(last.kind === "write" && last.path).toBe(`/f${stack.length - 1}`);
  });

  it("drops the oldest entries first when over the char budget", () => {
    const big = "x".repeat(300_000); // 600K total for the pair — over the 512K budget
    const stack = [w("/old", big, big), w("/new", "tiny", "tiny")];
    const out = trimUndoStack(stack);
    expect(out.map((e) => (e.kind === "write" ? e.path : ""))).toEqual(["/new"]);
  });

  it("keeps a single entry at the char cap and drops anything larger", () => {
    const huge = "y".repeat(UNDO_PERSIST_MAX_CHARS + 1);
    expect(trimUndoStack([w("/huge", huge, "")])).toEqual([]);
    const atCap = "z".repeat(UNDO_PERSIST_MAX_CHARS);
    expect(trimUndoStack([w("/cap", atCap, "")])).toHaveLength(1);
  });
});

describe("reviveUndoStack", () => {
  it("restores well-formed entries and drops malformed junk", () => {
    const ok = [
      { kind: "write", path: "/a", before: "1", after: "2", existedBefore: true },
      { kind: "rename", oldPath: "/b", newPath: "/c" },
      { kind: "delete", path: "/d", content: "gone" },
      { kind: "write", path: 7 },
      { kind: "nope" },
      null,
      "string",
    ];
    const out = reviveUndoStack(ok);
    expect(out).toEqual([
      { kind: "write", path: "/a", before: "1", after: "2", existedBefore: true },
      { kind: "rename", oldPath: "/b", newPath: "/c" },
      { kind: "delete", path: "/d", content: "gone" },
    ]);
  });

  it("returns an empty stack for non-arrays", () => {
    expect(reviveUndoStack(undefined)).toEqual([]);
    expect(reviveUndoStack({})).toEqual([]);
    expect(reviveUndoStack("x")).toEqual([]);
  });
});
