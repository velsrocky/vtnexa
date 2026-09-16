import { useEffect, useRef } from "react";
import { DEFAULT_PROVIDER, type AuditEvent, type CenterTab, type WorkspaceUsage, type ProviderConfig, type SideTab, type Workspace } from "../types";
import { keyGet, sessionLoad, sessionSave } from "../lib/tauri";
import { uid } from "../lib/utils";
import { windowLabel } from "./useWorkspaceState";

const SESSION_TARGET_BYTES = 1_800_000;
const AUDIT_MAX = 100;

function asKind(v: unknown): "auto" | "openai" | "anthropic" | "gemini" {
  return v === "openai" || v === "anthropic" || v === "gemini" ? v : "auto";
}

function asCenterTab(v: unknown): CenterTab {
  return v === "edit" || v === "diff" || v === "preview" || v === "browser" || v === "git"
    ? v
    : "edit";
}

function asSideTab(v: unknown): SideTab {
  return v === "chat" || v === "pad" || v === "plan" || v === "memory" || v === "audit"
    ? v
    : "chat";
}

function asProvider(v: unknown): ProviderConfig | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.baseUrl !== "string" || typeof o.model !== "string") return null;
  return { baseUrl: o.baseUrl, model: o.model, apiKey: "", kind: asKind(o.kind) };
}

function asUsage(v: unknown): WorkspaceUsage {
  const o = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && isFinite(x) && x >= 0 ? x : 0);
  return {
    input: num(o.input),
    output: num(o.output),
    cost: num(o.cost),
    tools: num(o.tools),
    toolMs: num(o.toolMs),
  };
}

function asAudit(v: unknown): AuditEvent[] {
  if (!Array.isArray(v)) return [];
  const out: AuditEvent[] = [];
  for (const e of v) {
    if (!e || typeof e.tool !== "string") continue;
    out.push({
      id: typeof e.id === "string" ? e.id : uid(),
      ts: typeof e.ts === "number" && isFinite(e.ts) ? e.ts : Date.now(),
      tool: e.tool,
      args: typeof e.args === "string" ? e.args.slice(0, 1000) : "",
      decision: e.decision === "approved" || e.decision === "rejected" ? e.decision : "auto",
      ok: e.ok !== false,
      ms: typeof e.ms === "number" && isFinite(e.ms) && e.ms >= 0 ? e.ms : 0,
      ...(typeof e.note === "string" && e.note ? { note: e.note.slice(0, 200) } : {}),
    });
  }
  return out.slice(-AUDIT_MAX);
}

/** Pure workspace snapshot shared by legacy + named-session flows. */
export function snapshotWorkspace(ws: Workspace, msgCap: number): Record<string, unknown> {
  const dirtyBuffers: Record<string, string> = {};
  const dirtyOriginals: Record<string, string> = {};
  for (const t of ws.tabs ?? []) {
    const b = ws.buffers?.[t];
    const o = ws.originals?.[t];
    if (b !== undefined && b !== o) {
      dirtyBuffers[t] = b.slice(0, 50000);
      dirtyOriginals[t] = (o ?? "").slice(0, 50000);
    }
  }
  return {
    id: ws.id,
    cwd: ws.cwd,
    messages: ws.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-msgCap)
      .map((m) => ({ id: m.id, role: m.role, content: m.content })),
    usage: ws.usage,
    audit: ws.audit.slice(-AUDIT_MAX),
    tabs: (ws.tabs ?? []).slice(0, 20),
    buffers: dirtyBuffers,
    originals: dirtyOriginals,
    openPath: ws.openPath ?? "",
    shellOut: ws.shellOut?.slice(-1000) ?? "",
    shellH: ws.shellH ?? 80,
    ptyH: ws.ptyH ?? 220,
    provider: {
      baseUrl: ws.provider.baseUrl,
      model: ws.provider.model,
      kind: ws.provider.kind ?? "auto",
      apiKey: "",
    },
    centerTab: ws.centerTab ?? "edit",
    sideTab: ws.sideTab ?? "chat",
    chatDraft: ws.chatDraft ?? "",
    previewUrl: ws.previewUrl ?? "",
    planMode: ws.planMode ?? false,
    pendingDiff: ws.pendingDiff,
  };
}

/** Pure workspace restore shared by legacy + named-session flows. */
export function restoreWorkspace(l: any, fallbackId: string): Workspace {
  const p = l?.pendingDiff;
  return {
    id: typeof l?.id === "string" ? l.id : fallbackId,
    cwd: typeof l?.cwd === "string" ? l.cwd : "",
    messages: Array.isArray(l?.messages)
      ? l.messages
        .filter(
          (m: any) =>
            m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
        )
        .map((m: any) => ({ id: typeof m.id === "string" ? m.id : uid(), role: m.role, content: m.content }))
      : [],
    pendingDiff: p && typeof p === "object" && typeof p.path === "string" && typeof p.content === "string"
      ? { path: p.path, content: String(p.content ?? ""), original: String(p.original ?? "") }
      : null,
    shellOut: typeof l?.shellOut === "string" ? l.shellOut : "",
    usage: asUsage(l?.usage),
    audit: asAudit(l?.audit),
    tabs: Array.isArray(l?.tabs) ? l.tabs.filter((t: unknown) => typeof t === "string") : [],
    buffers: l?.buffers && typeof l.buffers === "object" ? l.buffers : {},
    originals: l?.originals && typeof l.originals === "object" ? l.originals : {},
    openPath: typeof l?.openPath === "string" ? l.openPath : "",
    shellH: typeof l?.shellH === "number" && isFinite(l.shellH) ? l.shellH : 80,
    ptyH: typeof l?.ptyH === "number" && isFinite(l.ptyH) ? l.ptyH : 220,
    provider:
      asProvider(l?.provider) ??
      asProvider(
        l?.providerOverride && typeof l.providerOverride === "object"
          ? {
              baseUrl: l.providerOverride.baseUrl,
              model: l.providerOverride.model,
              kind: l.providerOverride.kind,
            }
          : undefined,
      ) ?? { ...DEFAULT_PROVIDER },
    centerTab: asCenterTab(l?.centerTab),
    sideTab: asSideTab(l?.sideTab),
    chatDraft: typeof l?.chatDraft === "string" ? l.chatDraft.slice(0, 20000) : "",
    previewUrl: typeof l?.previewUrl === "string" ? l.previewUrl.slice(0, 4096) : "",
    planMode: l?.planMode === true,
  };
}

