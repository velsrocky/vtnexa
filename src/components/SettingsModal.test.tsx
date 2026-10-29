import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...args: unknown[]) => openUrl(...args) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import SettingsModal from "./SettingsModal";
import { PROJECT_LINKS } from "../lib/links";

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

function renderSettings() {
  return render(
    <SettingsModal
      onClose={() => {}}
      autoApproveWorkspace
      onAutoApproveChange={() => {}}
    />,
  );
}

describe("SettingsModal", () => {
  it("offers a feedback path, because the app sends no telemetry", () => {
    renderSettings();
    expect(screen.getByText(/sends no telemetry/i)).toBeTruthy();
    const report = screen.getByRole("button", { name: "Report an issue" });
    fireEvent.click(report);
    expect(openUrl).toHaveBeenCalledWith(PROJECT_LINKS.issues);
  });

  it("links to the release notes and the source", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
    expect(openUrl).toHaveBeenCalledWith(PROJECT_LINKS.releases);
    openUrl.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Source & docs/ }));
    expect(openUrl).toHaveBeenCalledWith(PROJECT_LINKS.repository);
  });

  it("routes security problems to the private advisory form", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "report it privately" }));
    expect(openUrl).toHaveBeenCalledWith(PROJECT_LINKS.security);
  });

  it("keeps the autonomy switch and the update check", () => {
    renderSettings();
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  });
});
