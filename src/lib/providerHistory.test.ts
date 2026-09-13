// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  asKind,
  clearPairMarks,
  draftPairKey,
  isPairCleared,
  loadDrafts,
  loadHist,
  loadLastUsed,
  lookupDraftKey,
  markPairCleared,
  saveDrafts,
  saveHist,
  stripHistoryKey,
  unmarkPairCleared,
} from "./providerHistory";

afterEach(() => {
  localStorage.clear();
  clearPairMarks();
});

describe("asKind", () => {
  it("allows known backends, auto otherwise", () => {
    expect(asKind("openai")).toBe("openai");
    expect(asKind("gemini")).toBe("gemini");
    expect(asKind("bogus")).toBe("auto");
    expect(asKind(undefined)).toBe("auto");
  });
});

describe("loadHist / saveHist", () => {
  it("round-trips, filters garbage and caps length", () => {
    expect(loadHist()).toEqual([]);
    const entries = Array.from({ length: 15 }, (_, i) => ({
      baseUrl: `https://x${i}.test`,
      model: "m",
      apiKey: "",
    }));
    const saved = saveHist([...entries, null, { nope: 1 }] as any);
    expect(saved).toHaveLength(12);
    expect(loadHist()).toHaveLength(12);
    expect(loadHist()[0].baseUrl).toBe("https://x0.test");
    localStorage.setItem("vtai.providerHistory", "not json{{");
    expect(loadHist()).toEqual([]);
  });
});

describe("clear-intent marks", () => {
  it("tracks explicit clears per pair", () => {
    const pair = draftPairKey("https://a.test", "m");
    expect(isPairCleared(pair)).toBe(false);
    markPairCleared(pair);
    expect(isPairCleared(pair)).toBe(true);
    expect(isPairCleared(draftPairKey("https://a.test", "other"))).toBe(false);
    unmarkPairCleared(pair);
    expect(isPairCleared(pair)).toBe(false);
  });
});

describe("stripHistoryKey", () => {
  it("clears the pair's key but keeps the entry for reuse", () => {
    const entries = [
      { baseUrl: "https://a.test", model: "m", apiKey: "K", kind: "auto" as const },
      { baseUrl: "https://b.test", model: "m", apiKey: "K2", kind: "auto" as const },
    ];
    const next = stripHistoryKey(entries, "https://a.test", "m", "auto");
    expect(next).toEqual([
      { baseUrl: "https://a.test", model: "m", apiKey: "", kind: "auto" },
      { baseUrl: "https://b.test", model: "m", apiKey: "K2", kind: "auto" },
    ]);
  });
});

describe("draft backups", () => {
  it("migrates v1 slots into per-pair keys", () => {
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({ main: { baseUrl: "https://a.test", model: "m", kind: "auto", apiKey: "OLD" } }),
    );
    const all = loadDrafts();
    expect(all.main.keys).toEqual({ "https://a.test|m": "OLD" });
    expect(lookupDraftKey(all, "main", "https://a.test", "m")).toBe("OLD");
  });

  it("looks up per-pair keys and honors clear intent", () => {
    saveDrafts({
      main: {
        baseUrl: "https://b.test",
        model: "m",
        apiKey: "",
        keys: { "https://a.test|m": "K-A", "https://b.test|m": "K-B" },
      },
    });
    const all = loadDrafts();
    // Current pair differs from the lookup pair: keys dict still answers.
    expect(lookupDraftKey(all, "main", "https://a.test", "m")).toBe("K-A");
    expect(lookupDraftKey(all, "main", "https://missing.test", "m")).toBe("");
    expect(lookupDraftKey(all, "other-window", "https://a.test", "m")).toBe("");
    markPairCleared("https://a.test|m");
    expect(lookupDraftKey(all, "main", "https://a.test", "m")).toBe("");
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("vtai.providerDraft", "not json{{");
    expect(loadDrafts()).toEqual({});
    expect(lookupDraftKey({}, "main", "https://a.test", "m")).toBe("");
  });
});

describe("loadLastUsed", () => {
  it("prefers history head, else the local default", () => {
    expect(loadLastUsed()).toMatchObject({ baseUrl: "http://localhost:11434/v1" });
    saveHist([{ baseUrl: "https://a.test", model: "am", apiKey: "K", kind: "openai" }]);
    expect(loadLastUsed()).toMatchObject({ baseUrl: "https://a.test", model: "am", apiKey: "K" });
  });
});
