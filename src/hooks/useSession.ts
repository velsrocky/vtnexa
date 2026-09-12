import { useEffect, useRef } from "react";
import { DEFAULT_PROVIDER, type AuditEvent, type CenterTab, type Lane, type LaneUsage, type ProviderConfig, type SideTab } from "../types";
import { fsList, keyGet, sessionLoad, sessionSave } from "../lib/tauri";
import { uid } from "../lib/utils";

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
  return {
    baseUrl: o.baseUrl,
    model: o.model,
    apiKey: "",
    kind: asKind(o.kind),
  };
}

function asUsage(v: unknown): LaneUsage {
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

export function useSession(opts: {
  lanes: Lane[];
  activeId: string;
  workspaceRoot: string;
  setLanes: React.Dispatch<React.SetStateAction<Lane[]>>;
  setActiveId: (v: string) => void;
  setCwdState: (v: string) => void;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
}) {
  const sessionReady = useRef(false);
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionNoteShown = useRef(false);
  const stateRef = useRef(opts);
  stateRef.current = opts;

  function sessionPayload(): { json: string; trimmed: boolean } | null {
    const { lanes, activeId } = stateRef.current;
    const snap = (msgCap: number) => ({
      version: 5,
      activeId,
      lanes: lanes.map((l) => {
        const dirtyBuffers: Record<string, string> = {};
        const dirtyOriginals: Record<string, string> = {};
        for (const t of l.tabs ?? []) {
          const b = l.buffers?.[t];
          const o = l.originals?.[t];
          if (b !== undefined && b !== o) {
            dirtyBuffers[t] = b.slice(0, 50000);
            dirtyOriginals[t] = (o ?? "").slice(0, 50000);
          }
        }
        return {
          id: l.id,
          name: l.name,
          cwd: l.cwd,
          messages: l.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-msgCap)
            .map((m) => ({ id: m.id, role: m.role, content: m.content })),
          usage: l.usage,
          audit: l.audit.slice(-AUDIT_MAX),
          tabs: (l.tabs ?? []).slice(0, 20),
          buffers: dirtyBuffers,
          originals: dirtyOriginals,
          openPath: l.openPath ?? "",
          shellH: l.shellH ?? 80,
          ptyH: l.ptyH ?? 220,
          centerTab: l.centerTab ?? "edit",
          sideTab: l.sideTab ?? "chat",
          chatDraft: l.chatDraft ?? "",
          previewUrl: l.previewUrl ?? "",
          provider: {
            baseUrl: l.provider.baseUrl,
            model: l.provider.model,
            kind: l.provider.kind ?? "auto",
            apiKey: "",
          },
          worktree: l.worktree ?? null,
        };
      }),
    });
    let cap = 500;
    for (let i = 0; i < 4; i++) {
      const s = JSON.stringify(snap(cap));
      if (s.length <= SESSION_TARGET_BYTES) return { json: s, trimmed: i > 0 };
      cap = Math.floor(cap / 2);
    }
    return null;
  }

  function noteSessionTrim(kind: "trimmed" | "overflow") {
    if (sessionNoteShown.current) return;
    sessionNoteShown.current = true;
    const { activeId, updateLane } = stateRef.current;
    updateLane(activeId, (l) => ({
      ...l,
      shellOut:
        l.shellOut +
        (kind === "trimmed"
          ? `\nsession trimmed oldest messages to fit session.json`
          : `\nsession too large to save even trimmed - keeping last saved file`),
    }));
  }

  async function saveSessionNow() {
    try {
      const payload = sessionPayload();
      if (payload === null) {
        noteSessionTrim("overflow");
        return;
      }
      await sessionSave(payload.json);
      if (payload.trimmed) noteSessionTrim("trimmed");
    } catch {
      /* ignore save failures */
    }
  }

  async function loadSession() {
    const { setLanes, setActiveId, setCwdState } = stateRef.current;
    try {
      const raw = await sessionLoad();
      if (!raw) return;
      const data = JSON.parse(raw) as { version?: number; lanes?: unknown; activeId?: unknown };
      if (Array.isArray(data.lanes) && data.lanes.length) {
        const restored: Lane[] = (data.lanes as any[]).map((l) => ({
          id: typeof l?.id === "string" ? l.id : uid(),
          name: typeof l?.name === "string" ? l.name : "Lane",
          cwd: typeof l?.cwd === "string" ? l.cwd : "",
          messages: Array.isArray(l?.messages)
            ? l.messages
                .filter(
                  (m: any) =>
                    m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
                )
                .map((m: any) => ({ id: typeof m.id === "string" ? m.id : uid(), role: m.role, content: m.content }))
            : [],
          pendingDiff: null,
          shellOut: "",
          usage: asUsage((l as any)?.usage),
          audit: asAudit((l as any)?.audit),
          tabs: Array.isArray((l as any)?.tabs) ? (l as any).tabs.filter((t: unknown) => typeof t === "string") : [],
          buffers: (l as any)?.buffers && typeof (l as any).buffers === "object" ? (l as any).buffers : {},
          originals: (l as any)?.originals && typeof (l as any).originals === "object" ? (l as any).originals : {},
          openPath: typeof (l as any)?.openPath === "string" ? (l as any).openPath : "",
          shellH: typeof (l as any)?.shellH === "number" && isFinite((l as any).shellH) ? (l as any).shellH : 80,
          ptyH: typeof (l as any)?.ptyH === "number" && isFinite((l as any).ptyH) ? (l as any).ptyH : 220,
          centerTab: asCenterTab((l as any)?.centerTab),
          sideTab: asSideTab((l as any)?.sideTab),
          chatDraft:
            typeof (l as any)?.chatDraft === "string" ? (l as any).chatDraft.slice(0, 20000) : "",
          previewUrl:
            typeof (l as any)?.previewUrl === "string" ? (l as any).previewUrl.slice(0, 4096) : "",
          provider:
            asProvider((l as any)?.provider) ??
            // v4 sessions stored an optional override - adopt it, else default.
            asProvider(
              (l as any)?.providerOverride && typeof (l as any).providerOverride === "object"
                ? {
                    baseUrl: (l as any).providerOverride.baseUrl,
                    model: (l as any).providerOverride.model,
                    kind: (l as any).providerOverride.kind,
                  }
                : undefined,
            ) ?? { ...DEFAULT_PROVIDER },
          worktree:
            (l as any)?.worktree && typeof (l as any).worktree.path === "string" && typeof (l as any).worktree.branch === "string"
              ? { path: (l as any).worktree.path, branch: (l as any).worktree.branch }
              : undefined,
        }));
        for (const r of restored) {
          if (r.worktree) {
            try {
              await fsList(r.worktree.path);
            } catch {
              r.worktree = null;
            }
          }
          // Lane providers never persist their key - refill from the keychain.
          if (r.provider?.baseUrl && r.provider?.model) {
            try {
              const k = await keyGet(r.provider.baseUrl, r.provider.model);
              if (k) r.provider = { ...r.provider, apiKey: k };
            } catch {
              /* no keychain */
            }
          }
        }
        setLanes(restored);
        if (typeof data.activeId === "string" && restored.some((r) => r.id === data.activeId)) {
          setActiveId(data.activeId as string);
          const active = restored.find((r) => r.id === data.activeId);
          if (active?.cwd) setCwdState(active.cwd);
        }
      }
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
  }, [opts.lanes, opts.activeId, opts.workspaceRoot]);

  return { saveSessionNow, loadSession, sessionReady };
}
