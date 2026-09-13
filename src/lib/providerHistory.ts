import { DEFAULT_PROVIDER, type ProviderConfig, type ProviderKind } from "../types";

// Working provider history: every config that successfully answered once is
// kept (localStorage) for one-click reuse. Shared across windows as a
// convenience - like a browser remembering servers. Keys at rest are
// plaintext in the app data dir - same trust level as the workspace itself,
// not a vault.
export const HIST_KEY = "vtai.providerHistory";
// Per-window draft: keeps the CURRENT endpoint/model (and the key when no
// keychain exists) so a restart never loses freshly typed config.
export const DRAFT_KEY = "vtai.providerDraft";
const HIST_MAX = 12;

export interface ProviderEntry {
  baseUrl: string;
  model: string;
  apiKey: string;
  kind?: ProviderKind;
}

export function asKind(v: unknown): ProviderKind {
  return v === "openai" || v === "anthropic" || v === "gemini" ? v : "auto";
}

export function loadHist(): ProviderEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    if (Array.isArray(arr)) {
      return arr
        .filter((e) => e && typeof e.baseUrl === "string" && typeof e.model === "string")
        .map((e) => ({
          baseUrl: e.baseUrl,
          model: e.model,
          apiKey: typeof e.apiKey === "string" ? e.apiKey : "",
          kind: asKind(e.kind),
        }))
        .slice(0, HIST_MAX);
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveHist(next: ProviderEntry[]): ProviderEntry[] {
  const capped = next.slice(0, HIST_MAX);
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(capped));
  } catch {
    /* ignore */
  }
  return capped;
}

/** Pair key: API keys belong to a baseUrl+model pair, never to a window. */
export function draftPairKey(baseUrl: string, model: string): string {
  return `${baseUrl.trim()}|${model.trim()}`;
}

function pairMatches(baseUrl: string, model: string, kind: unknown, e: ProviderEntry): boolean {
  return e.baseUrl === baseUrl && e.model === model && (e.kind ?? "auto") === (kind ?? "auto");
}

/** Strip one pair's key from history entries (explicit removal) but keep keyless entries for reuse. Pure. */
export function stripHistoryKey(
  entries: ProviderEntry[],
  baseUrl: string,
  model: string,
  kind?: ProviderKind,
): ProviderEntry[] {
  return entries.map((e) => (pairMatches(baseUrl, model, kind, e) ? { ...e, apiKey: "" } : e));
}

// ---- Explicit-clear intent ----
// A turn-end mirror with an empty key is ambiguous: user-cleared (propagate
// the deletion) vs stale copy from an endpoint switch with a refill pending
// (touch nothing). The field edit records intent; the mirror consults it.
// Module-level: each Tauri window runs its own JS realm, so this is
// window-scoped by construction.
let clearedPair = "";
export function markPairCleared(pair: string): void {
  clearedPair = pair;
}
export function unmarkPairCleared(pair: string): void {
  if (clearedPair === pair) clearedPair = "";
}
export function isPairCleared(pair: string): boolean {
  return !!pair && clearedPair === pair;
}
export function clearPairMarks(): void {
  clearedPair = "";
}

// ---- Per-pair local key backups ----
// Single-slot drafts lose keys when the user flips between endpoints (each
// switch overwrites the only copy). Backups are keyed by pair and survive
// switching; explicit clears purge the pair. Only ever written while no
// keychain is confirmed - and read only as a fallback when it fails.
export interface DraftSlot {
  baseUrl: string;
  model: string;
  kind?: ProviderKind;
  apiKey: string;
  keys?: Record<string, string>;
}

const DRAFT_KEYS_MAX = 20;

function capKeys(keys: Record<string, string>): Record<string, string> {
  const entries = Object.entries(keys).filter(
    ([k, v]) => typeof k === "string" && typeof v === "string" && v,
  );
  return Object.fromEntries(entries.slice(-DRAFT_KEYS_MAX));
}

export function loadDrafts(): Record<string, DraftSlot> {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, DraftSlot> = {};
    for (const [label, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      if (typeof o.baseUrl !== "string" || typeof o.model !== "string") continue;
      const keys: Record<string, string> =
        o.keys && typeof o.keys === "object" && !Array.isArray(o.keys)
          ? Object.fromEntries(
              Object.entries(o.keys as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[0] === "string" && typeof e[1] === "string",
              ),
            )
          : {};
      // v1 migration: slots without a keys dict seed it from their apiKey.
      if (!o.keys && typeof o.apiKey === "string" && o.apiKey && o.baseUrl && o.model) {
        keys[draftPairKey(o.baseUrl, o.model)] = o.apiKey;
      }
      out[label] = {
        baseUrl: o.baseUrl,
        model: o.model,
        kind: asKind(o.kind),
        apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
        keys: capKeys(keys),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDrafts(all: Record<string, DraftSlot>): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Local backup lookup for one pair (caller decides fallback policy). */
export function lookupDraftKey(
  all: Record<string, DraftSlot>,
  windowLabel: string,
  baseUrl: string,
  model: string,
): string {
  const slot = all[windowLabel];
  if (!slot) return "";
  const pair = draftPairKey(baseUrl, model);
  if (isPairCleared(pair)) return "";
  return slot.keys?.[pair] ?? "";
}

/** Seed for fresh windows: last working config, else the local default. */
export function loadLastUsed(): ProviderConfig {
  const [head] = loadHist();
  if (head) {
    return { baseUrl: head.baseUrl, model: head.model, apiKey: head.apiKey, kind: head.kind ?? "auto" };
  }
  return { ...DEFAULT_PROVIDER };
}