// Session persistence: each window's workspace survives a restart.
// Serialized to <workspace>/.nexa/session.json (project-local, inspectable).
// v7 stores a per-window map { windows: { "<label>": workspace } } - a new
// window starts EMPTY even in a folder another window uses, and saves never
// clobber each other (each writes only its own slot). v6 (single workspace)
// and v4/v5 (lanes[]) migrate into the "main" slot.
export function useSession(opts: {
  ws: Workspace;
  workspaceRoot: string;
  setWs: React.Dispatch<React.SetStateAction<Workspace>>;
  setCwdState: (v: string) => void;
  note: (text: string) => void;
}) {
  const sessionReady = useRef(false);
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionNoteShown = useRef(false);
  const stateRef = useRef(opts);
  stateRef.current = opts;

  function ownWorkspaceSnap(msgCap: number): Record<string, unknown> {
    return snapshotWorkspace(stateRef.current.ws, msgCap);
  }

  // Merge this window's slot into the existing file so sibling windows'
  // slots survive untouched.
  async function buildFile(existingRaw: string): Promise<{ json: string; trimmed: boolean } | null> {
    let windows: Record<string, unknown> = {};
    try {
      const prev = JSON.parse(existingRaw || "{}");
      if (prev && typeof prev === "object" && prev.windows && typeof prev.windows === "object") {
        windows = prev.windows;
      }
    } catch {
      /* corrupt or absent - start fresh */
    }
    delete windows[windowLabel];
    let cap = 500;
    for (let i = 0; i < 4; i++) {
      const next = { ...windows, [windowLabel]: ownWorkspaceSnap(cap) };
      const json = JSON.stringify({ version: 7, windows: next });
      if (json.length <= SESSION_TARGET_BYTES) return { json, trimmed: i > 0 };
      cap = Math.floor(cap / 2);
    }
    return null;
  }

  function noteTrim(kind: "trimmed" | "overflow") {
    if (sessionNoteShown.current) return;
    sessionNoteShown.current = true;
    stateRef.current.note(
      kind === "trimmed"
        ? `\nsession trimmed oldest messages to fit session.json`
        : `\nsession too large to save even trimmed - keeping last saved file`,
    );
  }

  async function saveSessionNow() {
    try {
      const existing = await sessionLoad().catch(() => "");
      const payload = await buildFile(existing);
      if (payload === null) {
        noteTrim("overflow");
        return;
      }
      await sessionSave(payload.json);
      if (payload.trimmed) noteTrim("trimmed");
    } catch {
      /* ignore save failures */
    }
  }

function asWorkspace(l: any, fallbackId: string): Workspace {
    return restoreWorkspace(l, fallbackId);
  }

  async function loadSession() {
    const { setWs, setCwdState, ws } = stateRef.current;
    try {
      const raw = await sessionLoad();
      if (!raw) return;
      const data = JSON.parse(raw) as { version?: number; windows?: unknown; workspace?: unknown; lanes?: unknown };
      let src: any;
      if (data.windows && typeof data.windows === "object") {
        // v7: only THIS window's slot. A fresh label starts empty.
        src = (data.windows as Record<string, unknown>)[windowLabel];
      } else {
        // v6 single workspace / v4-v5 lanes[0]: migrate as the main slot.
        src =
          data.workspace ?? (Array.isArray(data.lanes) && data.lanes.length ? data.lanes[0] : null);
        if (src && windowLabel !== "main") src = undefined;
      }
      if (!src) return;
      const restored = asWorkspace(src, ws.id);
      // Providers never persist their key - refill from the keychain.
      if (restored.provider?.baseUrl && restored.provider?.model) {
        try {
          const k = await keyGet(restored.provider.baseUrl, restored.provider.model);
          if (k) restored.provider = { ...restored.provider, apiKey: k };
        } catch {
          /* no keychain */
        }
      }
      setWs(restored);
      if (restored.cwd) setCwdState(restored.cwd);
    } catch {
      /* ignore corrupt session */
    } finally {
      sessionReady.current = true;
    }
  }

  // Debounced auto-save.
  useEffect(() => {
    if (!sessionReady.current || !opts.workspaceRoot) return;
    if (sessionTimer.current) clearTimeout(sessionTimer.current);
    sessionTimer.current = setTimeout(() => {
      saveSessionNow();
    }, 500);
    return () => {
      if (sessionTimer.current) clearTimeout(sessionTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.ws, opts.workspaceRoot]);

  return { saveSessionNow, loadSession, sessionReady };
}
