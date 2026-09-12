// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDiffGate } from "./useDiffGate";
import { newLane } from "../lib/utils";
import type { Lane } from "../types";

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

function laneWith(over: Partial<Lane>): Lane {
  return { ...newLane("L", "/w"), id: "lane1", ...over };
}

function setup(lane: Lane) {
  let store: Lane[] = [lane];
  const setLanes: any = (u: any) => {
    store = typeof u === "function" ? u(store) : u;
  };
  const calls = {
    originals: [] as ((p: Record<string, string>) => Record<string, string>)[],
    buffers: [] as ((p: Record<string, string>) => Record<string, string>)[],
    otext: [] as string[],
    etext: [] as string[],
    commitMsg: [] as string[],
    audits: [] as any[],
    files: 0,
    git: 0,
    skills: 0,
  };
  const hook = renderHook(() =>
    useDiffGate({
      lane: store[0],
      updateLane: (id, fn) => setLanes((ls: Lane[]) => ls.map((l) => (l.id === id ? fn(l) : l))),
      workspaceRoot: "/w",
      cwd: "/w",
      openPath: store[0].openPath ?? "",
      editorText: store[0].openPath ? (store[0].buffers?.[store[0].openPath] ?? "") : "",
      originalText: store[0].openPath ? (store[0].originals?.[store[0].openPath] ?? "") : "",
      setOriginals: (v: any) => {
        calls.originals.push(v);
      },
      setBuffers: (v: any) => {
        calls.buffers.push(v);
      },
      setOriginalText: (v: string) => calls.otext.push(v),
      setEditorText: (v: string) => calls.etext.push(v),
      refreshFiles: async () => {
        calls.files++;
      },
      refreshGit: () => {
        calls.git++;
      },
      refreshSkills: () => {
        calls.skills++;
      },
      commitMsg: "",
      setCommitMsg: (v) => calls.commitMsg.push(v),
      logAudit: (_id, e) => calls.audits.push(e),
    }),
  );
  const current = () => store[0];
  const refresh = () => hook.rerender();
  return { ...hook, calls, lane: current, refresh };
}

describe("useDiffGate.saveFile", () => {
  it("stages the buffer instead of writing", () => {
    setInvokeImpl(async () => {
      throw new Error("must not write");
    });
    const h = setup(
      laneWith({
        tabs: ["/w/a.txt"],
        buffers: { "/w/a.txt": "new" },
        originals: { "/w/a.txt": "old" },
        openPath: "/w/a.txt",
      }),
    );
    act(() => {
      h.result.current.saveFile();
    });
    expect(h.lane().pendingDiff).toEqual({ path: "/w/a.txt", content: "new", original: "old" });
  });
});

describe("useDiffGate.approveDiff", () => {
  it("applies clean diffs, syncs buffers and refreshes", async () => {
    const writes: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") return "old";
      if (cmd === "fs_write") {
        writes.push(args);
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup(
      laneWith({
        tabs: ["/w/a.txt"],
        buffers: { "/w/a.txt": "new" },
        originals: { "/w/a.txt": "old" },
        openPath: "/w/a.txt",
        pendingDiff: { path: "/w/a.txt", content: "new", original: "old" },
      }),
    );
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(writes).toEqual([{ path: "/w/a.txt", content: "new" }]);
    expect(h.lane().pendingDiff).toBeNull();
    expect(h.lane().shellOut).toMatch(/applied \/w\/a\.txt/);
    // Buffers follow the applied content.
    expect(h.calls.originals).toHaveLength(1);
    expect(h.calls.originals[0]({})).toEqual({ "/w/a.txt": "new" });
    expect(h.calls.otext).toEqual(["new"]);
    expect(h.calls.etext).toEqual(["new"]);
    expect(h.calls.files).toBe(1);
    expect(h.calls.git).toBe(1);
    expect(h.calls.skills).toBe(1);
  });

  it("asks before clobbering external changes", async () => {
    let writes = 0;
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "someone else edited";
      if (cmd === "fs_write") {
        writes++;
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    (window as any).confirm = vi.fn(() => false);
    const h = setup(laneWith({ pendingDiff: { path: "/w/a.txt", content: "new", original: "old" } }));
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(writes).toBe(0);
    expect(h.lane().pendingDiff).not.toBeNull();
  });
});

describe("useDiffGate.approveAndCommit", () => {
  it("writes, commits the file and audits", async () => {
    const commits: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") return "old";
      if (cmd === "fs_write") return {};
      if (cmd === "git_commit") {
        commits.push(args);
        return { hash: "deadbeef1234" };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup(laneWith({ pendingDiff: { path: "/w/a.txt", content: "new", original: "old" } }));
    await act(async () => {
      await h.result.current.approveAndCommit();
    });
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toEqual(["/w/a.txt"]);
    expect(h.lane().pendingDiff).toBeNull();
    expect(h.lane().shellOut).toMatch(/deadbee/);
    expect(h.calls.audits).toHaveLength(1);
    expect(h.calls.audits[0]).toMatchObject({ tool: "git_commit", decision: "approved", ok: true });
    expect(h.calls.commitMsg).toEqual([""]);
  });
});
