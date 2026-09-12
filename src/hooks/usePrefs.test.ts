// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePrefs } from "./usePrefs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("usePrefs theme", () => {
  it("defaults to graphite and applies it to the document", () => {
    const { result } = renderHook(() => usePrefs());
    expect(result.current.themeId).toBe("graphite");
    expect(document.documentElement.dataset.theme).toBe("graphite");
  });

  it("restores the saved theme and persists changes", () => {
    localStorage.setItem("vtai.theme", "ocean");
    const { result } = renderHook(() => usePrefs());
    expect(result.current.themeId).toBe("ocean");
    expect(result.current.theme.monaco).toBe("vs-dark");
    act(() => {
      result.current.setThemeId("paper");
    });
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(localStorage.getItem("vtai.theme")).toBe("paper");
  });

  it("falls back for unknown stored values", () => {
    localStorage.setItem("vtai.theme", "neon");
    const { result } = renderHook(() => usePrefs());
    expect(result.current.themeId).toBe("graphite");
  });
});

describe("usePrefs widths", () => {
  it("restores panel widths and drags persist", () => {
    localStorage.setItem("vtai.leftW", "300");
    const { result } = renderHook(() => usePrefs());
    expect(result.current.leftW).toBe(300);
    expect(result.current.rightW).toBe(360);

    act(() => {
      result.current.onResizerDown("left")({ preventDefault: () => {}, clientX: 100 } as any);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 150 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(result.current.leftW).toBe(350);
    expect(localStorage.getItem("vtai.leftW")).toBe("350");
  });
});
