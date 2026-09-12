import { invoke } from "@tauri-apps/api/core";

export async function ptySpawn(id: string, cwd: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_spawn", { id, cwd, cols: cols || 80, rows: rows || 24 });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  await invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  try {
    await invoke("pty_kill", { id });
  } catch {
    /* already gone */
  }
}
