// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  isTauri: true,
  status: undefined as undefined | (() => Promise<boolean>),
}));

vi.mock("../lib/tauri", () => ({
  isTauri: () => mocks.isTauri,
  sandboxStatus: () => (mocks.status ?? (async () => true))(),
}));

import { useSandboxStatus } from "./useSandboxStatus";

afterEach(() => {
  mocks.isTauri = true;
  mocks.status = undefined;
});

describe("useSandboxStatus", () => {
  it("reports unknown until probed, then confined", async () => {
    let resolve!: (v: boolean) => void;
    mocks.status = () => new Promise<boolean>((r) => (resolve = r));
    const { result } = renderHook(() => useSandboxStatus());
    expect(result.current).toBe(null);
    resolve(true);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("shows the chip when firejail is absent", async () => {
    mocks.status = async () => false;
    const { result } = renderHook(() => useSandboxStatus());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("fails closed: a broken probe reads as unconfined", async () => {
    mocks.status = () => Promise.reject(new Error("boom"));
    const { result } = renderHook(() => useSandboxStatus());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("stays unknown in plain browser preview (no native shell anyway)", async () => {
    mocks.isTauri = false;
    const { result } = renderHook(() => useSandboxStatus());
    await Promise.resolve();
    expect(result.current).toBe(null);
  });
});
