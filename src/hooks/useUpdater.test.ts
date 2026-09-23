// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const checkMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

import { useUpdater } from "./useUpdater";

beforeEach(() => {
  checkMock.mockReset();
});

describe("useUpdater", () => {
  it("reports up-to-date when check() returns null", async () => {
    checkMock.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useUpdater());
    await act(async () => {
      await result.current.checkForUpdates();
    });
    expect(result.current.status).toBe("up-to-date");
  });

  it("exposes an available update then installs to ready", async () => {
    const downloadAndInstall = vi.fn(async () => {});
    checkMock.mockResolvedValueOnce({ version: "1.0.0", downloadAndInstall });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {
      await result.current.checkForUpdates();
    });
    expect(result.current.status).toBe("available");
    expect(result.current.version).toBe("1.0.0");
    await act(async () => {
      await result.current.downloadAndInstall();
    });
    expect(result.current.status).toBe("ready");
    expect(downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("reports error when check() throws", async () => {
    checkMock.mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useUpdater());
    await act(async () => {
      await result.current.checkForUpdates();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch("network down");
  });
});
