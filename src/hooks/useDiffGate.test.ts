// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDiffGate } from "./useDiffGate";
import { newWorkspace } from "../lib/utils";
import type { Workspace } from "../types";

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

function setup(over: Partial<Workspace> = {}) {
  let ws: Workspace = { ...newWorkspace("main:ws", "/w"), id: "main:ws", ...over };
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
    retargeted: [] as [string, string][],
    closed: [] as string[],
  };
  const hook = renderHook(() =>
    useDiffGate({
      ws,
      updateWs: (fn) => {
        ws = fn(ws);
      },
      workspaceRoot: "/w",
      cwd: "/w",
      openPath: ws.openPath ?? "",
      editorText: ws.openPath ? (ws.buffers?.[ws.openPath] ?? "") : "",
      originalText: ws.openPath ? (ws.originals?.[ws.openPath] ?? "") : "",
      setOriginals: (v: any) => calls.originals.push(v),
      setBuffers: (v: any) => calls.buffers.push(v),
      setOriginalText: (v) => calls.otext.push(v),
      setEditorText: (v) => calls.etext.push(v),
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
      logAudit: (e) => calls.audits.push(e),
      retargetTabs: (o, n) => calls.retargeted.push([o, n]),
      closeTab: (p) => calls.closed.push(p),
    }),
  );
  return { ...hook, calls, wsOf: () => ws };
}

const staged = {
  tabs: ["/w/a.txt"],
  buffers: { "/w/a.txt": "new" },
  originals: { "/w/a.txt": "old" },
  openPath: "/w/a.txt",
  pendingDiff: { path: "/w/a.txt", content: "new", original: "old" },
};

describe("useDiffGate.saveFile", () => {
  it("stages the buffer instead of writing", () => {
    setInvokeImpl(async () => {
      throw new Error("must not write");
    });
    const h = setup({
      tabs: ["/w/a.txt"],
      buffers: { "/w/a.txt": "new" },
      originals: { "/w/a.txt": "old" },
      openPath: "/w/a.txt",
    });
    act(() => {
      h.result.current.saveFile();
    });
    expect(h.wsOf().pendingDiff).toEqual({ path: "/w/a.txt", content: "new", original: "old" });
  });
});

describe("useDiffGate.approveDiff", () => {
  it("applies clean diffs, syncs buffers and refreshes", async () => {
    const writes: any[] = [];
    let disk = "old";
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") return disk;
      if (cmd === "fs_write") {
        writes.push(args);
        disk = args.content;
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup(staged);
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(writes).toEqual([{ path: "/w/a.txt", content: "new" }]);
    expect(h.wsOf().pendingDiff).toBeNull();
    expect(h.wsOf().shellOut).toMatch(/applied \/w\/a\.txt/);
    expect(h.wsOf().shellOut).not.toMatch(/verify/);
    expect(h.calls.originals[0]({})).toEqual({ "/w/a.txt": "new" });
    expect(h.calls.etext).toEqual(["new"]);
    expect(h.calls.files).toBe(1);
    expect(h.calls.git).toBe(1);
    expect(h.calls.skills).toBe(1);
  });

  it("warns and audits when the verify re-read differs", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") return "someone rewrote it";
      if (cmd === "fs_write") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    (window as any).confirm = vi.fn(() => true);
    const h = setup(staged);
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(h.wsOf().pendingDiff).toBeNull();
    expect(h.wsOf().shellOut).toMatch(/verify/);
    expect(h.calls.audits).toMatchObject([{ tool: "fs_write", ok: false }]);
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
    const h = setup({ pendingDiff: { path: "/w/a.txt", content: "new", original: "old" } });
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(writes).toBe(0);
    expect(h.wsOf().pendingDiff).not.toBeNull();
  });
});

