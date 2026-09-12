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

export interface LaneUsage {
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

export interface Lane {
  id: string;
  name: string;
  cwd: string;
  messages: ChatMsg[];
  pendingDiff: { path: string; content: string; original: string } | null;
  shellOut: string;
  usage: LaneUsage;
  audit: AuditEvent[];
  tabs: string[];
  buffers: Record<string, string>;
  originals: Record<string, string>;
  openPath: string;
  shellH: number;
  ptyH: number;
  /** Each lane owns its provider config outright - no shared global. */
  provider: ProviderConfig;
  /** Set when the lane is isolated in its own git worktree. */
  worktree?: { path: string; branch: string } | null;
  /** Each lane remembers its own UI: center tab, side tab, chat draft, preview URL. */
  centerTab: CenterTab;
  sideTab: SideTab;
  chatDraft: string;
  previewUrl: string;
}

/** Center-column tab. Lives here so Lane and EditorPane share it. */
export type CenterTab = "edit" | "diff" | "preview" | "browser" | "git";

/** Right-rail tab. Lives here so Lane and ChatPane share it. */
export type SideTab = "chat" | "pad" | "plan" | "memory" | "audit";

export type ProviderKind = "auto" | "openai" | "anthropic" | "gemini";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  /** repeat interval ms; 0 = manual only (Run now button) */
  everyMs: number;
  enabled: boolean;
  /** dedicated lane, created lazily on first run */
  laneId?: string;
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

/** Fresh-lane default. New lanes inherit the active lane's copy instead. */
export const DEFAULT_PROVIDER: ProviderConfig = {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  model: "qwen2.5-coder:7b",
  kind: "auto",
};
