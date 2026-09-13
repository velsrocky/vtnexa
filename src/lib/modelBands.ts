import { isWeakModel } from "./providers";

export type PromptTier = "weak" | "strong";

const KEY = "vtai.modelBands";
// Rolling window: only recent turns count, so a model that improves (or a
// prompt fix that lands) is forgiven instead of branded forever.
const WINDOW = 10;
// Demote fast (3 bad turns), promote slowly (8 clean turns). Trust is earned.
const DEMOTE_TURNS = 3;
const DEMOTE_AVG = 0.5;
const PROMOTE_TURNS = 8;
const PROMOTE_AVG = 0.25;

export function bandKey(baseUrl: string, model: string): string {
  return `${(baseUrl ?? "").trim()}|${(model ?? "").trim()}`;
}

function loadAll(): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof k !== "string" || !Array.isArray(v)) continue;
      const nums = v.filter((n): n is number => typeof n === "number" && isFinite(n) && n >= 0).slice(-WINDOW);
      if (nums.length) out[k] = nums;
    }
    return out;
  } catch {
    return {};
  }
}

function storeAll(all: Record<string, number[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore quota errors */
  }
}

/** Record one finished turn's repair count (0 when the turn needed no repair). */
export function recordTurnRepairs(baseUrl: string, model: string, repairs: number): void {
  const key = bandKey(baseUrl, model);
  if (key === "|") return;
  const r = Math.max(0, Math.min(99, Math.floor(repairs)));
  const all = loadAll();
  all[key] = [...(all[key] ?? []), r].slice(-WINDOW);
  storeAll(all);
}

/** Observed band from recent history, or null when evidence is thin. */
export function getBand(baseUrl: string, model: string): PromptTier | null {
  const recent = loadAll()[bandKey(baseUrl, model)] ?? [];
  if (recent.length >= DEMOTE_TURNS && avg(recent) >= DEMOTE_AVG) return "weak";
  if (recent.length >= PROMOTE_TURNS && avg(recent) < PROMOTE_AVG) return "strong";
  return null;
}

/**
 * Effective prompt tier: observed behavior overrides the name heuristic in
 * both directions once there is enough evidence, otherwise the heuristic
 * decides. No per-model prose anywhere - the band follows measurements.
 */
export function resolvePromptTier(baseUrl: string, model: string): PromptTier {
  const band = getBand(baseUrl, model);
  if (band) return band;
  return isWeakModel(baseUrl, model) ? "weak" : "strong";
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
