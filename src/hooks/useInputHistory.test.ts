// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useInputHistory } from "./useInputHistory";
import { act, renderHook } from "@testing-library/react";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function harness() {
  const hook = renderHook(() => useInputHistory(3));
  let value = "";
  const get = () => value;
  const set = (v: string) => {
    value = v;
  };
  return { ...hook, get, set, valueOf: () => value };
}

describe("useInputHistory", () => {
  it("pushes trimmed entries, dedupes consecutive, caps size", () => {
    const h = harness();
    act(() => {
      h.result.current.push("ls");
      h.result.current.push("  ls  ");
      h.result.current.push("git status");
      h.result.current.push("");
      h.result.current.push("a");
      h.result.current.push("b");
    });
    // cap 3: ls deduped, empty skipped -> [git status, a, b]
    act(() => {
      h.result.current.applyKey({ key: "ArrowUp" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("b");
    act(() => {
      h.result.current.applyKey({ key: "ArrowUp" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("a");
    act(() => {
      h.result.current.applyKey({ key: "ArrowUp" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("git status");
    act(() => {
      h.result.current.applyKey({ key: "ArrowUp" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("git status"); // clamped at oldest
  });

  it("ArrowUp saves the draft; ArrowDown past newest restores it", () => {
    const h = harness();
    act(() => {
      h.result.current.push("first");
      h.result.current.push("second");
    });
    h.set("half-typed");
    act(() => {
      h.result.current.applyKey({ key: "ArrowUp" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("second");
    act(() => {
      h.result.current.applyKey({ key: "ArrowDown" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("half-typed");
  });

  it("Escape returns to the draft while browsing", () => {
    const h = harness();
    act(() => {
      h.result.current.push("cmd");
    });
    h.set("typing");
    act(() => {
      h.result.current.applyKey({ key: "ArrowUp" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("cmd");
    act(() => {
      h.result.current.applyKey({ key: "Escape" }, h.get, h.set);
    });
    expect(h.valueOf()).toBe("typing");
  });

  it("ignores keys when history is empty or key is unrelated", () => {
    const h = harness();
    expect(h.result.current.applyKey({ key: "ArrowUp" }, h.get, h.set)).toBe(false);
    act(() => {
      h.result.current.push("x");
    });
    expect(h.result.current.applyKey({ key: "a" }, h.get, h.set)).toBe(false);
    expect(h.result.current.applyKey({ key: "ArrowDown" }, h.get, h.set)).toBe(false);
  });
});
