import type { UndoEntry } from "../../types";
import type { Approval } from "../approval";
import type { NexaKind } from "../tauri";

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ToolPolicy {
  /** Agent fs_write no longer writes directly: stage into Diff review gate.
   *  May be async - the UI fetches the on-disk original for a faithful diff. */
  onProposeWrite?: (path: string, content: string) => void | Promise<void>;
  /** Return an Approval (native OS dialog confirmed) to allow
   *  shell/browser/file side-effects, null to reject. Read-only tools bypass
   *  this. The dialog lives outside page DOM so injected content and the model
   *  cannot click it. */
  requestApproval?: (tool: string, args: Record<string, any>) => Promise<Approval | null>;
  /** Agent wrote a Nexa note directly: mirror it into the sidebar state. */
  onNexaWrite?: (kind: NexaKind, content: string) => void;
  /** Plan mode: runTool refuses every non-read-only tool (fail-closed), and
   *  chatWithTools withholds their defs so the model plans instead of acts. */
  planMode?: boolean;
  /** Reversible agent file op just applied (rename/delete) - UI pushes it for /undo. */
  onUndoCapture?: (e: UndoEntry) => void;
}

/** Backend verdict for a tool call (Rust `tool_gate` command - the authority
 *  for gate policy). `gated` = requires user approval; `plan_refused` =
 *  non-read-only tool in plan mode. */
export interface GateVerdict {
  gated: boolean;
  plan_refused: boolean;
  reason?: string;
}

/** Normalized message shared by all provider backends. Assistant entries may
 *  carry tool_calls; tool results use role "tool" + tool_call_id. */
export interface NormMsg {
  role: string;
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** JPEG base64 screenshots (vision). Set on synthetic user messages. */
  images?: string[];
}
