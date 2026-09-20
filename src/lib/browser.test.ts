// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<any> => ({})));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  browserClick,
  browserNavigate,
  browserScroll,
  browserType,
  getBrowserPort,
  setBrowserPort,
  browserStart,
  browserStop,
} from "./browser";

afterEach(() => invokeMock.mockClear());

function args(i = 0): Record<string, unknown> {
  return invokeMock.mock.calls[i][1] as Record<string, unknown>;
}

describe("browser wire format (camelCase, like shell_run)", () => {
  it("navigate sends approvalToken/approvalDetail, never snake_case", async () => {
    await browserNavigate("https://example.com", { token: "t1", detail: "u" });
    expect(args()).toEqual({ url: "https://example.com", approvalToken: "t1", approvalDetail: "u" });
  });

  it("unapproved calls send explicit nulls", async () => {
    await browserNavigate("https://example.com");
    expect(args().approvalToken).toBe(null);
    expect(args().approvalDetail).toBe(null);
  });

  it("click and type send targetRef", async () => {
    await browserClick(7, { token: "t2", detail: "7" });
    expect(args()).toMatchObject({ targetRef: 7, approvalToken: "t2" });
    await browserType(3, "hello", true, { token: "t3", detail: "3" });
    expect(args(1)).toMatchObject({ targetRef: 3, text: "hello", submit: true, approvalToken: "t3" });
  });

  it("scroll/back keep plain args", async () => {
    await browserScroll(0, 300);
    expect(invokeMock).toHaveBeenLastCalledWith("browser_scroll", { dx: 0, dy: 300 });
    await browserStop();
    expect(invokeMock).toHaveBeenLastCalledWith("browser_stop", {});
  });
});

describe("browserStart", () => {
  it("adopts the port of an already-running sidecar", async () => {
    setBrowserPort(39317);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "browser_status" ? { running: true, url: "http://127.0.0.1:40001" } : {},
    );
    const res = await browserStart(true);
    expect(res).toEqual({ ok: true, baseUrl: "http://127.0.0.1:40001" });
    expect(getBrowserPort()).toBe(40001);
  });

  it("parses the port from a fresh start and nulls fall back safely", async () => {
    setBrowserPort(39317);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "browser_status" ? { running: false } : { baseUrl: "http://127.0.0.1:40100", ok: true },
    );
    const res = await browserStart();
    expect(res).toMatchObject({ ok: true });
    expect(getBrowserPort()).toBe(40100);
    expect(args(1)).toEqual({ port: 39317, headless: false });
  });

  it("null backend reply degrades to unknown error", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "browser_status") return { running: false };
      return null;
    });
    setBrowserPort(39317);
    expect(await browserStart()).toEqual({ ok: false, error: "unknown error" });
  });
});
