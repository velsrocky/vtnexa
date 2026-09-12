// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSkills } from "./useSkills";
import { newLane } from "../lib/utils";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    (globalThis as unknown as { __invokeImpl: (c: string, a?: unknown) => Promise<unknown> }).__invokeImpl(cmd, args),
}));

function setInvokeImpl(fn: (cmd: string, args?: any) => Promise<any>) {
  (globalThis as any).__invokeImpl = fn;
}

const realPrompt = (window as any).prompt;

afterEach(() => {
  (window as any).prompt = realPrompt;
  setInvokeImpl(() => Promise.reject(new Error("unexpected invoke (test did not stub it)")));
});

function setup() {
  const opened: string[] = [];
  const hook = renderHook(() =>
    useSkills({
      workspaceRoot: "/w",
      lane: newLane("L", "/w"),
      updateLane: vi.fn(),
      openFile: (path) => opened.push(path),
    }),
  );
  return { ...hook, opened };
}

describe("useSkills.refreshSkills", () => {
  it("lists skills and tolerates backend failure", async () => {
    setInvokeImpl(async (cmd) => {
      if (cmd === "skill_list") return [{ name: "fix", description: "Fix things" }];
      throw new Error(`unexpected ${cmd}`);
    });
    const h = setup();
    await act(async () => {
      await h.result.current.refreshSkills();
    });
    expect(h.result.current.skills).toEqual([{ name: "fix", description: "Fix things" }]);

    setInvokeImpl(async () => {
      throw new Error("gone");
    });
    await act(async () => {
      await h.result.current.refreshSkills();
    });
    expect(h.result.current.skills).toEqual([]);
  });
});

describe("useSkills.loadConventions", () => {
  it("prefers AGENTS.md over CLAUDE.md", async () => {
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") return args.path.endsWith("AGENTS.md") ? "team rules" : "";
      return {};
    });
    const h = setup();
    await act(async () => {
      await h.result.current.loadConventions("/w");
    });
    expect(h.result.current.conventionsName).toBe("AGENTS.md");
    expect(h.result.current.conventions).toBe("team rules");
  });

  it("falls back to CLAUDE.md, then clears", async () => {
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_read") {
        if (args.path.endsWith("AGENTS.md")) throw new Error("missing");
        if (args.path.endsWith("CLAUDE.md")) return "claude rules";
      }
      return {};
    });
    const h = setup();
    await act(async () => {
      await h.result.current.loadConventions("/w");
    });
    expect(h.result.current.conventionsName).toBe("CLAUDE.md");

    setInvokeImpl(async (cmd) => {
      if (cmd === "fs_read") throw new Error("missing");
      return {};
    });
    await act(async () => {
      await h.result.current.loadConventions("/w");
    });
    expect(h.result.current.conventionsName).toBe("");
    expect(h.result.current.conventions).toBe("");
  });
});

describe("useSkills.createSkill", () => {
  it("scaffolds a skill file and opens it", async () => {
    (window as any).prompt = vi.fn(() => "myskill");
    const written: any[] = [];
    setInvokeImpl(async (cmd, args?: any) => {
      if (cmd === "fs_write") {
        written.push(args);
        return {};
      }
      if (cmd === "skill_list") return [];
      return {};
    });
    const h = setup();
    await act(async () => {
      await h.result.current.createSkill();
    });
    expect(written[0].path).toBe("/w/.vtnexa/skills/myskill.md");
    expect(written[0].content).toMatch(/^# myskill/);
    expect(h.opened).toEqual(["/w/.vtnexa/skills/myskill.md"]);
  });

  it("rejects bad names without touching the backend", async () => {
    (window as any).prompt = vi.fn(() => "bad name!");
    let invoked = false;
    setInvokeImpl(async () => {
      invoked = true;
      return {};
    });
    const h = setup();
    await act(async () => {
      await h.result.current.createSkill();
    });
    expect(invoked).toBe(false);
    expect(h.opened).toEqual([]);
  });
});
