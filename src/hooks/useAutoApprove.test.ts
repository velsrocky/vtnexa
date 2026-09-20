// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAutoApprove } from "./useAutoApprove";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  localStorage.clear();
});

describe("useAutoApprove", () => {
  it("defaults ON (opencode-style in-workspace autonomy)", () => {
    const { result } = renderHook(() => useAutoApprove());
    expect(result.current.autoApproveWorkspace).toBe(true);
  });

  it("restores the saved flag", () => {
    localStorage.setItem("vtai.autoApproveWorkspace", "0");
    const { result } = renderHook(() => useAutoApprove());
    expect(result.current.autoApproveWorkspace).toBe(false);
  });

  it("persists toggles", () => {
    const { result } = renderHook(() => useAutoApprove());
    act(() => result.current.setAutoApproveWorkspace(false));
    expect(localStorage.getItem("vtai.autoApproveWorkspace")).toBe("0");
    act(() => result.current.setAutoApproveWorkspace(true));
    expect(localStorage.getItem("vtai.autoApproveWorkspace")).toBe("1");
  });

  it("treats junk stored values as default-on", () => {
    localStorage.setItem("vtai.autoApproveWorkspace", "maybe");
    const { result } = renderHook(() => useAutoApprove());
    expect(result.current.autoApproveWorkspace).toBe(false);
  });
});
