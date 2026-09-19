import { describe, expect, it } from "vitest";
import { normalizeTrustedPattern, validateTrustedPattern } from "./useTrustedPaths";
import { TOOL_DEFS } from "../lib/providers";
import { undoEntrySize } from "../types";

describe("trusted pattern validation mirrors backend", () => {
  it("accepts relative fragments, normalizes slashes", () => {
    expect(validateTrustedPattern("docs/")).toBeNull();
    expect(validateTrustedPattern("src/generated")).toBeNull();
    expect(normalizeTrustedPattern("docs/")).toBe("docs");
    expect(normalizeTrustedPattern("src/generated/")).toBe("src/generated");
  });

  it("rejects match-all and escapes", () => {
    for (const bad of ["", "/", "///", "..", "../x", "a/../b", "~", "~/x", "."]) {
      expect(validateTrustedPattern(bad), bad).not.toBeNull();
    }
  });
});

describe("agent surface isolation", () => {
  it("exposes no pty_* tools to the model", () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    expect(names).not.toContain("pty_spawn");
    expect(names).not.toContain("pty_write");
    expect(names).not.toContain("pty_resize");
    expect(names).not.toContain("pty_kill");
  });
});

describe("undo size single source of truth", () => {
  it("matches the documented 256KB boundary", () => {
    expect(
      undoEntrySize({ kind: "write", path: "/a", before: "x".repeat(100), after: "y", existedBefore: true }),
    ).toBe(101);
    expect(undoEntrySize({ kind: "rename", oldPath: "/a", newPath: "/b" })).toBe(0);
  });
});
