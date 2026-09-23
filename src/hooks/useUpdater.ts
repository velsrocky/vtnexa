import { useCallback, useState } from "react";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "unavailable";

interface PendingUpdate {
  version: string;
  downloadAndInstall: (
    onProgress?: (p: { downloaded: number; total?: number }) => void,
  ) => Promise<void>;
}

/**
 * Tauri v2 updater wrapper. Dialog-free (tauri.conf `dialog: false`):
 * the app owns all UI through this hook.
 *
 * Outside Tauri (vite preview, Playwright) the plugin import fails —
 * reported as `unavailable`, never thrown.
 */
export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingUpdate | null>(null);

  const checkForUpdates = useCallback(async () => {
    setError(null);
    setStatus("checking");
    try {
      const mod = await import("@tauri-apps/plugin-updater").catch(() => null);
      if (!mod || typeof mod.check !== "function") {
        setStatus("unavailable");
        return;
      }
      const update = await mod.check();
      if (!update) {
        setStatus("up-to-date");
        setVersion(null);
        setPending(null);
        return;
      }
      setVersion(update.version);
      setPending({
        version: update.version,
        downloadAndInstall: async (onProgress) => {
          let total = 0;
          let downloaded = 0;
          await update.downloadAndInstall((e: DownloadEvent) => {
            if (e.event === "Started") {
              total = e.data.contentLength ?? 0;
              downloaded = 0;
            } else if (e.event === "Progress") {
              downloaded += e.data.chunkLength;
            }
            onProgress?.({ downloaded, total: total || undefined });
          });
        },
      });
      setStatus("available");
    } catch (ex) {
      setError(String(ex));
      setStatus("error");
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!pending) return;
    setError(null);
    setStatus("downloading");
    setProgress(0);
    try {
      await pending.downloadAndInstall(({ downloaded, total }) => {
        if (total) setProgress(Math.round((downloaded / total) * 100));
      });
      setProgress(100);
      setStatus("ready");
    } catch (ex) {
      setError(String(ex));
      setStatus("error");
    }
  }, [pending]);

  return {
    status,
    version,
    error,
    progress,
    checkForUpdates,
    downloadAndInstall,
  };
}
