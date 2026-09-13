import type { ChatMsg, Workspace } from "../types";
import { baseName } from "./utils";
import {
  sessionDelete as tauriSessionDelete,
  sessionGet as tauriSessionGet,
  sessionPut as tauriSessionPut,
  sessionsList as tauriSessionsList,
  type SessionMeta,
} from "./tauri";

export type { SessionMeta };

export const SESSION_VERSION = 8;

/** Session file shape: `<workspace>/.nexa/sessions/<id>.json`. */
export interface SessionFile {
  version: number;
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
  workspace: Record<string, unknown>;
}

/** Client-generated id: sortable-ish, filesystem-safe, no traversal. */
export function newSessionId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `ses_${now.toString(36)}_${rand}`;
}

export function isValidSessionId(id: unknown): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

/** OpenCode-style default title: first user message, truncated. */
export function deriveTitle(messages: ChatMsg[], fallback = "New session"): string {
  const first = (messages ?? []).find(
    (m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim(),
  );
  if (!first) return fallback;
  const oneLine = first.content.trim().split("\n")[0].trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

export function sessionDisplayName(meta: SessionMeta): string {
  return meta.title || "Untitled session";
}

export function sessionDirLabel(directory: string): string {
  return baseName(directory.replace(/\/$/, "")) || directory;
}

export async function listSessions(): Promise<SessionMeta[]> {
  try {
    const metas = await tauriSessionsList();
    return [...metas].sort((a, b) => b.updated - a.updated || (b.id < a.id ? -1 : 1));
  } catch {
    return [];
  }
}

export async function getSessionFile(id: string): Promise<SessionFile | null> {
  if (!isValidSessionId(id)) return null;
  try {
    const raw = await tauriSessionGet(id);
    const data = JSON.parse(raw) as SessionFile;
    if (!data || typeof data !== "object" || data.workspace == null) return null;
    return data;
  } catch {
    return null;
  }
}

export async function putSessionFile(file: SessionFile): Promise<void> {
  if (!isValidSessionId(file.id)) throw new Error("session: invalid id");
  await tauriSessionPut(file.id, JSON.stringify(file));
}

export async function deleteSession(id: string): Promise<void> {
  if (!isValidSessionId(id)) return;
  await tauriSessionDelete(id);
}

export function buildSessionFile(
  id: string,
  ws: Workspace,
  snapshot: Record<string, unknown>,
  prev?: Pick<SessionFile, "created" | "title"> | null,
  now = Date.now(),
): SessionFile {
  const created = prev?.created ?? now;
  const prevTitle = prev?.title ?? "";
  const title =
    prevTitle && prevTitle !== "New session"
      ? prevTitle
      : deriveTitle(ws.messages ?? []);
  return {
    version: SESSION_VERSION,
    id,
    title,
    directory: ws.cwd || "",
    created,
    updated: now,
    workspace: snapshot,
  };
}