describe("useDiffGate.approveAndCommit", () => {
  it("writes, commits the file and audits", async () => {
    const commits: any[] = [];
    let disk = "old";
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") return disk;
      if (cmd === "fs_write") {
        disk = args.content;
        return {};
      }
      if (cmd === "git_commit") {
        commits.push(args);
        return { hash: "deadbeef1234" };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup(staged);
    await act(async () => {
      await h.result.current.approveAndCommit();
    });
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toEqual(["/w/a.txt"]);
    expect(h.wsOf().pendingDiff).toBeNull();
    expect(h.wsOf().shellOut).toMatch(/deadbee/);
    expect(h.calls.audits[0]).toMatchObject({ tool: "git_commit", decision: "approved", ok: true });
    expect(h.calls.commitMsg).toEqual([""]);
  });
});

describe("useDiffGate undo/redo", () => {
  function diskStub() {
    let disk = "old";
    const writes: any[] = [];
    const deleted: string[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") return disk;
      if (cmd === "fs_write") {
        writes.push(args);
        disk = args.content;
        return {};
      }
      if (cmd === "fs_delete") {
        deleted.push(args.path);
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    return {
      writes,
      deleted,
      disk: () => disk,
    };
  }

  it("approve -> undo restores disk + buffers -> redo reapplies", async () => {
    const d = diskStub();
    const h = setup(staged);
    expect(h.result.current.canUndo).toBe(false);
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(d.disk()).toBe("new");
    expect(h.result.current.canUndo).toBe(true);
    expect(h.result.current.undoLabel).toBe("write a.txt");

    await act(async () => {
      await h.result.current.undo();
    });
    expect(d.disk()).toBe("old");
    expect(h.wsOf().shellOut).toMatch(/↩ undid write a\.txt/);
    expect(h.calls.originals[h.calls.originals.length - 1]({})).toEqual({ "/w/a.txt": "old" });
    expect(h.calls.etext[h.calls.etext.length - 1]).toBe("old");
    expect(h.result.current.canRedo).toBe(true);

    await act(async () => {
      await h.result.current.redo();
    });
    expect(d.disk()).toBe("new");
    expect(h.wsOf().shellOut).toMatch(/↪ redid write a\.txt/);
    expect(h.result.current.canUndo).toBe(true);
    expect(h.calls.audits).toMatchObject([{ tool: "undo" }, { tool: "redo" }]);
  });

  it("says so when the stacks are empty", async () => {
    setInvokeImpl(async () => {
      throw new Error("must not touch backend");
    });
    const h = setup();
    await act(async () => {
      await h.result.current.undo();
    });
    expect(h.wsOf().shellOut).toMatch(/nothing to undo/);
    await act(async () => {
      await h.result.current.redo();
    });
    expect(h.wsOf().shellOut).toMatch(/nothing to redo/);
  });

  it("a new capture clears redo", async () => {
    const d = diskStub();
    const h = setup(staged);
    await act(async () => {
      await h.result.current.approveDiff();
    });
    await act(async () => {
      await h.result.current.undo();
    });
    expect(h.result.current.canRedo).toBe(true);
    // Second approval stages a fresh write (disk now "old" again).
    await act(async () => {
      h.result.current.pushUndo({ kind: "write", path: "/w/a.txt", before: "old", after: "v2", existedBefore: true });
    });
    expect(h.result.current.canRedo).toBe(false);
    expect(d.disk()).toBe("old");
  });

  it("undoing a new-file write deletes it and closes the tab", async () => {
    let gone = true;
    const deleted: string[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") {
        if (gone) throw new Error("No such file or directory");
        return "v1";
      }
      if (cmd === "fs_write") {
        gone = false;
        return {};
      }
      if (cmd === "fs_delete") {
        deleted.push(args.path);
        gone = true;
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup({
      tabs: ["/w/n.txt"],
      buffers: { "/w/n.txt": "v1" },
      originals: { "/w/n.txt": "" },
      openPath: "/w/n.txt",
      pendingDiff: { path: "/w/n.txt", content: "v1", original: "" },
    });
    await act(async () => {
      await h.result.current.approveDiff();
    });
    expect(h.result.current.undoLabel).toBe("create n.txt");
    await act(async () => {
      await h.result.current.undo();
    });
    expect(deleted).toEqual(["/w/n.txt"]);
    expect(h.calls.closed).toEqual(["/w/n.txt"]);
    expect(h.calls.etext[h.calls.etext.length - 1]).toBe("");
  });

  it("skips oversized snapshots with a note", async () => {
    const h = setup();
    await act(async () => {
      h.result.current.pushUndo({ kind: "write", path: "/w/big", before: "x".repeat(300 * 1024), after: "y", existedBefore: true });
    });
    expect(h.result.current.canUndo).toBe(false);
    expect(h.wsOf().shellOut).toMatch(/too large to snapshot/);
  });
});
