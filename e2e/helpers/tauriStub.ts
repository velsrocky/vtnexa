import type { Page } from "@playwright/test";

export async function stubTauri(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    let eventId = 1;
    const root = "/ws";
    localStorage.setItem("vtai.workspaceRoot", root);
    const files: Record<string, unknown[]> = {
      [root]: [{ name: "package.json", path: `${root}/package.json`, is_dir: false }],
    };
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        const a = args ?? {};
        if (cmd === "plugin:event|listen") return Promise.resolve(eventId++);
        if (cmd === "plugin:event|unlisten") return Promise.resolve(undefined);
        if (cmd === "workspace_root") return Promise.resolve(root);
        if (cmd === "set_workspace_root") return Promise.resolve(String(a.path));
        if (cmd === "key_get") return Promise.resolve("");
        if (cmd === "key_set") return Promise.resolve(undefined);
        if (cmd === "sandbox_status") return Promise.resolve(true);
        if (cmd === "fs_list") return Promise.resolve(files[String(a.path)] ?? []);
        if (cmd === "fs_read") return Promise.resolve("{}");
        if (cmd === "nexa_read") return Promise.resolve("");
        if (cmd === "nexa_write") return Promise.resolve(undefined);
        if (cmd === "routines_load") return Promise.resolve("[]");
        if (cmd === "routines_save") return Promise.resolve(undefined);
        if (cmd === "update_trusted_paths") return Promise.resolve(undefined);
        if (cmd === "skill_list") return Promise.resolve([]);
        if (cmd === "sessions_list") return Promise.resolve("[]");
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
