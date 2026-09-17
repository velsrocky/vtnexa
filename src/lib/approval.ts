import { invoke } from "@tauri-apps/api/core";

/** Backend capability token: single-use, 5min, bound to this window + action. */
export async function approvalIssue(action: string, detail?: string): Promise<string> {
  return invoke<string>("approval_issue", { action, detail: detail ?? null });
}

/** Non-empty file extensions that are safe without exec approval (pure compile). */
export function lspNeedsApproval(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // py_compile is pure; ts/rs spawn workspace code (tsc/build.rs).
  if (ext === "py" || ext === "pyi") return false;
  return true;
}
