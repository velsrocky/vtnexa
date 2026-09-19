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
  stripHistoryKey,
  unmarkPairCleared,
  type ProviderEntry,
} from "../lib/providerHistory";

export type { ProviderEntry };

// Per-window provider config: the bar edits THIS window's own copy - there
// is no shared global. Keychain + history + model discovery are app-level
// services shared by all windows.
export function useProvider(opts: {
  ws: Workspace;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
}) {
  const [provHist, setProvHist] = useState<ProviderEntry[]>(loadHist);
  const [provModels, setProvModels] = useState<string[]>([]);
  const [modelsNote, setModelsNote] = useState("");
  // OS keychain availability. null = unknown yet. When true, apiKeys live in
  // the keychain and localStorage copies are stripped; when false we persist
  // locally and say so (functional, less secure).
  const [keychainOk, setKeychainOk] = useState<boolean | null>(null);
  const keychainMigrated = useRef(false);

  const ws = opts.ws;
  const editCfg: ProviderConfig = ws.provider;
  // Track latest request to prevent race conditions from rapid switches
  const latestRequest = useRef<string>("");
  
  function setEditCfg(patch: Partial<ProviderConfig>) {
    opts.updateWs((w) => {
      const next = { ...w.provider, ...patch };
      // Keys belong to a baseUrl+model pair: switching either clears the
      // field; the keychain effect below refills it for the new pair.
      if (("baseUrl" in patch || "model" in patch) && !("apiKey" in patch)) {
        next.apiKey = "";
      }
      return { ...w, provider: next };
    });
    // Mirror to the keychain the moment the key is edited - not only after a
    // successful turn - so a restart never loses it.
    if (typeof patch.apiKey === "string") {
      const url = patch.baseUrl ?? ws.provider.baseUrl;
      const model = patch.model ?? ws.provider.model;
      const pair = draftPairKey(url, model);
      if (patch.apiKey === "") {
        // Explicit clear by the user: record intent (so the turn-end mirror
        // propagates the deletion) and strip the pair's key from history so
        // the removal sticks for reuse too.
        markPairCleared(pair);
        const kind = patch.kind ?? ws.provider.kind;
        setProvHist((h) => saveHist(stripHistoryKey(h, url, model, kind)));
      } else {
        unmarkPairCleared(pair);
      }
      if (url.trim() && model.trim()) {
        keySet(url, model, patch.apiKey)
          .then(() => setKeychainOk(true))
          .catch(() => setKeychainOk(false));
      }
    }
  }

  // Persist this window's draft on every keystroke so reloads never lose it.
  // Key backups are kept PER PAIR (not one slot): flipping between endpoints
  // must not wipe the key you typed five minutes ago. The live field is kept
  // locally only while no keychain is confirmed.
  const draftProvider = ws.provider;
  useEffect(() => {
    try {
      const all = loadDrafts();
      const prev = all[windowLabel];
      const keys: Record<string, string> = { ...(prev?.keys ?? {}) };
      const pair = draftPairKey(draftProvider.baseUrl, draftProvider.model);
      if (draftProvider.apiKey) {
        keys[pair] = draftProvider.apiKey;
      } else if (isPairCleared(pair)) {
        delete keys[pair];
      }
      all[windowLabel] = {
        baseUrl: draftProvider.baseUrl,
        model: draftProvider.model,
        kind: draftProvider.kind ?? "auto",
        // Keychain confirmed: never store the live key locally. Otherwise
        // keep the field, falling back to this pair's backup (unless the
        // user explicitly cleared it).
        apiKey: keychainOk
          ? ""
          : draftProvider.apiKey || (!isPairCleared(pair) ? (keys[pair] ?? "") : ""),
        keys,
      };
      saveDrafts(all);
    } catch {
      /* ignore */
    }
  }, [draftProvider, keychainOk]);

// Resolve the apiKey from the OS keychain whenever this window's
  // endpoint+model change (debounced). First success also migrates any
  // plaintext history keys.
  const baseUrl = ws.provider.baseUrl;
  const model = ws.provider.model;
  useEffect(() => {
    if (!baseUrl.trim() || !model.trim()) return;
    // Record this request to prevent race conditions from rapid switches
    latestRequest.current = `${baseUrl}|${model}`;

    const t = setTimeout(async () => {
      // Only proceed if this request is still the latest
      if (latestRequest.current !== `${baseUrl}|${model}`) return;

      try {
        const k = await keyGet(baseUrl, model);
        setKeychainOk(true);
        if (k) {
          opts.updateWs((w) => (w.provider.apiKey === k ? w : { ...w, provider: { ...w.provider, apiKey: k } }));
        }
        if (!keychainMigrated.current) {
          keychainMigrated.current = true;
          for (const h of loadHist()) {
            if (h.apiKey) {
              try {
                await keySet(h.baseUrl, h.model, h.apiKey);
              } catch {
                /* keep going */
              }
            }
          }
          // Strip plaintext keys from history now that they're migrated.
          setProvHist((h) => {
            const next = h.map((e) => ({ ...e, apiKey: "" }));
            saveHist(next);
            return next;
          });
        }
      } catch {
        setKeychainOk(false);
        // No keychain: restore this pair's locally-drafted key, if any.
        // Only restore if this is still the latest request
        if (latestRequest.current === `${baseUrl}|${model}`) {
          try {
            const k = lookupDraftKey(loadDrafts(), windowLabel, baseUrl, model);
            if (k) {
              opts.updateWs((w) =>
                w.provider.baseUrl === baseUrl && w.provider.model === model && !w.provider.apiKey
                  ? { ...w, provider: { ...w.provider, apiKey: k } }
                  : w,
              );
            }
          } catch {
            /* ignore */
          }
        }
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounced endpoint probe: deps intentionally limited to baseUrl/model so typing other fields doesn't refire discovery
  }, [baseUrl, model]);

  // "Correct" = the provider answered without throwing. Most-recent first.
  // Working keys are mirrored to the OS keychain; localStorage keeps them
  // only while no keychain is available.
  function rememberProvider(used: ProviderConfig) {
    if (!used.baseUrl.trim() || !used.model.trim()) return;
    const pair = draftPairKey(used.baseUrl, used.model);
    if (!used.apiKey) {
      // Empty key at turn end is ambiguous: user-cleared (propagate the
      // deletion, recorded as intent by setEditCfg) vs a stale copy from an
      // endpoint switch whose refill is still pending (touch NOTHING - a
      // blind mirror would delete the good key still in the keychain and
      // wipe the keyed history entry with it).
      if (isPairCleared(pair)) {
        unmarkPairCleared(pair);
        keySet(used.baseUrl, used.model, "")
          .then(() => setKeychainOk(true))
          .catch(() => setKeychainOk(false));
        setProvHist((h) => saveHist(stripHistoryKey(h, used.baseUrl, used.model, used.kind)));
      }
      return;
    }
    unmarkPairCleared(pair);
    keySet(used.baseUrl, used.model, used.apiKey)
      .then(() => setKeychainOk(true))
      .catch(() => setKeychainOk(false));
    const keepLocal = !keychainOk;
    setProvHist((h) =>
      saveHist([
        {
          baseUrl: used.baseUrl,
          model: used.model,
          apiKey: keepLocal ? used.apiKey : "",
          kind: used.kind ?? "auto",
        },
        ...h.filter(
          (e) =>
            !(
              e.baseUrl === used.baseUrl &&
              e.model === used.model &&
              (e.kind ?? "auto") === (used.kind ?? "auto")
            ),
        ),
      ]),
    );
  }

  // Ask the endpoint what models it actually serves - no more guessing names.
  async function refreshModels() {
    setModelsNote("loading…");
    try {
      const ids = await listModels(editCfg);
      setProvModels(ids);
      setModelsNote(ids.length ? `${ids.length} model${ids.length === 1 ? "" : "s"} found - pick from the model ▾` : "no models listed - check baseUrl");
    } catch (e) {
      setModelsNote(`models failed: ${e}`);
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
