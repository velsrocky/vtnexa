import { test, expect, type Page } from "@playwright/test";
import { routeProvider, roleContents } from "../helpers/mockProvider";

const E2E_BASE = "http://127.0.0.1:18080/v1";

// Browser-only Tauri bridge, injected before any app code runs. Answers the
// workspace-boot path; everything else rejects like a missing backend would.
async function stubTauri(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const calls: string[] = [];
    w.__tauriInvokeCalls = calls;
    let eventId = 1;
    const root = "/ws";
    const files: Record<string, unknown[]> = {
      [root]: [{ name: "package.json", path: `${root}/package.json`, is_dir: false }],
    };
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push(cmd);
        const a = args ?? {};
        if (cmd === "plugin:event|listen") return Promise.resolve(eventId++);
        if (cmd === "plugin:event|unlisten") return Promise.resolve(undefined);
        if (cmd === "workspace_root") return Promise.resolve(root);
        if (cmd === "set_workspace_root") return Promise.resolve(root);
        if (cmd === "key_get") return Promise.resolve("");
        if (cmd === "key_set") return Promise.resolve(undefined);
        if (cmd === "fs_list") return Promise.resolve(files[String(a.path)] ?? []);
        if (cmd === "fs_read") return Promise.resolve("{}");
        if (cmd === "nexa_read") return Promise.resolve("");
        if (cmd === "nexa_write") return Promise.resolve(undefined);
        if (cmd === "routines_load") return Promise.resolve("[]");
        if (cmd === "routines_save") return Promise.resolve(undefined);
        if (cmd === "skill_list") return Promise.resolve([]);
        if (cmd === "sessions_list") return Promise.resolve([]);
        if (cmd === "shell_run") return Promise.resolve({ stdout: "stub\n", stderr: "", code: 0 });
        if (cmd.startsWith("pty_")) return Promise.resolve(undefined);
        return Promise.reject(new Error(`e2e stub has no case for ${cmd}`));
      },
      transformCallback: (cb: () => void) => cb,
      unregisterCallback: () => {},
      runCallback: () => {},
      callbacks: new Map(),
      convertFileSrc: (p: string) => p,
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    };
  });
}
test.describe("Commander agent turn (e2e, mocked backend)", () => {
  test("completes a tool round and shows tools, audit and answer", async ({ page }) => {
    await stubTauri(page);

    const log = routeProvider(page, E2E_BASE, [
      { tool: "fs_list", args: { path: "/ws" } },
      "The project holds package.json, listed via **fs_list**.",
    ]);

    await page.goto("/");
    // Workspace boot must settle (file tree lists package.json)...
    await expect(page.getByText("📄 package.json")).toBeVisible({ timeout: 20000 });
    // ...and the real provider-history stores get seeded so the draft survives.
    await page.evaluate((base) => {
      localStorage.setItem(
        "vtai.providerHistory",
        JSON.stringify([{ baseUrl: base, model: "e2e-mock", apiKey: "", kind: "openai" }]),
      );
      localStorage.setItem(
        "vtai.providerDraft",
        JSON.stringify({ baseUrl: base, model: "e2e-mock", apiKey: "", kind: "openai" }),
      );
    }, E2E_BASE);
    await page.reload();
    await expect(page.getByText("📄 package.json")).toBeVisible({ timeout: 20000 });

    const chatInput = page.getByPlaceholder(/Talk\. It drives the workspace/);
    await chatInput.fill("list the project");
    await page.getByRole("button", { name: "Send" }).click();

    // The finalized answer (the streaming message is replaced on
    // completion). Renders as markdown and mentions the tool.
    const commander = page.locator(".msg.assistant", { hasText: "The project holds package.json" });
    await expect(commander).toContainText("The project holds package.json", { timeout: 30000 });
    await expect(commander.locator(".md strong")).toContainText("fs_list");

    // Tool call summary row collapsed, expands to the fs_list card.
    const summary = page.locator("button.toolcard-summary, .toolcard-summary").first();
    if ((await summary.count()) > 0) {
      await summary.click();
      await expect(page.locator(".toolcards, .toolcard")).toContainText("fs_list");
    }

    // Audit tab records the auto-approved read.
    await page.getByRole("button", { name: /Audit/ }).click();
    await expect(page.locator(".msgs, .audit").first()).toContainText("fs_list");

    // The provider saw the user task in both requests.
    expect(log.requests.length).toBeGreaterThanOrEqual(2);
    for (const msgs of log.requests) {
      const users = roleContents(msgs).filter((m) => m.role === "user");
      expect(users.some((u) => u.content === "list the project")).toBe(true);
    }
  });
});
