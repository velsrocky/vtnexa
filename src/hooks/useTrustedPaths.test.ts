// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { normalizeTrustedPattern, useTrustedPaths, validateTrustedPattern } from "./useTrustedPaths";
import { TOOL_DEFS } from "../lib/providers";
import { undoEntrySize } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  localStorage.clear();
});

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

describe("useTrustedPaths hook", () => {
  it("persists to localStorage and restores on remount", () => {
    const a = renderHook(() => useTrustedPaths());
    act(() => a.result.current.addPath("docs", "generated docs"));
    expect(JSON.parse(localStorage.getItem("vtai.trustedPaths") ?? "[]")).toEqual([
      { pattern: "docs", reason: "generated docs" },
    ]);
    const b = renderHook(() => useTrustedPaths());
    expect(b.result.current.paths).toEqual([{ pattern: "docs", reason: "generated docs" }]);
  });

  it("addPath refuses empty, invalid, duplicate-case-insensitive, and >50", () => {
    const { result } = renderHook(() => useTrustedPaths());
    expect(result.current.addPath("   ", "x")).toBe("Pattern is empty");
    expect(result.current.addPath("../etc", "x")).not.toBeNull();
    act(() => result.current.addPath("Docs", "first"));
    expect(result.current.addPath("docs", "again")).toBe("Already trusted");
    expect(result.current.paths).toHaveLength(1);
    // Cap: fill to 50 unique, then reject.
    act(() => {
      const many = Array.from({ length: 49 }, (_, i) => ({ pattern: `p${i}`, reason: "" }));
      localStorage.setItem("vtai.trustedPaths", JSON.stringify(many.concat(result.current.paths)));
    });
    const over = renderHook(() => useTrustedPaths());
    expect(over.result.current.paths).toHaveLength(50);
    expect(over.result.current.addPath("one-more", "")).toBe("Too many entries (50 max)");
  });

  it("trims the reason to 256 chars and removes by index", () => {
    const { result } = renderHook(() => useTrustedPaths());
    act(() => result.current.addPath("a", "z".repeat(300)));
    act(() => result.current.addPath("b", ""));
    expect(result.current.paths[0].reason).toHaveLength(256);
    act(() => result.current.removePath(0));
    expect(result.current.paths).toEqual([{ pattern: "b", reason: "" }]);
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
