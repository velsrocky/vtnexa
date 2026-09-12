import { useEffect, useRef, useState } from "react";
import type { ProviderConfig, Workspace } from "../types";
import { keyGet, keySet } from "../lib/tauri";
import { listModels } from "../lib/providers";
import { loadHist, saveHist, type ProviderEntry } from "../lib/providerHistory";

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
  function setEditCfg(patch: Partial<ProviderConfig>) {
    opts.updateWs((w) => ({ ...w, provider: { ...w.provider, ...patch } }));
  }

  // Resolve the apiKey from the OS keychain whenever this window's
  // endpoint+model change (debounced). First success also migrates any
  // plaintext history keys.
  const baseUrl = ws.provider.baseUrl;
  const model = ws.provider.model;
  useEffect(() => {
    if (!baseUrl.trim() || !model.trim()) return;
    const t = setTimeout(async () => {
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
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, model]);

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
