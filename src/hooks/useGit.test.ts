// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGit } from "./useGit";

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

const STATUS = { branch: "main", root: "/w", files: [{ path: "a.txt", status: "M" }] };
const LOG = [{ hash: "abc123", author: "dev", date: "2026-01-01", message: "init" }];

function setup(invokeImpl: (cmd: string, args?: any) => Promise<any>) {
  setInvokeImpl(invokeImpl);
  const audits: any[] = [];
  const hook = renderHook(() => useGit({ getRoot: () => "/w", logAudit: (e) => audits.push(e) }));
  return { ...hook, audits };
}

describe("useGit.refreshGit", () => {
  it("loads status, log and selected diff", async () => {
    const { result } = setup(async (cmd, args) => {
      if (cmd === "git_status") return STATUS;
      if (cmd === "git_log") return LOG;
      if (cmd === "git_diff") {
        expect(args).toMatchObject({ path: "/w/a.txt" });
        return "diff --git a/a.txt";
      }
      if (cmd === "approval_claim") return "tok-test";
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => {
      await result.current.refreshGit("a.txt");
    });
    expect(result.current.branch).toBe("main");
    expect(result.current.files).toHaveLength(1);
    expect(result.current.logList).toEqual(LOG);
    expect(result.current.note).toBe("1 changed");
    expect(result.current.diffText).toBe("diff --git a/a.txt");
  });

  it("reports a clean tree", async () => {
    const { result } = setup(async (cmd) => {
      if (cmd === "git_status") return { ...STATUS, files: [] };
      if (cmd === "git_log") return [];
      if (cmd === "approval_claim") return "tok-test";
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => {
      await result.current.refreshGit();
    });
    expect(result.current.note).toBe("clean");
  });

  it("translates non-repo errors", async () => {
    const { result } = setup(async (cmd) => {
      if (cmd === "git_status") throw new Error("git status: fatal: not a git repository");
      if (cmd === "git_log") return [];
      if (cmd === "approval_claim") return "tok-test";
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => {
      await result.current.refreshGit();
    });
    expect(result.current.note).toBe("not a git repo");
    expect(result.current.branch).toBe("");
  });
});

describe("useGit.selectGitFile", () => {
  it("loads the diff for an absolute repo path", async () => {
    const diffs: any[] = [];
    const { result } = setup(async (cmd, args) => {
      if (cmd === "git_status") return STATUS;
      if (cmd === "git_log") return LOG;
      if (cmd === "git_diff") {
        diffs.push(args);
        return "diff!";
      }
      if (cmd === "approval_claim") return "tok-test";
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => {
      await result.current.refreshGit();
    });
    await act(async () => {
      await result.current.selectGitFile("a.txt");
    });
    expect(result.current.sel).toBe("a.txt");
    expect(diffs[diffs.length - 1]).toMatchObject({ path: "/w/a.txt" });
    expect(result.current.diffText).toBe("diff!");
  });
});

describe("useGit.commitListed", () => {
  function baseImpl(committed: any[], failCommit = false) {
    return async (cmd: string, _args?: any) => {
      if (cmd === "git_status") return STATUS;
      if (cmd === "git_log") return LOG;
      if (cmd === "git_diff") return "";
      if (cmd === "git_commit") {
        if (failCommit) throw new Error("nothing to commit?");
        committed.push(_args);
        return { hash: "abcdef123456" };
      }
      if (cmd === "approval_claim") return "tok-test";
      throw new Error(`unexpected ${cmd}`);
    };
  }

  async function ready(invokeImpl: (cmd: string, args?: any) => Promise<any>) {
    const h = setup(invokeImpl);
    await act(async () => {
      await h.result.current.refreshGit();
    });
    return h;
  }

  it("requires a message", async () => {
    const { result } = await ready(baseImpl([]));
    await act(async () => {
      await result.current.commitListed();
    });
    expect(result.current.note).toBe("commit message required");
  });

  it("commits listed files absolutely and audits approval", async () => {
    const committed: any[] = [];
    const { result, audits } = await ready(baseImpl(committed));
    act(() => {
      result.current.setMsg("my change");
    });
    await act(async () => {
      await result.current.commitListed();
    });
    expect(committed).toHaveLength(1);
    expect(committed[0].files).toEqual(["/w/a.txt"]);
    expect(result.current.msg).toBe("");
    expect(result.current.note).toBe("committed abcdef1");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool: "git_commit", decision: "approved", ok: true });
  });

  it("audits failed commits", async () => {
    const committed: any[] = [];
    const { result, audits } = await ready(baseImpl(committed, true));
    act(() => {
      result.current.setMsg("oops");
    });
    await act(async () => {
      await result.current.commitListed();
    });
    expect(committed).toHaveLength(0);
    expect(result.current.note).toMatch(/^commit failed/);
    expect(audits[audits.length - 1]).toMatchObject({ tool: "git_commit", ok: false });
  });
});
