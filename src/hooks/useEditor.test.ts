// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEditor } from "./useEditor";
import { newLane } from "../lib/utils";
import type { Lane } from "../types";
import type { CenterTab } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

const realConfirm = (window as any).confirm;

afterEach(() => {
  (window as any).confirm = realConfirm;
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup(initialLane?: Lane, tab: CenterTab = "edit") {
  let store: Lane[] = [initialLane ?? newLane("L", "/w")];
  const setLanes: any = (u: any) => {
    store = typeof u === "function" ? u(store) : u;
  };
  const calls = {
    centerTab: [] as string[],
    commitMsg: [] as string[],
    audits: [] as any[],
    refreshFiles: 0,
    refreshGit: 0,
    refreshSkills: 0,
  };
  let centerTab: CenterTab = tab;
  const hook = renderHook(() =>
    useEditor({
      lane: store[0],
      setLanes,
      updateLane: (id, fn) => setLanes((ls: Lane[]) => ls.map((l) => (l.id === id ? fn(l) : l))),
      workspaceRoot: "/w",
      cwd: "/w",
      centerTab,
      setCenterTab: (t) => calls.centerTab.push(t),
      refreshFiles: async () => {
        calls.refreshFiles++;
      },
      refreshGit: () => {
        calls.refreshGit++;
      },
      refreshSkills: () => {
        calls.refreshSkills++;
      },
      commitMsg: "",
      setCommitMsg: (v) => calls.commitMsg.push(v),
      logAudit: (_id, e) => calls.audits.push(e),
    }),
  );
  const lane = () => store[0];
  const refresh = () => hook.rerender();
  return { ...hook, calls, lane, refresh, store: () => store };
}

function laneWith(over: Partial<Lane>): Lane {
  return { ...newLane("L", "/w"), id: "lane1", ...over };
}
describe("useEditor preview", () => {
  it("renders markdown to a sanitized doc", async () => {
    setInvokeImpl(async () => "");
    const h = setup(
      laneWith({
        tabs: ["/w/a.md"],
        buffers: { "/w/a.md": "# Title" },
        originals: { "/w/a.md": "# Title" },
        openPath: "/w/a.md",
      }),
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
    const h = setup(
      laneWith({
        tabs: ["/w/a.txt"],
        buffers: { "/w/a.txt": "v1" },
        originals: { "/w/a.txt": "old" },
        openPath: "/w/a.txt",
      }),
    );
    // Edit through the tab API, then stage: the gate must see v2, not v1.
    act(() => {
      h.result.current.setEditorText("v2");
    });
    h.refresh();
    act(() => {
      h.result.current.saveFile();
    });
    expect(h.lane().pendingDiff).toEqual({ path: "/w/a.txt", content: "v2", original: "old" });
    // Rerender so the gate sees the staged diff (React does this per update).
    h.refresh();
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(h.lane().pendingDiff).toBeNull();
    expect(h.lane().buffers["/w/a.txt"]).toBe("v2");
  });
});
