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
  markPairCleared,
  resetLegacyScrubForTests,
  saveDrafts,
  saveHist,
  takeLegacySecrets,
  unmarkPairCleared,
} from "./providerHistory";

afterEach(() => {
  localStorage.clear();
  clearPairMarks();
  resetLegacyScrubForTests();
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
  it("round-trips keyless configs, filters garbage and caps length", () => {
    expect(loadHist()).toEqual([]);
    const entries = Array.from({ length: 15 }, (_, i) => ({
      baseUrl: `https://x${i}.test`,
      model: "m",
    }));
    const saved = saveHist([...entries, null, { nope: 1 }] as never);
    expect(saved).toHaveLength(12);
    expect(loadHist()).toHaveLength(12);
    expect(loadHist()[0]).toEqual({ baseUrl: "https://x0.test", model: "m", kind: "auto" });
    localStorage.setItem("vtai.providerHistory", "not json{{");
    expect(loadHist()).toEqual([]);
  });

  it("never writes secrets, even if a caller passes legacy fields", () => {
    saveHist([{ baseUrl: "https://a.test", model: "m", apiKey: "SECRET" } as never]);
    const raw = localStorage.getItem("vtai.providerHistory") ?? "";
    expect(raw).not.toContain("SECRET");
    expect(loadHist()).toEqual([{ baseUrl: "https://a.test", model: "m", kind: "auto" }]);
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

describe("draft storage", () => {
  it("strips secrets from slots and only returns non-secret config", () => {
    saveDrafts({
      main: {
        baseUrl: "https://a.test",
        model: "m",
        apiKey: "SECRET",
        keys: { "https://a.test|m": "SECRET" },
      } as never,
    });
    const raw = localStorage.getItem("vtai.providerDraft") ?? "";
    expect(raw).not.toContain("SECRET");
    expect(loadDrafts()).toEqual({
      main: { baseUrl: "https://a.test", model: "m", kind: "auto" },
    });
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("vtai.providerDraft", "not json{{");
    expect(loadDrafts()).toEqual({});
  });
});

describe("legacy plaintext scrub", () => {
  it("ignores malformed slots and unusable pair keys while scrubbing", () => {
    localStorage.setItem("vtai.providerHistory", "not json{{");
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({
        nullSlot: null,
        bad: { baseUrl: 5, model: "m" },
        weird: {
          baseUrl: "https://w.test",
          model: "m",
          apiKey: "",
          keys: { "no-separator": "A", "|m": "B", "a|": "C", "https://ok.test|m": "D" },
        },
      }),
    );
    expect(takeLegacySecrets()).toEqual([
      { baseUrl: "https://ok.test", model: "m", secret: "D" },
    ]);
    expect(localStorage.getItem("vtai.providerDraft") ?? "").not.toContain('"D"');
    expect(loadDrafts().weird).toEqual({ baseUrl: "https://w.test", model: "m", kind: "auto" });
  });

  it("extracts history/draft secrets once, then rewrites both stores without them", () => {
    localStorage.setItem(
      "vtai.providerHistory",
      JSON.stringify([
        { baseUrl: "https://hist.test", model: "m", apiKey: "HIST-SECRET", kind: "auto" },
        { baseUrl: "https://hist.test", model: "m", apiKey: "HIST-DUP", kind: "auto" },
      ]),
    );
    localStorage.setItem(
      "vtai.providerDraft",
      JSON.stringify({
        main: {
          baseUrl: "https://draft.test",
          model: "m",
          apiKey: "DRAFT-SECRET",
          keys: { "https://pair.test|m": "PAIR-SECRET" },
        },
      }),
    );

    const secrets = takeLegacySecrets();
    expect(secrets).toEqual([
      { baseUrl: "https://hist.test", model: "m", secret: "HIST-SECRET" },
      { baseUrl: "https://draft.test", model: "m", secret: "DRAFT-SECRET" },
      { baseUrl: "https://pair.test", model: "m", secret: "PAIR-SECRET" },
    ]);
    for (const key of ["vtai.providerHistory", "vtai.providerDraft"]) {
      const raw = localStorage.getItem(key) ?? "";
      expect(raw).not.toContain("HIST-SECRET");
      expect(raw).not.toContain("HIST-DUP");
      expect(raw).not.toContain("DRAFT-SECRET");
      expect(raw).not.toContain("PAIR-SECRET");
    }
    expect(loadHist()[0]).toEqual({ baseUrl: "https://hist.test", model: "m", kind: "auto" });
    expect(loadDrafts().main).toEqual({ baseUrl: "https://draft.test", model: "m", kind: "auto" });
    expect(takeLegacySecrets()).toEqual([]);
  });
});

describe("loadLastUsed", () => {
  it("prefers history head, else the local default, and never seeds a key", () => {
    expect(loadLastUsed()).toMatchObject({ baseUrl: "http://localhost:11434/v1", apiKey: "" });
    saveHist([{ baseUrl: "https://a.test", model: "am", kind: "openai" }]);
    expect(loadLastUsed()).toMatchObject({ baseUrl: "https://a.test", model: "am", apiKey: "" });
  });
});
