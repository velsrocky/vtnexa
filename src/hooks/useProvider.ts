import { useEffect, useRef, useState } from "react";
import type { Lane, ProviderConfig } from "../types";
import { keyGet, keySet } from "../lib/tauri";
import { listModels } from "../lib/providers";
import { loadHist, saveHist, type ProviderEntry } from "../lib/providerHistory";

export type { ProviderEntry };

// Per-lane provider config: the bar always edits the ACTIVE lane's own
// copy - there is no shared global. Keychain + history + model discovery
// are app-level services shared by all lanes.
export function useProvider(opts: {
  lane: Lane;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
}) {
  const [provHist, setProvHist] = useState<ProviderEntry[]>(loadHist);
  const [provModels, setProvModels] = useState<string[]>([]);
  const [modelsNote, setModelsNote] = useState("");
  // OS keychain availability. null = unknown yet. When true, apiKeys live in
  // the keychain and localStorage copies are stripped; when false we persist
  // locally and say so (functional, less secure).
  const [keychainOk, setKeychainOk] = useState<boolean | null>(null);
  const keychainMigrated = useRef(false);

  const lane = opts.lane;
  const editCfg: ProviderConfig = lane.provider;
  function setEditCfg(patch: Partial<ProviderConfig>) {
    const base = lane.provider;
    opts.updateLane(lane.id, (l) => ({ ...l, provider: { ...base, ...patch } }));
  }

  // Resolve the apiKey from the OS keychain whenever the lane's
  // endpoint+model change (debounced). First success also migrates any
  // plaintext history keys.
  const baseUrl = lane.provider.baseUrl;
  const model = lane.provider.model;
  useEffect(() => {
    if (!baseUrl.trim() || !model.trim()) return;
    const t = setTimeout(async () => {
      try {
        const k = await keyGet(baseUrl, model);
        setKeychainOk(true);
        if (k) {
          opts.updateLane(lane.id, (l) =>
            l.provider.apiKey === k ? l : { ...l, provider: { ...l.provider, apiKey: k } },
          );
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
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane.id, baseUrl, model]);

  // "Correct" = the provider answered without throwing. Most-recent first.
  // Working keys are mirrored to the OS keychain; localStorage keeps them
  // only while no keychain is available.
  function rememberProvider(used: ProviderConfig) {
    if (!used.baseUrl.trim() || !used.model.trim()) return;
    // Always mirror to the keychain - an empty key now DELETES the stored
    // entry (backend treats "" as clear), so removing a key from the field
    // and chatting sticks the removal.
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
