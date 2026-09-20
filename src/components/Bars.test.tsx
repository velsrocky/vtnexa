// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppContextProvider, type AppContextValue } from "../context/AppContext";
import TopBar from "./TopBar";
import ProviderBar from "./ProviderBar";
import WorkspaceBar from "./WorkspaceBar";
import SessionBar from "./SessionBar";

afterEach(cleanup);

function stubCtx(over: Partial<AppContextValue> = {}): AppContextValue {
  return {
    top: {
      workspaceLabel: "demo",
      windowLabel: "main",
      scheduledCount: 2,
      mcpOn: true,
      mcpTools: 5,
      sandboxOk: true,
      themeId: "graphite",
      onOpenRoutines: vi.fn(),
      onOpenMcp: vi.fn(),
      onOpenSettings: vi.fn(),
      onThemeChange: vi.fn(),
      ...over.top,
    },
    provider: {
      windowLabel: "main",
      editCfg: { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen", kind: "auto" },
      provHist: [],
      provModels: ["qwen"],
      modelsNote: "",
      keychainOk: true,
      setEditCfg: vi.fn(),
      refreshModels: vi.fn(),
      ...over.provider,
    },
    workspace: {
      workspaceRoot: "/w",
      setWorkspaceRoot: vi.fn(),
      changeWorkspace: vi.fn(),
      browseWorkspace: vi.fn(),
      cwd: "/w/sub",
      setCwd: vi.fn(),
      ...over.workspace,
    },
    session: {
      sessions: [
        { id: "s1", title: "First", directory: "/w", updated: Date.now(), message_count: 3, preview: "" } as never,
      ],
      currentId: "s1",
      currentTitle: "First",
      busy: false,
      onNew: vi.fn(),
      onResume: vi.fn(),
      onDelete: vi.fn(),
      onRefresh: vi.fn(),
      ...over.session,
    },
  };
}

function renderWith(ctx: AppContextValue, ui: React.ReactNode) {
  return render(<AppContextProvider value={ctx}>{ui}</AppContextProvider>);
}

describe("bars read from AppContext", () => {
  it("TopBar shows workspace, routine count, MCP tools and fires callbacks", () => {
    const ctx = stubCtx();
    const { container } = renderWith(ctx, <TopBar />);
    expect(container.textContent).toContain("demo");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("5");
    fireEvent.click(screen.getByTitle("Settings (trusted paths, etc)"));
    expect(ctx.top.onOpenSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText(/New Window/));
  });

  it("TopBar warns only when the shell sandbox is confirmed absent", () => {
    const base = stubCtx();
    const withSandbox = (sandboxOk: boolean | null): AppContextValue => ({
      ...base,
      top: { ...base.top, sandboxOk },
    });
    const { rerender } = renderWith(withSandbox(false), <TopBar />);
    expect(screen.getByText(/no shell sandbox/)).toBeTruthy();
    rerender(
      <AppContextProvider value={withSandbox(true)}>
        <TopBar />
      </AppContextProvider>,
    );
    expect(screen.queryByText(/no shell sandbox/)).toBeNull();
    rerender(
      <AppContextProvider value={withSandbox(null)}>
        <TopBar />
      </AppContextProvider>,
    );
    expect(screen.queryByText(/no shell sandbox/)).toBeNull();
  });

  it("WorkspaceBar edits root/cwd and browses", () => {
    const ctx = stubCtx();
    renderWith(ctx, <WorkspaceBar />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "/w2" } });
    expect(ctx.workspace.setWorkspaceRoot).toHaveBeenCalledWith("/w2");
    fireEvent.click(screen.getByText("Browse…"));
    expect(ctx.workspace.browseWorkspace).toHaveBeenCalledOnce();
  });

  it("SessionBar lists sessions and starts fresh", () => {
    const ctx = stubCtx();
    const { container } = renderWith(ctx, <SessionBar />);
    expect(container.textContent).toContain("First");
    expect(container.textContent).toContain("1 saved");
    fireEvent.click(screen.getByText("+ New"));
    expect(ctx.session.onNew).toHaveBeenCalledOnce();
  });

  it("SessionBar throws outside the provider (fail-loud wiring)", () => {
    expect(() => render(<SessionBar />)).toThrow(/outside AppContextProvider/);
  });

  it("ProviderBar renders provider controls", () => {
    const ctx = stubCtx();
    const { container } = renderWith(ctx, <ProviderBar />);
    expect(container.textContent).toContain("main");
  });
});
