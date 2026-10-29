import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/tauri";

/** Tauri awaits this handler before destroying the window. Flush the draft
 * immediately rather than relying on an autosave timer that dies on close. */
export function useCloseGuard(opts: {
  ready: boolean;
  agentActiveRef: { current: boolean };
  saveSession: () => Promise<boolean>;
}) {
  const current = useRef(opts);
  current.current = opts;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let closing = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (closing) { event.preventDefault(); return; }
      if (current.current.agentActiveRef.current) {
        event.preventDefault();
        setError("Stop Commander before closing this window.");
        return;
      }
      if (!current.current.ready) return;
      closing = true;
      setError(null);
      try {
        if (!(await current.current.saveSession())) {
          event.preventDefault();
          setError("Window kept open because the session could not be saved. Retry saving before closing.");
        }
      } catch (failure) {
        event.preventDefault();
        setError(`Window kept open because saving failed: ${failure}`);
      } finally { closing = false; }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((failure) => {
      if (!disposed) setError(`Could not enable saving on window close: ${failure}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return error;
}
