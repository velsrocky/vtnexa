import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const browserMock = vi.hoisted(() => ({
  browserBack: vi.fn(async () => ({})),
  browserClick: vi.fn(async () => ({})),
  browserNavigate: vi.fn(async () => ({})),
  browserScreenshot: vi.fn(async () => ({})),
  browserScroll: vi.fn(async () => ({})),
  browserSnapshot: vi.fn(async () => ({ ok: true, url: "https://example.com", title: "", text: "", elements: [] })),
  browserStart: vi.fn(async () => ({ ok: true, running: true, ready: true })),
  browserStatus: vi.fn(async (): Promise<any> => ({ ready: false, running: false })),
  browserStop: vi.fn(async () => ({})),
  browserType: vi.fn(async () => ({})),
  getBrowserPort: vi.fn(() => 40123),
  setBrowserPort: vi.fn(),
}));

vi.mock("../lib/browser", () => browserMock);
vi.mock("../lib/approval", () => ({ claimFor: vi.fn(async () => ({ token: "test", detail: "{}" })) }));

import BrowserPane from "./BrowserPane";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BrowserPane", () => {
  it("shows exact missing prerequisites and keeps Start disabled", async () => {
    browserMock.browserStatus.mockResolvedValue({
      ready: false,
      running: false,
      missing: ["browser engine not found: install Google Chrome, Microsoft Edge, or Chromium"],
      remediation: ["Install Chrome, Edge, or Chromium and choose Recheck."],
    });
    render(<BrowserPane />);
    expect((await screen.findByRole("alert")).textContent).toContain("browser engine not found");
    expect((screen.getByRole("button", { name: "Start browser" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Recheck prerequisites" })).toBeTruthy();
  });

  it("rechecks prerequisites without using a page URL as the sidecar port", async () => {
    browserMock.browserStatus.mockResolvedValue({
      ready: false,
      running: false,
      baseUrl: "http://127.0.0.1:40123",
      port: 40123,
      pageUrl: "https://app.example.test:8443/account",
      missing: ["browser engine not found"],
      remediation: ["Install a browser"],
    });
    render(<BrowserPane />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Recheck prerequisites" }));
    await waitFor(() => expect(browserMock.browserStatus).toHaveBeenCalledTimes(2));
    expect(browserMock.setBrowserPort).toHaveBeenCalledWith(40123);
  });

  it("enables Start when the structured preflight is ready", async () => {
    browserMock.browserStatus.mockResolvedValue({
      ready: true,
      running: false,
      runtime: { ready: true, source: "bundled" },
      browser: { ready: true, engine: "chromium", channel: "msedge" },
      profilePath: "C:\\Users\\test\\AppData\\Local\\VTNexa\\browser-profile",
    });
    render(<BrowserPane />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Start browser" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
