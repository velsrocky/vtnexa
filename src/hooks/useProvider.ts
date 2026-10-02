import { useEffect, useRef, useState } from "react";
import { windowLabel } from "./useWorkspaceState";
import type { ProviderConfig, Workspace } from "../types";
import { keyGet, keySet } from "../lib/tauri";
import { listModels } from "../lib/providers";
import {
  draftPairKey,
  isPairCleared,
  loadDrafts,
  loadHist,
  lookupDraftKey,
  markPairCleared,
  saveDrafts,
  saveHist,
  setDraftKey,
  stripDraftPair,
  stripHistoryKey,
  unmarkPairCleared,
  type ProviderEntry,
} from "../lib/providerHistory";

export type { ProviderEntry };

const WRITE_DEBOUNCE_MS = 300;
const PROBE_DEBOUNCE_MS = 500;

interface CredentialIntent {
  version: number;
  baseUrl: string;
  model: string;
  secret: string;
}

type MigrationCandidate = CredentialIntent;

function pairOf(baseUrl: string, model: string): string {
  return draftPairKey(baseUrl, model);
}

export function useProvider(opts: {
  ws: Workspace;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
}) {
  const [provHist, setProvHist] = useState<ProviderEntry[]>(() => loadHist());
  const [provModels, setProvModels] = useState<string[]>([]);
  const [modelsNote, setModelsNote] = useState("");
  const [keychainOk, setKeychainOk] = useState<boolean | null>(null);
  const histRef = useRef(provHist);
  const mountedRef = useRef(true);
  const updateWsRef = useRef(opts.updateWs);
  const activeProviderRef = useRef(opts.ws.provider);
  const intentVersionRef = useRef(0);
  const intentsRef = useRef(new Map<string, CredentialIntent>());
  const issuedVersionsRef = useRef(new Map<string, number>());
  const pendingWritesRef = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout>; intent: CredentialIntent }>(),
  );
  const credentialQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueCredentialRef = useRef(<T,>(operation: () => Promise<T>): Promise<T> => operation());
  const applyFallbackRef = useRef<(baseUrl: string, model: string) => void>(() => undefined);
  const migrateCredentialsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeGenerationRef = useRef(0);
  const migrationRunningRef = useRef(false);

  updateWsRef.current = opts.updateWs;
  activeProviderRef.current = opts.ws.provider;

  const editCfg: ProviderConfig = opts.ws.provider;

  function isCurrentIntent(intent: CredentialIntent): boolean {
    return intentsRef.current.get(pairOf(intent.baseUrl, intent.model))?.version === intent.version;
  }

  function commitHist(next: ProviderEntry[]): ProviderEntry[] {
    const saved = saveHist(next);
    histRef.current = saved;
    setProvHist(saved);
    return saved;
  }

  function purgePairPersistence(baseUrl: string, model: string): void {
    const drafts = loadDrafts();
    const nextDrafts = stripDraftPair(drafts, windowLabel, baseUrl, model);
    if (nextDrafts !== drafts) saveDrafts(nextDrafts);
    const nextHist = stripHistoryKey(histRef.current, baseUrl, model);
    if (nextHist.some((entry, index) => entry.apiKey !== histRef.current[index]?.apiKey)) {
      commitHist(nextHist);
    }
  }

  function applyFallback(baseUrl: string, model: string): void {
    if (!mountedRef.current) return;
    if (pairOf(activeProviderRef.current.baseUrl, activeProviderRef.current.model) !== pairOf(baseUrl, model)) {
      return;
    }
    setKeychainOk(false);
    const pair = pairOf(baseUrl, model);
    if (isPairCleared(pair)) return;
    const key = lookupDraftKey(loadDrafts(), windowLabel, baseUrl, model);
    if (!key) return;
    updateWsRef.current((workspace) =>
      workspace.provider.baseUrl === baseUrl &&
      workspace.provider.model === model &&
      !workspace.provider.apiKey
        ? { ...workspace, provider: { ...workspace.provider, apiKey: key } }
        : workspace,
    );
  }

  function persistFallback(intent: CredentialIntent): void {
    if (!mountedRef.current || !isCurrentIntent(intent)) return;
    if (intent.secret) {
      const drafts = loadDrafts();
      saveDrafts(setDraftKey(drafts, windowLabel, intent.baseUrl, intent.model, intent.secret));
      const nextHist = histRef.current.map((entry) =>
        entry.baseUrl.trim() === intent.baseUrl.trim() && entry.model.trim() === intent.model.trim()
          ? { ...entry, apiKey: intent.secret }
          : entry,
      );
      if (nextHist.some((entry, index) => entry.apiKey !== histRef.current[index]?.apiKey)) {
        commitHist(nextHist);
      }
    }
    if (pairOf(activeProviderRef.current.baseUrl, activeProviderRef.current.model) === pairOf(intent.baseUrl, intent.model)) {
      applyFallback(intent.baseUrl, intent.model);
    }
  }

  function handleWriteSuccess(intent: CredentialIntent): void {
    if (!mountedRef.current) return;
    purgePairPersistence(intent.baseUrl, intent.model);
    if (!isCurrentIntent(intent)) return;
    if (intent.secret === "") unmarkPairCleared(pairOf(intent.baseUrl, intent.model));
    if (pairOf(activeProviderRef.current.baseUrl, activeProviderRef.current.model) === pairOf(intent.baseUrl, intent.model)) {
      setKeychainOk(true);
    }
  }

  function handleWriteFailure(intent: CredentialIntent): void {
    if (!mountedRef.current || !isCurrentIntent(intent)) return;
    persistFallback(intent);
  }

  function enqueueCredential<T>(operation: () => Promise<T>): Promise<T> {
    const result = credentialQueueRef.current.then(operation, operation);
    credentialQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function runCredentialWrite(intent: CredentialIntent): void {
    const pair = pairOf(intent.baseUrl, intent.model);
    if (issuedVersionsRef.current.get(pair) === intent.version) return;
    issuedVersionsRef.current.set(pair, intent.version);
    void enqueueCredential(async () => {
      if (!mountedRef.current) return;
      await keySet(intent.baseUrl, intent.model, intent.secret);
    })
      .then(() => handleWriteSuccess(intent))
      .catch(() => handleWriteFailure(intent));
  }

  function cancelPendingWrite(baseUrl: string, model: string): void {
    const pair = pairOf(baseUrl, model);
    const pending = pendingWritesRef.current.get(pair);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingWritesRef.current.delete(pair);
  }

  function scheduleCredentialWrite(intent: CredentialIntent, delay = WRITE_DEBOUNCE_MS): void {
    cancelPendingWrite(intent.baseUrl, intent.model);
    const pair = pairOf(intent.baseUrl, intent.model);
    const timer = setTimeout(() => {
      pendingWritesRef.current.delete(pair);
      runCredentialWrite(intent);
    }, delay);
    pendingWritesRef.current.set(pair, { timer, intent });
  }

  function nextIntent(baseUrl: string, model: string, secret: string): CredentialIntent {
    const intent = {
      version: ++intentVersionRef.current,
      baseUrl,
      model,
      secret,
    };
    intentsRef.current.set(pairOf(baseUrl, model), intent);
    return intent;
  }

  function addMigrationCandidate(
    candidates: Map<string, MigrationCandidate>,
    baseUrl: string,
    model: string,
    secret: string,
  ): void {
    if (!baseUrl.trim() || !model.trim() || !secret) return;
    candidates.set(pairOf(baseUrl, model), {
      version: intentsRef.current.get(pairOf(baseUrl, model))?.version ?? 0,
      baseUrl,
      model,
      secret,
    });
  }

  async function migratePlaintextCredentials(): Promise<void> {
    if (migrationRunningRef.current || !mountedRef.current) return;
    migrationRunningRef.current = true;
    try {
      const candidates = new Map<string, MigrationCandidate>();
      for (const entry of loadHist()) {
        addMigrationCandidate(candidates, entry.baseUrl, entry.model, entry.apiKey);
      }
      const drafts = loadDrafts();
      const slot = drafts[windowLabel];
      if (slot) {
        addMigrationCandidate(candidates, slot.baseUrl, slot.model, slot.apiKey);
        for (const [pair, secret] of Object.entries(slot.keys ?? {})) {
          const separator = pair.lastIndexOf("|");
          if (separator > 0 && separator < pair.length - 1) {
            addMigrationCandidate(candidates, pair.slice(0, separator), pair.slice(separator + 1), secret);
          }
        }
      }
      for (const candidate of candidates.values()) {
        if (!mountedRef.current) break;
        const pair = pairOf(candidate.baseUrl, candidate.model);
        const version = intentsRef.current.get(pair)?.version ?? 0;
        try {
          const migrated = await enqueueCredential(async () => {
            if (!mountedRef.current) return false;
            if ((intentsRef.current.get(pair)?.version ?? 0) !== version) return false;
            await keySet(candidate.baseUrl, candidate.model, candidate.secret);
            return true;
          });
          const stillCurrent = (intentsRef.current.get(pair)?.version ?? 0) === version;
          if (migrated && stillCurrent && mountedRef.current) {
            purgePairPersistence(candidate.baseUrl, candidate.model);
          }
        } catch {
          if (stillCurrentVersion(candidate, version)) {
            applyFallback(candidate.baseUrl, candidate.model);
          }
        }
      }
    } finally {
      migrationRunningRef.current = false;
    }
  }

  function stillCurrentVersion(candidate: MigrationCandidate, version: number): boolean {
    return (intentsRef.current.get(pairOf(candidate.baseUrl, candidate.model))?.version ?? 0) === version;
  }

  enqueueCredentialRef.current = enqueueCredential;
  applyFallbackRef.current = applyFallback;
  migrateCredentialsRef.current = migratePlaintextCredentials;

  useEffect(() => {
    const pendingWrites = pendingWritesRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      probeGenerationRef.current += 1;
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
      for (const pending of pendingWrites.values()) clearTimeout(pending.timer);
      pendingWrites.clear();
    };
  }, []);

  function setEditCfg(patch: Partial<ProviderConfig>): void {
    const current = activeProviderRef.current;
    const next = { ...current, ...patch };
    const currentPair = pairOf(current.baseUrl, current.model);
    const nextPair = pairOf(next.baseUrl, next.model);
    activeProviderRef.current = next;
    if (currentPair !== nextPair || (typeof patch.apiKey === "string" && patch.apiKey !== "")) {
      setKeychainOk(null);
    }
    opts.updateWs((workspace) => {
      const updated = { ...workspace.provider, ...patch };
      if (("baseUrl" in patch || "model" in patch) && !("apiKey" in patch)) updated.apiKey = "";
      return { ...workspace, provider: updated };
    });

    if (currentPair !== nextPair) probeGenerationRef.current += 1;
    if (typeof patch.apiKey !== "string") return;
    const baseUrl = next.baseUrl;
    const model = next.model;
    const secret = patch.apiKey;
    const pair = pairOf(baseUrl, model);
    const validPair = !!baseUrl.trim() && !!model.trim();

    if (!validPair) {
      if (secret === "") {
        markPairCleared(pair);
        purgePairPersistence(baseUrl, model);
      }
      return;
    }

    const intent = nextIntent(baseUrl, model, secret);
    probeGenerationRef.current += 1;
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
    probeTimerRef.current = null;

    if (secret === "") {
      cancelPendingWrite(baseUrl, model);
      markPairCleared(pair);
      purgePairPersistence(baseUrl, model);
      runCredentialWrite(intent);
      return;
    }

    unmarkPairCleared(pair);
    scheduleCredentialWrite(intent);
  }

  const draftProvider = opts.ws.provider;
  useEffect(() => {
    try {
      const all = loadDrafts();
      const previous = all[windowLabel];
      const pair = pairOf(draftProvider.baseUrl, draftProvider.model);
      const previousPair = previous ? pairOf(previous.baseUrl, previous.model) : "";
      const keys = { ...(previous?.keys ?? {}) };
      let persistedKey = previousPair === pair ? previous.apiKey : (keys[pair] ?? "");

      if (isPairCleared(pair)) {
        delete keys[pair];
        persistedKey = "";
      } else if (keychainOk === false) {
        if (draftProvider.apiKey) {
          keys[pair] = draftProvider.apiKey;
          persistedKey = draftProvider.apiKey;
        } else {
          persistedKey = keys[pair] ?? "";
        }
      }

      all[windowLabel] = {
        baseUrl: draftProvider.baseUrl,
        model: draftProvider.model,
        kind: draftProvider.kind ?? "auto",
        apiKey: persistedKey,
        keys,
      };
      saveDrafts(all);
    } catch {
      return;
    }
  }, [draftProvider, keychainOk]);

  const baseUrl = opts.ws.provider.baseUrl;
  const model = opts.ws.provider.model;
  useEffect(() => {
    if (!baseUrl.trim() || !model.trim()) return;
    const pair = pairOf(baseUrl, model);
    const generation = ++probeGenerationRef.current;
    const timer = setTimeout(() => {
      probeTimerRef.current = null;
      void enqueueCredentialRef.current(async () => {
        if (!mountedRef.current || probeGenerationRef.current !== generation) return undefined;
        return keyGet(baseUrl, model);
      })
        .then((key) => {
          if (
            !mountedRef.current ||
            probeGenerationRef.current !== generation ||
            pairOf(activeProviderRef.current.baseUrl, activeProviderRef.current.model) !== pair
          ) {
            return;
          }
          setKeychainOk(true);
          if (key && !isPairCleared(pair)) {
            updateWsRef.current((workspace) =>
              workspace.provider.baseUrl === baseUrl &&
              workspace.provider.model === model &&
              workspace.provider.apiKey !== key
                ? { ...workspace, provider: { ...workspace.provider, apiKey: key } }
                : workspace,
            );
          }
          void migrateCredentialsRef.current();
        })
        .catch(() => {
          if (
            !mountedRef.current ||
            probeGenerationRef.current !== generation ||
            pairOf(activeProviderRef.current.baseUrl, activeProviderRef.current.model) !== pair
          ) {
            return;
          }
          applyFallbackRef.current(baseUrl, model);
        });
    }, PROBE_DEBOUNCE_MS);
    probeTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (probeTimerRef.current === timer) probeTimerRef.current = null;
      if (probeGenerationRef.current === generation) probeGenerationRef.current += 1;
    };
  }, [baseUrl, model]);

  function rememberProvider(used: ProviderConfig): void {
    if (!used.baseUrl.trim() || !used.model.trim()) return;
    const pair = pairOf(used.baseUrl, used.model);
    if (!used.apiKey) {
      if (intentsRef.current.get(pair)?.secret === "") unmarkPairCleared(pair);
      return;
    }

    const entry: ProviderEntry = {
      baseUrl: used.baseUrl,
      model: used.model,
      apiKey: "",
      kind: used.kind ?? "auto",
    };
    commitHist([
      entry,
      ...histRef.current.filter(
        (candidate) =>
          !(
            candidate.baseUrl === used.baseUrl &&
            candidate.model === used.model &&
            (candidate.kind ?? "auto") === (used.kind ?? "auto")
          ),
      ),
    ]);

    const currentIntent = intentsRef.current.get(pair);
    if (currentIntent) {
      if (currentIntent.secret === used.apiKey) {
        const pending = pendingWritesRef.current.get(pair);
        if (pending?.intent.version === currentIntent.version) {
          cancelPendingWrite(used.baseUrl, used.model);
          runCredentialWrite(currentIntent);
        }
      }
      return;
    }

    const intent = nextIntent(used.baseUrl, used.model, used.apiKey);
    runCredentialWrite(intent);
  }

  async function refreshModels(): Promise<void> {
    setModelsNote("loading…");
    try {
      const ids = await listModels(editCfg);
      setProvModels(ids);
      setModelsNote(ids.length ? `${ids.length} model${ids.length === 1 ? "" : "s"} found - pick from the model ▾` : "no models listed - check baseUrl");
    } catch (error) {
      setModelsNote(`models failed: ${error}`);
    }
  }

  return {
    provHist,
    provModels,
    modelsNote,
    keychainOk,
    rememberProvider,
    refreshModels,
    editCfg,
    setEditCfg,
  };
}
