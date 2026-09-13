import { describe, expect, it } from "vitest";
import {
  buildSessionFile,
  deriveTitle,
  isValidSessionId,
  newSessionId,
} from "./sessionStore";
import { newWorkspace } from "./utils";

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
