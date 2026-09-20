import { DEFAULT_PROVIDER, type ChatMsg, type ProviderConfig, type Workspace } from "../types";

export const uid = () => Math.random().toString(36).slice(2, 9);

export function newWorkspace(id: string, cwd: string, provider?: ProviderConfig): Workspace {
  return {
    id,
    cwd,
    messages: [],
    pendingDiff: null,
    shellOut: "",
    usage: { input: 0, output: 0, cost: 0, tools: 0, toolMs: 0 },
    audit: [],
    tabs: [],
    buffers: {},
    originals: {},
    openPath: "",
    shellH: 80,
    ptyH: 220,
    provider: provider ? { ...provider } : { ...DEFAULT_PROVIDER },
    centerTab: "edit",
    sideTab: "chat",
    chatDraft: "",
    previewUrl: "",
    planMode: false,
  };
}

export function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function isWithin(root: string, p: string): boolean {
  if (!root) return true; // not initialized yet - allow, backend still enforces
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return p === r || p.startsWith(r + "/");
}

export const baseName = (p: string) => p.split("/").pop() ?? p;

export const dirName = (p: string) => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};

export const clampW = (v: number, lo: number, hi: number, fb: number) =>
  Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : fb;

/** The last turn died of budget/loop, not of completion: offer Continue.
 *  Matches the loop marker (system-generated, only the budget path emits it)
 *  in recent history, or the budget-exhausted fallback in the last answer. */
export function didExhaustBudget(messages: ChatMsg[]): boolean {
  const tail = messages.slice(-3);
  if (tail.some((m) => m.id !== "stream" && m.content.includes("loop detected"))) return true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.id === "stream") continue;
    if (m.role !== "assistant") return false;
    return m.content.includes("tool budget exhausted");
  }
  return false;
}
