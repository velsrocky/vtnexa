import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "../types";
import { keyGet } from "../lib/tauri";
import { loadDrafts, lookupDraftKey } from "../lib/providerHistory";
import { newWorkspace } from "../lib/utils";
import { restoreWorkspace, snapshotWorkspace } from "./useSession";
import { windowLabel } from "./useWorkspaceState";
import {
  buildSessionFile,
  deleteSession,
  getSessionFile,
  listSessions,
  newSessionId,
  type SessionFile,
  type SessionMeta,
} from "../lib/sessionStore";
import { putSessionFile } from "../lib/sessionStore";

function freshChatState(prev: Workspace, cwd: string): Workspace {
  const base = newWorkspace(prev.id, cwd || prev.cwd, prev.provider);
  return {
    ...base,
    // Preserve window chrome + editor, reset only the conversation.
    cwd: cwd || prev.cwd,
    tabs: prev.tabs,
    buffers: prev.buffers,
    originals: prev.originals,
    openPath: prev.openPath,
    shellH: prev.shellH,
    ptyH: prev.ptyH,
    centerTab: prev.centerTab,
    sideTab: "chat",
    previewUrl: prev.previewUrl,
  };
}

function isEmptySession(ws: Workspace): boolean {
  return ws.messages.length === 0 && ws.audit.length === 0 && ws.pendingDiff == null;
}

// OpenCode-style sessions: the app ALWAYS boots a fresh session per folder.
// Previous sessions live in `<workspace>/.nexa/sessions/` and are resumed
// explicitly from the dropdown. Autosave writes the current session file
// (debounced); empty sessions are never persisted to avoid list clutter.
export function useSessions(opts: {
  ws: Workspace;
  workspaceRoot: string;
  setWs: React.Dispatch<React.SetStateAction<Workspace>>;
  setCwdState: (v: string) => void;
  setOpenPath: (v: string) => void;
  note: (text: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string>(() => newSessionId());
  const [currentTitle, setCurrentTitle] = useState<string>("New session");
  const [currentCreated, setCurrentCreated] = useState<number>(() => Date.now());
  const sessionsReady = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(opts);
  stateRef.current = opts;
  const idRef = useRef(currentId);
  idRef.current = currentId;
  const titleRef = useRef(currentTitle);
  titleRef.current = currentTitle;
  const createdRef = useRef(currentCreated);
  createdRef.current = currentCreated;
  const prevOf = useRef(new Map<string, Pick<SessionFile, "created" | "title">>());

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  const persistCurrent = useCallback(
    async (wsOverride?: Workspace) => {
      const { ws, workspaceRoot } = stateRef.current;
      const source = wsOverride ?? ws;
      if (!workspaceRoot || !sessionsReady.current) return;
      if (isEmptySession(source)) return;
      const id = idRef.current;
      const snap = snapshotWorkspace(source, 500);
      const file = buildSessionFile(
        id,
        source,
        snap,
        { created: createdRef.current, title: titleRef.current },
      );
      try {
        await putSessionFile(file);
        prevOf.current.set(id, { created: file.created, title: file.title });
        if (titleRef.current !== file.title) setCurrentTitle(file.title);
        await refreshSessions();
      } catch {
        /* ignore save failures */
      }
    },
    [refreshSessions],
  );

  const newSession = useCallback(async () => {
    await persistCurrent();
    const { ws, workspaceRoot } = stateRef.current;
    const cwd = ws.cwd || workspaceRoot;
    const id = newSessionId();
    prevOf.current.delete(id);
    setCurrentId(id);
    setCurrentTitle("New session");
    setCurrentCreated(Date.now());
    stateRef.current.setWs((w) => freshChatState(w, cwd));
    stateRef.current.setOpenPath(stateRef.current.ws.openPath ?? "");
  }, [persistCurrent]);

  const resumeSession = useCallback(
    async (id: string) => {
      if (!id || id === idRef.current) return;
      await persistCurrent();
      const file = await getSessionFile(id);
      if (!file) {
        stateRef.current.note(`\nsession not found: ${id}`);
        await refreshSessions();
        return;
      }
      const { setWs, setCwdState, ws } = stateRef.current;
      const restored = restoreWorkspace(file.workspace, ws.id);
      if (restored.provider?.baseUrl && restored.provider?.model) {
        try {
          const k = await keyGet(restored.provider.baseUrl, restored.provider.model);
          if (k) restored.provider = { ...restored.provider, apiKey: k };
        } catch {
          // No keychain: fall back to this window's per-pair local backup so
          // resuming a session doesn't silently drop the key.
          const dk = lookupDraftKey(
            loadDrafts(),
            windowLabel,
            restored.provider.baseUrl,
            restored.provider.model,
          );
          if (dk) restored.provider = { ...restored.provider, apiKey: dk };
        }
      }
      prevOf.current.set(file.id, { created: file.created, title: file.title });
      setCurrentId(file.id);
      setCurrentTitle(file.title || "Untitled session");
      setCurrentCreated(file.created);
      setWs(restored);
      if (restored.cwd) setCwdState(restored.cwd);
      stateRef.current.setOpenPath(restored.openPath ?? "");
    },
    [persistCurrent, refreshSessions],
  );

  const removeSession = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        await deleteSession(id);
      } catch {
        /* ignore */
      }
      prevOf.current.delete(id);
      await refreshSessions();
      if (id === idRef.current) {
        const { ws, workspaceRoot } = stateRef.current;
        const cwd = ws.cwd || workspaceRoot;
        const next = newSessionId();
        setCurrentId(next);
        setCurrentTitle("New session");
        setCurrentCreated(Date.now());
        stateRef.current.setWs((w) => freshChatState(w, cwd));
      }
    },
    [refreshSessions],
  );

  // Fresh boot for a workspace root: list previous sessions, start empty.
  // Never auto-resumes — explicit dropdown resume only.
  const bootFresh = useCallback(
    async (root: string, cwd: string) => {
      sessionsReady.current = false;
      await refreshSessions();
      const id = newSessionId();
      prevOf.current.clear();
      setCurrentId(id);
      setCurrentTitle("New session");
      setCurrentCreated(Date.now());
      stateRef.current.setWs((w) => freshChatState(w, cwd || root));
      sessionsReady.current = true;
    },
    [refreshSessions],
  );

  // Debounced autosave of the current session file.
  useEffect(() => {
    if (!sessionsReady.current || !opts.workspaceRoot) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persistCurrent();
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
     
  }, [opts.ws, opts.workspaceRoot, currentId, persistCurrent]);

  return {
    sessions,
    currentId,
    currentTitle,
    sessionsReady,
    refreshSessions,
    persistCurrent,
    newSession,
    resumeSession,
    removeSession,
    bootFresh,
  };
}
