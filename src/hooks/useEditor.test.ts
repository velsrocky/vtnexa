// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEditor } from "./useEditor";
import { newWorkspace } from "../lib/utils";
import type { CenterTab, Workspace } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

afterEach(() => {
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup(over: Partial<Workspace> = {}, tab: CenterTab = "edit") {
  let ws: Workspace = { ...newWorkspace("main:ws", "/w"), id: "main:ws", ...over };
  const setWs: any = (u: any) => {
    ws = typeof u === "function" ? u(ws) : u;
  };
  const hook = renderHook(() =>
    useEditor({
      ws,
      setWs,
      updateWs: (fn) => {
        ws = fn(ws);
      },
      workspaceRoot: "/w",
      cwd: "/w",
      centerTab: tab,
      setCenterTab: vi.fn(),
      refreshFiles: async () => {},
      refreshGit: vi.fn(),
      refreshSkills: vi.fn(),
      commitMsg: "",
      setCommitMsg: vi.fn(),
      logAudit: vi.fn(),
    }),
  );
  return { ...hook, wsOf: () => ws, refresh: () => hook.rerender() };
}

describe("useEditor preview", () => {
  it("renders markdown to a sanitized doc", async () => {
    setInvokeImpl(async () => "");
    const h = setup(
      {
        tabs: ["/w/a.md"],
        buffers: { "/w/a.md": "# Title" },
        originals: { "/w/a.md": "# Title" },
        openPath: "/w/a.md",
      },
      "preview",
    );
    await act(async () => {});
    expect(h.result.current.previewDoc).toMatch(/<h1/);
    expect(h.result.current.previewDoc).toContain("Title");
  });
});

describe("useEditor composition", () => {
  it("stages live buffer text through the gate", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "old";
      if (cmd === "fs_write") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup({
      tabs: ["/w/a.txt"],
      buffers: { "/w/a.txt": "v1" },
      originals: { "/w/a.txt": "old" },
      openPath: "/w/a.txt",
    });
    act(() => {
      h.result.current.setEditorText("v2");
    });
    h.refresh();
    act(() => {
      h.result.current.saveFile();
    });
    expect(h.wsOf().pendingDiff).toEqual({ path: "/w/a.txt", content: "v2", original: "old" });
    h.refresh();
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(h.wsOf().pendingDiff).toBeNull();
    expect(h.wsOf().buffers["/w/a.txt"]).toBe("v2");
  });
});
