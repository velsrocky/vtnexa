import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { OperationState, ProviderConfig, Workspace } from "../types";
import { DEFAULT_PROVIDER } from "../types";
import {
  setWorkspaceRoot as setWsRootBackend,
  isTauri,
} from "../lib/tauri";
import { isWithinPath } from "../lib/path";
import { WS_KEY } from "./useWorkspace";

export type InitPhase =
  | "initializing"
  | "workspace-required"
  | "workspace-error"
  | "provider-checking"
  | "provider-required"
  | "ready";

export function providerIssue(provider: ProviderConfig): string | null {
  const baseUrl = provider.baseUrl.trim();
  const model = provider.model.trim();
  if (!baseUrl) return "Enter a provider endpoint before continuing.";
  if (!model) return "Choose a model before continuing.";
  const isLocal = /localhost|127\.0\.0\.1|\[::1\]|ollama/i.test(baseUrl);
  const needsKey = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/i.test(baseUrl);
  if (needsKey && !provider.apiKey.trim()) return "This cloud provider needs an API key before continuing.";
  if (!isLocal && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    return "Enter a complete http:// or https:// provider endpoint.";
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useInit(opts: {
  workspaceRoot: string;
  wsCommitted: React.MutableRefObject<string>;
  nexaReady: React.MutableRefObject<boolean>;
  sessionsReady: React.MutableRefObject<boolean>;
  routinesReady: React.MutableRefObject<boolean>;
  setWorkspaceRoot: (v: string) => void;
  setCwdState: React.Dispatch<React.SetStateAction<string>>;
  setWs: React.Dispatch<React.SetStateAction<Workspace>>;
  setOpenPath: (v: string) => void;
  saveSessionNow: () => Promise<void | boolean>;
  bootFresh: (root: string, cwd: string) => Promise<void>;
  loadNexa: () => Promise<void>;
  loadRoutines: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  loadConventions: (root: string) => Promise<void>;
  provider?: ProviderConfig;
  sessionOperation?: OperationState;
  agentActiveRef?: MutableRefObject<boolean>;
  workspaceGenerationRef?: MutableRefObject<number>;
}) {
  const [phase, setPhase] = useState<InitPhase>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const runRef = useRef(0);
  const initializedRef = useRef(false);
  const changingRef = useRef(false);
  const providerRef = useRef<ProviderConfig>(opts.provider ?? DEFAULT_PROVIDER);
  const checkedProviderSignatureRef = useRef("");
  providerRef.current = opts.provider ?? DEFAULT_PROVIDER;
  const providerSignatureRef = useRef("");
  providerSignatureRef.current = `${opts.provider?.baseUrl ?? DEFAULT_PROVIDER.baseUrl}\u0000${opts.provider?.model ?? DEFAULT_PROVIDER.model}\u0000${opts.provider?.apiKey ?? DEFAULT_PROVIDER.apiKey}`;

  const checkProvider = useCallback(async () => {
    if (!initializedRef.current) return false;
    checkedProviderSignatureRef.current = providerSignatureRef.current;
    setError(null);
    setDetails(null);
    setPhase("provider-checking");
    setOperation({ status: "pending", message: "Checking provider settings…" });
    const run = runRef.current;
    await Promise.resolve();
    if (run !== runRef.current || !initializedRef.current) return false;
    const issue = providerIssue(providerRef.current);
    if (issue) {
      setError(issue);
      setOperation({ status: "error", message: issue });
      setPhase("provider-required");
      return false;
    }
    setOperation({ status: "success", message: "Workspace and provider ready." });
    setPhase("ready");
    return true;
  }, []);

  useEffect(() => {
    if (!initializedRef.current || phase !== "provider-required") return;
    if (checkedProviderSignatureRef.current === providerSignatureRef.current) return;
    void checkProvider();
  }, [checkProvider, opts.provider?.apiKey, opts.provider?.baseUrl, opts.provider?.model, phase]);

  const initialize = useCallback(async () => {
    const run = ++runRef.current;
    setPhase("initializing");
    setError(null);
    setDetails(null);
    setOperation({ status: "pending", message: "Opening workspace…" });
    const current = optsRef.current;
    let candidate = "";
    try {
      const stored = localStorage.getItem(WS_KEY)?.trim() || "";
      candidate = stored;
      if (!candidate.trim()) {
        if (run !== runRef.current) return;
        initializedRef.current = false;
        current.wsCommitted.current = "";
        setOperation({ status: "idle" });
        setPhase("workspace-required");
        return;
      }
      const canon = await setWsRootBackend(candidate);
      if (!canon?.trim()) {
        if (run !== runRef.current) return;
        initializedRef.current = false;
        current.wsCommitted.current = "";
        setOperation({ status: "idle" });
        setPhase("workspace-required");
        return;
      }
      current.wsCommitted.current = canon;
      current.setWorkspaceRoot(canon);
      localStorage.setItem(WS_KEY, canon);
      current.setCwdState(canon);
      current.setWs((w) => (w.cwd ? w : { ...w, cwd: canon }));
      await current.loadNexa();
      if (run !== runRef.current) return;
      await current.bootFresh(canon, canon);
      if (run !== runRef.current) return;
      await current.loadRoutines();
      if (run !== runRef.current) return;
      await current.refreshSkills();
      if (run !== runRef.current) return;
      await current.loadConventions(canon);
      if (run !== runRef.current) return;
      current.setWs((w) => (!w.cwd || !isWithinPath(canon, w.cwd) ? { ...w, cwd: canon } : w));
      if (run !== runRef.current) return;
      initializedRef.current = true;
      setOperation({ status: "success", message: "Workspace ready." });
      await checkProvider();
    } catch (caught) {
      if (run !== runRef.current) return;
      initializedRef.current = false;
      current.wsCommitted.current = "";
      const message = errorText(caught);
      setError(`VTNexa could not open the workspace${candidate ? ` (${candidate})` : ""}.`);
      setDetails(`Folder: ${candidate || "(not selected)"}\nReason: ${message}`);
      setOperation({ status: "error", message: `Workspace initialization failed: ${message}` });
      setPhase("workspace-error");
    }
  }, [checkProvider]);

  useEffect(() => {
    void initialize();
    return () => {
      runRef.current += 1;
    };
  }, [initialize]);

  async function changeWorkspace(next: string): Promise<boolean> {
    const target = next.trim();
    const current = optsRef.current;
    if (!target || target === current.wsCommitted.current) return true;
    if (current.agentActiveRef?.current) {
      setOperation({ status: "error", message: "Workspace change is paused while Commander is working." });
      return false;
    }
    if (current.sessionOperation?.status === "pending") {
      setOperation({ status: "pending", message: "Waiting for the current session save to finish." });
      return false;
    }
    if (changingRef.current) {
      setOperation({ status: "pending", message: "A workspace change is already in progress." });
      return false;
    }
    changingRef.current = true;
    const changeRun = ++runRef.current;
    const previous = current.wsCommitted.current;
    if (current.workspaceGenerationRef) current.workspaceGenerationRef.current += 1;
    setOperation({ status: "pending", message: "Changing workspace…" });
    try {
      const saved = await current.saveSessionNow();
      if (changeRun !== runRef.current) return false;
      if (saved === false) {
        setOperation({ status: "error", message: "Workspace change cancelled because the current session could not be saved." });
        return false;
      }
      const canon = await setWsRootBackend(target);
      if (!canon?.trim()) throw new Error("the selected folder is empty or unavailable");
      current.wsCommitted.current = canon;
      current.setWorkspaceRoot(canon);
      current.setCwdState(canon);
      current.setWs((w) => ({ ...w, cwd: isWithinPath(canon, w.cwd) && w.cwd ? w.cwd : canon }));
      current.setOpenPath("");
      current.nexaReady.current = false;
      await current.loadNexa();
      if (changeRun !== runRef.current) return false;
      current.sessionsReady.current = false;
      await current.bootFresh(canon, canon);
      if (changeRun !== runRef.current) return false;
      current.routinesReady.current = false;
      await current.loadRoutines();
      if (changeRun !== runRef.current) return false;
      await current.refreshSkills();
      if (changeRun !== runRef.current) return false;
      await current.loadConventions(canon);
      if (changeRun !== runRef.current) return false;
      localStorage.setItem(WS_KEY, canon);
      initializedRef.current = true;
      setError(null);
      setDetails(null);
      setOperation({ status: "success", message: `Workspace changed to ${canon}.` });
      await checkProvider();
      return true;
    } catch (caught) {
      if (changeRun !== runRef.current) return false;
      current.wsCommitted.current = "";
      initializedRef.current = false;
      const message = errorText(caught);
      setError(`Workspace change failed${previous ? ` from ${previous}` : ""}.`);
      setDetails(`Requested folder: ${target}\nReason: ${message}`);
      setOperation({ status: "error", message: `Workspace change failed: ${message}` });
      setPhase("workspace-error");
      return false;
    } finally {
      changingRef.current = false;
    }
  }

  async function browseWorkspace(): Promise<boolean> {
    const current = optsRef.current;
    if (current.agentActiveRef?.current) {
      setOperation({ status: "error", message: "Folder selection is paused while Commander is working." });
      return false;
    }
    if (!isTauri()) {
      const message = "The folder picker is available in the VTNexa desktop app. Paste a folder path here, including a Windows path such as C:\\Users\\you\\project.";
      setError(message);
      setDetails(message);
      setOperation({ status: "error", message: "Open Folder is unavailable in this browser preview." });
      setPhase("workspace-error");
      return false;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({ directory: true, multiple: false, defaultPath: current.workspaceRoot || undefined });
      const selected = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : "";
      if (typeof selected === "string" && selected) return changeWorkspace(selected);
      return true;
    } catch (caught) {
      const message = errorText(caught);
      setError("The folder picker could not be opened.");
      setDetails(message);
      setOperation({ status: "error", message: `Folder picker failed: ${message}` });
      setPhase("workspace-error");
      return false;
    }
  }

  return {
    phase,
    initPhase: phase,
    error,
    details,
    operation,
    initializing: phase === "initializing",
    ready: phase === "ready",
    retry: initialize,
    checkProvider,
    changeWorkspace,
    browseWorkspace,
  };
}
