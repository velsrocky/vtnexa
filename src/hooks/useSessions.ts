import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationState, Workspace } from "../types";
import { keyGet } from "../lib/tauri";
import { loadDrafts, lookupDraftKey } from "../lib/providerHistory";
import { newWorkspace } from "../lib/utils";
import { restoreWorkspace, snapshotWorkspace } from "./useSession";
import { windowLabel } from "./useWorkspaceState";
import {
  buildSessionFile,
  deleteSession,
  getSessionFile,
  isValidSessionId,
  listSessions,
  newSessionId,
  putSessionFile,
  type SessionFile,
  type SessionMeta,
} from "../lib/sessionStore";

function freshChatState(prev: Workspace, cwd: string): Workspace {
  const base = newWorkspace(prev.id, cwd || prev.cwd, prev.provider);
  return {
    ...base,
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

export function useSessions(opts: {
  ws: Workspace;
  workspaceRoot: string;
  setWs: React.Dispatch<React.SetStateAction<Workspace>>;
  setCwdState: (v: string) => void;
  setOpenPath: (v: string) => void;
  note?: (text: string) => void;
  onError?: (text: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string>(() => newSessionId());
  const [currentTitle, setCurrentTitle] = useState<string>("New session");
  const [currentCreated, setCurrentCreated] = useState<number>(() => Date.now());
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const [listOperation, setListOperation] = useState<OperationState>({ status: "idle" });
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
  const sessionEpochRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const listSequenceRef = useRef(0);

  function reportError(text: string) {
    stateRef.current.onError?.(text);
    stateRef.current.note?.(text);
  }

  const refreshSessions = useCallback(async () => {
    const sequence = ++listSequenceRef.current;
    setListOperation({ status: "pending", message: "Refreshing sessions…" });
    try {
      const next = await listSessions();
      if (sequence !== listSequenceRef.current) return false;
      setSessions(next);
      setListOperation({ status: "success", message: `${next.length} session${next.length === 1 ? "" : "s"} available.` });
      return true;
    } catch (error) {
      if (sequence === listSequenceRef.current) {
        setListOperation({ status: "error", message: `Session list failed: ${error}` });
        reportError(`Session list failed: ${error}`);
      }
      return false;
    }
  }, []);

  const persistCurrent = useCallback(
    async (wsOverride?: Workspace) => {
      const { ws, workspaceRoot } = stateRef.current;
      const source = wsOverride ?? ws;
      if (!workspaceRoot || !sessionsReady.current || isEmptySession(source)) return true;
      const sequence = ++operationSequenceRef.current;
      const id = idRef.current;
      const snap = snapshotWorkspace(source, 500);
      const file = buildSessionFile(id, source, snap, { created: createdRef.current, title: titleRef.current });
      setOperation({ status: "pending", message: "Saving session…" });
      try {
        await putSessionFile(file);
        if (sequence !== operationSequenceRef.current) return true;
        prevOf.current.set(id, { created: file.created, title: file.title });
        if (titleRef.current !== file.title) setCurrentTitle(file.title);
        setOperation({ status: "success", message: "Session saved." });
        void refreshSessions();
        return true;
      } catch (error) {
        if (sequence === operationSequenceRef.current) {
          setOperation({ status: "error", message: `Session save failed: ${error}` });
          reportError(`Session save failed: ${error}`);
        }
        return false;
      }
    },
    [refreshSessions],
  );

  const newSession = useCallback(async () => {
    const saved = await persistCurrent();
    if (!saved) return false;
    ++operationSequenceRef.current;
    const { ws, workspaceRoot } = stateRef.current;
    const cwd = ws.cwd || workspaceRoot;
    const id = newSessionId();
    sessionEpochRef.current += 1;
    prevOf.current.delete(id);
    setCurrentId(id);
    setCurrentTitle("New session");
    setCurrentCreated(Date.now());
    stateRef.current.setWs((w) => freshChatState(w, cwd));
    stateRef.current.setOpenPath(stateRef.current.ws.openPath ?? "");
    setOperation({ status: "success", message: "New session ready." });
    return true;
  }, [persistCurrent]);

  const resumeSession = useCallback(
    async (id: string) => {
      if (!id || id === idRef.current) return true;
      const saved = await persistCurrent();
      if (!saved) return false;
      const sequence = ++operationSequenceRef.current;
      setOperation({ status: "pending", message: "Loading session…" });
      try {
        const file = await getSessionFile(id);
        if (!file) {
          const message = `Session not found: ${id}`;
          setOperation({ status: "error", message });
          reportError(message);
          return false;
        }
        const { setWs, setCwdState } = stateRef.current;
        const restored = restoreWorkspace(file.workspace, stateRef.current.ws.id);
        if (restored.provider?.baseUrl && restored.provider?.model) {
          try {
            const key = await keyGet(restored.provider.baseUrl, restored.provider.model);
            if (key) restored.provider = { ...restored.provider, apiKey: key };
          } catch {
            const key = lookupDraftKey(
              loadDrafts(),
              windowLabel,
              restored.provider.baseUrl,
              restored.provider.model,
            );
            if (key) restored.provider = { ...restored.provider, apiKey: key };
          }
        }
        if (sequence !== operationSequenceRef.current) return false;
        sessionEpochRef.current += 1;
        prevOf.current.set(file.id, { created: file.created, title: file.title });
        setCurrentId(file.id);
        setCurrentTitle(file.title || "Untitled session");
        setCurrentCreated(file.created);
        setWs(restored);
        if (restored.cwd) setCwdState(restored.cwd);
        stateRef.current.setOpenPath(restored.openPath ?? "");
        setOperation({ status: "success", message: "Session loaded." });
        return true;
      } catch (error) {
        if (sequence === operationSequenceRef.current) {
          setOperation({ status: "error", message: `Session load failed: ${error}` });
          reportError(`Session load failed: ${error}`);
        }
        return false;
      }
    },
    [persistCurrent],
  );

  const removeSession = useCallback(
    async (id: string) => {
      if (!id) return false;
      if (!isValidSessionId(id)) {
        const message = "Session delete failed: invalid session id";
        setOperation({ status: "error", message });
        reportError(message);
        return false;
      }
      const sequence = ++operationSequenceRef.current;
      setOperation({ status: "pending", message: "Deleting session…" });
      try {
        await deleteSession(id);
      } catch (error) {
        if (sequence === operationSequenceRef.current) {
          setOperation({ status: "error", message: `Session delete failed: ${error}` });
          reportError(`Session delete failed: ${error}`);
        }
        return false;
      }
      if (sequence !== operationSequenceRef.current) return false;
      prevOf.current.delete(id);
      sessionEpochRef.current += 1;
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
      setOperation({ status: "success", message: "Session deleted." });
      return true;
    },
    [refreshSessions],
  );

  const bootFresh = useCallback(
    async (root: string, cwd: string) => {
      sessionsReady.current = false;
      sessionEpochRef.current += 1;
      const id = newSessionId();
      prevOf.current.clear();
      setCurrentId(id);
      setCurrentTitle("New session");
      setCurrentCreated(Date.now());
      stateRef.current.setWs((w) => freshChatState(w, cwd || root));
      sessionsReady.current = true;
      setOperation({ status: "success", message: "New session ready." });
      await refreshSessions();
    },
    [refreshSessions],
  );

  const retrySave = useCallback(() => persistCurrent(), [persistCurrent]);

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
    sessionEpochRef,
    refreshSessions,
    persistCurrent,
    retrySave,
    newSession,
    resumeSession,
    removeSession,
    bootFresh,
    operation,
    listOperation,
  };
}
