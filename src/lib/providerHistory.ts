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

/** Seed for fresh windows: last working config, else the local default. */
export function loadLastUsed(): ProviderConfig {
  const [head] = loadHist();
  if (head) {
    return { baseUrl: head.baseUrl, model: head.model, apiKey: head.apiKey, kind: head.kind ?? "auto" };
  }
  return { ...DEFAULT_PROVIDER };
}
