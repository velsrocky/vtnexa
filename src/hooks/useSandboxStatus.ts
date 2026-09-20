import { useEffect, useState } from "react";
import { isTauri, sandboxStatus } from "../lib/tauri";

/** Three-state firejail availability for the top-bar chip: null = unknown
 *  (still probing, or plain browser preview - no native shell anyway),
 *  true = agent shell commands run OS-confined, false = screening-only.
 *  A failed probe reads as false: if we cannot confirm confinement, say so. */
export function useSandboxStatus(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    sandboxStatus()
      .then((v) => alive && setOk(v))
      .catch(() => alive && setOk(false));
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}
