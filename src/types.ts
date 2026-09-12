export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface WorkspaceUsage {
  input: number;
  output: number;
  cost: number;
  tools: number;
  toolMs: number;
}

export interface AuditEvent {
  id: string;
  /** epoch ms */
  ts: number;
  tool: string;
  /** JSON args, truncated at capture */
  args: string;
  /** auto = read-only / no gate; approved/rejected = user decision */
  decision: "auto" | "approved" | "rejected";
  ok: boolean;
  ms: number;
  note?: string;
}

/** Audit input: everything but the hook-assigned id/ts. */
export interface AuditInput {
  tool: string;
  args: string;
  decision: "auto" | "approved" | "rejected";
  ok: boolean;
  ms: number;
  note?: string;
}

export interface Workspace {
  /** Window-scoped id: "<window-label>:<n>" - unique across OS windows. */
  id: string;
  cwd: string;
  messages: ChatMsg[];
  pendingDiff: { path: string; content: string; original: string } | null;
  shellOut: string;
  usage: WorkspaceUsage;
  audit: AuditEvent[];
  tabs: string[];
  buffers: Record<string, string>;
  originals: Record<string, string>;
  openPath: string;
  shellH: number;
  ptyH: number;
  /** Each window owns its provider config outright. */
  provider: ProviderConfig;
  /** This window's own UI memory. */
  centerTab: CenterTab;
  sideTab: SideTab;
  chatDraft: string;
  previewUrl: string;
}

/** Center-column tab. */
export type CenterTab = "edit" | "diff" | "preview" | "browser" | "git";

/** Right-rail tab. */
export type SideTab = "chat" | "pad" | "plan" | "memory" | "audit";

export type ProviderKind = "auto" | "openai" | "anthropic" | "gemini";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  /** repeat interval ms; 0 = manual only (Run now button) */
  everyMs: number;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  kind?: ProviderKind;
}

/** Fresh-window default. New windows inherit the current window's copy. */
export const DEFAULT_PROVIDER: ProviderConfig = {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  model: "qwen2.5-coder:7b",
  kind: "auto",
};
