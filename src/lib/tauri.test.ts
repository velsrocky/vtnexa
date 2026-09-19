import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args: Record<string, unknown>) => ({ stdout: "", stderr: "", code: 0 })),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { shellBg, shellRun } from "./tauri";

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
});
