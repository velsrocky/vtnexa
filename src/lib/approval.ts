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

export const MAX_APPROVAL_DETAIL = 20_000;
export const MAX_NATIVE_APPROVAL_DETAIL = 1_000;
export const MAX_REVIEWABLE_SHELL_COMMAND = 800;

function compareCanonicalKeys(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const ac = a[i].codePointAt(0) ?? 0;
    const bc = b[i].codePointAt(0) ?? 0;
    if (ac !== bc) return ac - bc;
  }
  return a.length - b.length;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCanonicalKeys)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}

export function mcpApprovalDetail(server: string, tool: string, args: unknown): string {
  return canonicalJson({ server, tool, args: args ?? {} });
}

/** Canonical detail fingerprint: must match what the backend compares. */
export function detailFor(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

export function approvalDetailFor(tool: string, args: unknown): string {
  if (tool === "mcp_call_tool") {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    if (typeof record.server === "string" && typeof record.tool === "string") {
      return mcpApprovalDetail(record.server, record.tool, record.args);
    }
  }
  return detailFor(args);
}

function checkedDetail(detail?: string): string {
  const value = detail ?? "";
  if (value.length > MAX_APPROVAL_DETAIL || value.includes("\0")) {
    throw new Error("approval detail too large or invalid");
  }
  return value;
}

function shellCommandFromDetail(detail: string): string | null {
  try {
    const value: unknown = JSON.parse(detail);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const command = (value as Record<string, unknown>).cmd;
    return typeof command === "string" ? command : null;
  } catch {
    return null;
  }
}

function checkedReviewDetail(action: string, detail: string | undefined, native: boolean): string {
  const value = checkedDetail(detail);
  if (native && Array.from(value).length > MAX_NATIVE_APPROVAL_DETAIL) {
    throw new Error(`approval detail exceeds the native review limit (${MAX_NATIVE_APPROVAL_DETAIL} characters)`);
  }
  if (action === "shell_run" || action === "shell_bg") {
    const command = shellCommandFromDetail(value);
    if (command === null) throw new Error("shell approval detail must contain the exact command");
    if (Array.from(command).length > MAX_REVIEWABLE_SHELL_COMMAND) {
      throw new Error(`shell command is too long to review (maximum ${MAX_REVIEWABLE_SHELL_COMMAND} characters)`);
    }
  }
  return value;
}

/** Backend action name for an agent tool (`lsp` maps to `lsp_op`). */
export function actionFor(tool: string): string {
  if (tool === "lsp") return "lsp_op";
  if (tool.startsWith("mcp_") && tool.length > 5) return "mcp_call_tool";
  return tool;
}

/** Agent path: pops a NATIVE OS confirm dialog. Throws on reject — callers
 *  map that to `user rejected <action>`. Page JS can trigger it but cannot
 *  click it. */
export async function approvalIssue(action: string, detail?: string): Promise<Approval> {
  const d = checkedReviewDetail(action, detail, true);
  const token = await invoke<string>("approval_issue", { action, detail: d, proto: APPROVAL_PROTO });
  return { token, detail: d };
}

/** Direct-gesture path: no dialog. Only for handlers that fire on real user
 *  clicks (Diff Approve, commit buttons, tree ops, manual browser driving)
 *  plus runTool's workspace auto-approval (opencode-style): the TRUSTED
 *  frontend claims for workspace-confined agent ops after ITS OWN
 *  confinement check — the model never sees tokens and never calls this. */
export async function approvalClaim(action: string, detail?: string): Promise<Approval> {
  const d = checkedReviewDetail(action, detail, false);
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
