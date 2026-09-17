import { invoke } from "@tauri-apps/api/core";

/** Review-gate protocol version. Bumped whenever the issue/claim/consume
 *  shapes change. The backend rejects mismatched versions LOUDLY so a stale
 *  window (zombie pre-restart renderer against a fresh backend, or vice
 *  versa) can never fail as a confusing "approval required" — it says
 *  restart. Shown in the TopBar as `gate vN`. */
export const APPROVAL_PROTO = 3;

/** Backend capability: single-use token + the exact detail it was issued for. */
export interface Approval {
  token: string;
  detail: string;
}

/** Canonical detail fingerprint: must match what the backend compares. */
export function detailFor(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}).slice(0, 4000);
  } catch {
    return "{}";
  }
}

/** Backend action name for an agent tool (`lsp` maps to `lsp_op`). */
export function actionFor(tool: string): string {
  return tool === "lsp" ? "lsp_op" : tool;
}

/** Agent path: pops a NATIVE OS confirm dialog. Throws on reject — callers
 *  map that to `user rejected <action>`. Page JS can trigger it but cannot
 *  click it. */
export async function approvalIssue(action: string, detail?: string): Promise<Approval> {
  const d = (detail ?? "").slice(0, 4000);
  const token = await invoke<string>("approval_issue", { action, detail: d, proto: APPROVAL_PROTO });
  return { token, detail: d };
}

/** Direct-gesture path: no dialog. Only for handlers that fire on real user
 *  clicks (Diff Approve, commit buttons, tree ops, manual browser driving).
 *  The agent turn pipeline must never call this — runTool uses issue only. */
export async function approvalClaim(action: string, detail?: string): Promise<Approval> {
  const d = (detail ?? "").slice(0, 4000);
  const token = await invoke<string>("approval_claim", { action, detail: d, proto: APPROVAL_PROTO });
  return { token, detail: d };
}

/** One-liner for click handlers: claim a token for `args` in one call. */
export async function claimFor(action: string, args: unknown): Promise<Approval> {
  return approvalClaim(action, detailFor(args));
}

/** Non-empty file extensions that are safe without exec approval (pure compile). */
export function lspNeedsApproval(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // py_compile is pure; ts/rs spawn workspace code (tsc/build.rs).
  if (ext === "py" || ext === "pyi") return false;
  return true;
}
