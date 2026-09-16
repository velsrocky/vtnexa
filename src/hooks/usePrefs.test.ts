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

describe("usePrefs skill height", () => {
  it("defaults, restores, drags and clamps", () => {
    const first = renderHook(() => usePrefs());
    expect(first.result.current.skillH).toBe(150);
    first.unmount();

    localStorage.setItem("vtai.skillH", "220");
    const { result } = renderHook(() => usePrefs());
    expect(result.current.skillH).toBe(220);

    // Drag up 40px grows the section.
    act(() => {
      result.current.onSkillResizerDown({ preventDefault: () => {}, clientY: 300 } as any);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientY: 260 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(result.current.skillH).toBe(260);
    expect(localStorage.getItem("vtai.skillH")).toBe("260");

    // Clamped to [60, 400].
    act(() => {
      result.current.onSkillResizerDown({ preventDefault: () => {}, clientY: 260 } as any);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientY: -500 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(result.current.skillH).toBe(400);
  });
});
