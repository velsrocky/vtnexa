import { DEFAULT_PROVIDER, type ProviderConfig, type ProviderKind } from "../types";

// Working provider history: every config that successfully answered once is
// kept (localStorage) for one-click reuse. Shared across windows as a
// convenience - like a browser remembering servers.
//
// SECURITY: this store is deliberately secret-free. API keys live in the OS
// keychain, or in memory for the current session when no keychain exists.
// `saveHist`/`saveDrafts` strip secrets defensively, and `takeLegacySecrets`
// scrubs plaintext keys left by older builds on first use.
export const HIST_KEY = "vtai.providerHistory";
// Per-window draft: keeps the CURRENT endpoint/model so a restart never loses
// freshly typed config. Never the key.
export const DRAFT_KEY = "vtai.providerDraft";
const HIST_MAX = 12;

/** Non-secret provider config. Intentionally has no `apiKey` field. */
export interface ProviderEntry {
  baseUrl: string;
  model: string;
  kind?: ProviderKind;
}

/** Non-secret per-window draft. Intentionally has no key material. */
export interface DraftSlot {
  baseUrl: string;
  model: string;
  kind?: ProviderKind;
}

/** A plaintext secret found in storage written by an older build. */
export interface LegacySecret {
  baseUrl: string;
  model: string;
  secret: string;
}

export function asKind(v: unknown): ProviderKind {
  return v === "openai" || v === "anthropic" || v === "gemini" || v === "ollama" ? v : "auto";
}

function sanitizeEntry(value: ProviderEntry): ProviderEntry {
  return {
    baseUrl: value.baseUrl,
    model: value.model,
    kind: asKind(value.kind),
  };
}

function sanitizeDraft(value: DraftSlot): DraftSlot {
  return {
    baseUrl: value.baseUrl,
    model: value.model,
    kind: asKind(value.kind),
  };
}

export function loadHist(): ProviderEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    if (Array.isArray(arr)) {
      return arr
        .filter((e) => e && typeof e.baseUrl === "string" && typeof e.model === "string")
        .map((e) => sanitizeEntry(e as ProviderEntry))
        .slice(0, HIST_MAX);
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveHist(next: ProviderEntry[]): ProviderEntry[] {
  const capped = next
    .filter((e) => e && typeof e.baseUrl === "string" && typeof e.model === "string")
    .slice(0, HIST_MAX)
    .map(sanitizeEntry);
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

// ---- Explicit-clear intent ----
// A turn-end mirror with an empty key is ambiguous: user-cleared (propagate
// the deletion into the keychain) vs stale copy from an endpoint switch with
// a refill pending (touch nothing). The field edit records intent; the mirror
// consults it. Module-level: each Tauri window runs its own JS realm, so this
// is window-scoped by construction.
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

export function loadDrafts(): Record<string, DraftSlot> {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, DraftSlot> = {};
    for (const [label, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      if (typeof o.baseUrl !== "string" || typeof o.model !== "string") continue;
      out[label] = sanitizeDraft({
        baseUrl: o.baseUrl,
        model: o.model,
        kind: asKind(o.kind),
      });
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDrafts(all: Record<string, DraftSlot>): void {
  const sanitized: Record<string, DraftSlot> = {};
  for (const [label, slot] of Object.entries(all)) {
    if (!slot || typeof slot.baseUrl !== "string" || typeof slot.model !== "string") continue;
    sanitized[label] = sanitizeDraft(slot);
  }
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(sanitized));
  } catch {
    /* ignore */
  }
}

// ---- One-time legacy plaintext scrub ----
// Builds before the secret-free store kept keys in history/drafts. Read those
// keys once, then immediately rewrite both stores without them. The caller may
// migrate the returned secrets to the OS keychain; if that fails they remain
// in memory for this session only.
let legacyScrubbed = false;

export function takeLegacySecrets(): LegacySecret[] {
  if (legacyScrubbed) return [];
  legacyScrubbed = true;

  const found = new Map<string, LegacySecret>();
  const add = (baseUrl: unknown, model: unknown, secret: unknown) => {
    if (typeof baseUrl !== "string" || typeof model !== "string") return;
    if (typeof secret !== "string" || !secret) return;
    if (!baseUrl.trim() || !model.trim()) return;
    const pair = draftPairKey(baseUrl, model);
    if (!found.has(pair)) found.set(pair, { baseUrl, model, secret });
  };

  try {
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    if (Array.isArray(hist)) {
      for (const entry of hist) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        add(e.baseUrl, e.model, e.apiKey);
      }
    }
  } catch {
    /* ignore corrupt history */
  }

  try {
    const drafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    if (drafts && typeof drafts === "object" && !Array.isArray(drafts)) {
      for (const slot of Object.values(drafts as Record<string, unknown>)) {
        if (!slot || typeof slot !== "object" || Array.isArray(slot)) continue;
        const s = slot as Record<string, unknown>;
        add(s.baseUrl, s.model, s.apiKey);
        if (s.keys && typeof s.keys === "object" && !Array.isArray(s.keys)) {
          for (const [pair, secret] of Object.entries(s.keys as Record<string, unknown>)) {
            const separator = pair.lastIndexOf("|");
            if (separator <= 0 || separator >= pair.length - 1) continue;
            add(pair.slice(0, separator), pair.slice(separator + 1), secret);
          }
        }
      }
    }
  } catch {
    /* ignore corrupt drafts */
  }

  // Scrub even if keychain migration never runs (missing daemon, crash, etc.).
  saveHist(loadHist());
  saveDrafts(loadDrafts());

  return [...found.values()];
}

/** Test seam: allow a later test to observe the one-time scrub again. */
export function resetLegacyScrubForTests(): void {
  legacyScrubbed = false;
}

/** Seed for fresh windows: last working config without any secret. */
export function loadLastUsed(): ProviderConfig {
  const [head] = loadHist();
  if (head) {
    return { baseUrl: head.baseUrl, model: head.model, apiKey: "", kind: head.kind ?? "auto" };
  }
  return { ...DEFAULT_PROVIDER };
}
