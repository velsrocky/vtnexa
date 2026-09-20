import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args: Record<string, unknown>) => ({ stdout: "", stderr: "", code: 0 })),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  fsDelete as tauriFsDelete,
  fsGlob as tauriFsGlob,
  fsSearch as tauriFsSearch,
  gitInit,
  gitLog,
  isTauri,
  sandboxStatus,
  shellBg,
  shellRun,
} from "./tauri";

// Regression: shell_run hand-rolled snake_case `approval_token` keys, but
// Tauri v2 binds command args camelCase — the invoke died with
// "missing required key approvalToken" AFTER the user approved the dialog.
describe("tauri wrapper wire format", () => {
  afterEach(() => invokeMock.mockClear());

  it("shell_run sends camelCase approval keys", async () => {
    await shellRun("/ws", "pnpm --version", { token: "t1", detail: "pnpm --version" });
    const [, args] = invokeMock.mock.calls[0];
    expect(args).toMatchObject({
      cwd: "/ws",
      cmd: "pnpm --version",
      approvalToken: "t1",
      approvalDetail: "pnpm --version",
    });
    expect(args).not.toHaveProperty("approval_token");
    expect(args).not.toHaveProperty("approval_detail");
  });

  it("shell_run sends empty strings (not null) when unapproved", async () => {
    await shellRun("/ws", "ls");
    const [, args] = invokeMock.mock.calls[0];
    expect(args.approvalToken).toBe("");
    expect(args.approvalDetail).toBe("");
  });

  it("shell_bg stays on the shared approvalArgs shape", async () => {
    await shellBg("/ws", "pnpm test", { token: "t2", detail: "pnpm test" });
    const [, args] = invokeMock.mock.calls[0];
    expect(args).toMatchObject({ approvalToken: "t2", approvalDetail: "pnpm test" });
  });

  it("sandbox_status reads the boolean verbatim", async () => {
    invokeMock.mockResolvedValueOnce(false as never);
    expect(await sandboxStatus()).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("sandbox_status");
  });
});

describe("isTauri bridge detection", () => {
  const key = "__TAURI_INTERNALS__" as const;
  const prev = (window as any)[key];
  afterEach(() => {
    if (prev === undefined) delete (window as any)[key];
    else (window as any)[key] = prev;
  });

  it("is false in a plain browser tab (no bridge, no crash)", () => {
    delete (window as any)[key];
    expect(isTauri()).toBe(false);
  });

  it("is true inside the desktop webview", () => {
    (window as any)[key] = {};
    expect(isTauri()).toBe(true);
  });
});

describe("wrapper defaults serialize explicitly (never undefined-in-payload)", () => {
  it("fs_search fills null/false defaults", async () => {
    invokeMock.mockResolvedValueOnce([] as never);
    await tauriFsSearch("needle");
    expect(invokeMock).toHaveBeenCalledWith("fs_search", {
      query: "needle",
      path: null,
      glob: null,
      caseSensitive: false,
      regex: false,
    });
  });

  it("fs_glob / fs_delete / git_log defaults", async () => {
    await tauriFsGlob("**/*.ts");
    expect(invokeMock).toHaveBeenCalledWith("fs_glob", { pattern: "**/*.ts", path: null });
    await tauriFsDelete("/w/x");
    expect(invokeMock).toHaveBeenCalledWith("fs_delete", {
      path: "/w/x",
      recursive: false,
      approvalToken: null,
      approvalDetail: null,
    });
    await gitLog("/w");
    expect(invokeMock).toHaveBeenCalledWith("git_log", { cwd: "/w", limit: null });
  });

  it("git_init passes cwd through", async () => {
    await gitInit("/w");
    expect(invokeMock).toHaveBeenCalledWith("git_init", { cwd: "/w" });
  });
});
