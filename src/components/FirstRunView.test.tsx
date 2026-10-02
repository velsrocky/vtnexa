import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FirstRunView from "./FirstRunView";

afterEach(cleanup);

function props(overrides: Partial<React.ComponentProps<typeof FirstRunView>> = {}) {
  return {
    phase: "workspace-required" as const,
    workspaceRoot: "",
    error: null,
    details: null,
    operation: { status: "idle" as const },
    provider: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", apiKey: "", kind: "auto" as const },
    onOpenFolder: vi.fn(),
    onRetry: vi.fn(),
    onChangePath: vi.fn(),
    onProviderChange: vi.fn(),
    onCheckProvider: vi.fn(),
    ...overrides,
  };
}

describe("FirstRunView", () => {
  it("makes Open Folder the primary recovery action and explains trust", () => {
    const onOpenFolder = vi.fn();
    render(<FirstRunView {...props({ onOpenFolder })} />);
    const open = screen.getByRole("button", { name: "Open Folder" });
    expect(open.className).toContain("primary-action");
    expect(screen.getByText(/workspace boundary/i)).toBeTruthy();
    fireEvent.click(open);
    expect(onOpenFolder).toHaveBeenCalledOnce();
  });

  it("shows a retryable error with details", () => {
    const onRetry = vi.fn();
    render(
      <FirstRunView
        {...props({
          phase: "workspace-error",
          error: "The folder could not be opened.",
          details: "Folder: C:\\Users\\you\\project\nReason: access denied",
          onRetry,
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The folder could not be opened.");
    expect(screen.getByText("Show error details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows provider-required fields without rejecting a local default", () => {
    render(<FirstRunView {...props({ phase: "provider-required", error: "Enter a model before continuing." })} />);
    expect(screen.getByRole("textbox", { name: "Endpoint" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Model" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check provider" })).toBeTruthy();
    expect(screen.getByText(/local provider is configured/i)).toBeTruthy();
  });

  it("renders an explicit ready state", () => {
    render(<FirstRunView {...props({ phase: "ready" })} />);
    expect(screen.getByRole("status").textContent).toContain("ready");
    expect(screen.queryByRole("button", { name: "Open Folder" })).toBeNull();
  });

  it("shows provider checking as an explicit state", () => {
    render(<FirstRunView {...props({ phase: "provider-checking" })} />);
    expect(screen.getByRole("status").textContent).toContain("Checking provider settings…");
  });
});
