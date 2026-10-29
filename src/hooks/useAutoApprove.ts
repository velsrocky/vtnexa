import { useEffect, useState } from "react";

const STORAGE_KEY = "vtai.autoApproveWorkspace";

/** Opencode-style autonomy: in-workspace operations skip approval dialogs.
 *  Defaults ON; detected outside references require a native dialog.
 *  Screening cannot infer the outside effects of project scripts. */
export function useAutoApprove() {
  const [autoApproveWorkspace, setAutoApproveWorkspace] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw === null ? true : raw === "1";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, autoApproveWorkspace ? "1" : "0");
    } catch {
      /* persistence is best-effort */
    }
  }, [autoApproveWorkspace]);

  return { autoApproveWorkspace, setAutoApproveWorkspace };
}
