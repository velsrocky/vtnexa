// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getBand, recordTurnRepairs, resolvePromptTier } from "./modelBands";

const WEAK_URL = "https://band-weak.test/v1";
const WEAK_MODEL = "band-weak-model";
const STRONG_URL = "https://band-strong.test/v1";
const STRONG_MODEL = "band-strong-model";

beforeEach(() => {
  localStorage.clear();
});

describe("getBand", () => {
  it("returns null without evidence", () => {
    expect(getBand(WEAK_URL, WEAK_MODEL)).toBeNull();
    recordTurnRepairs(WEAK_URL, WEAK_MODEL, 2);
    recordTurnRepairs(WEAK_URL, WEAK_MODEL, 2);
    expect(getBand(WEAK_URL, WEAK_MODEL)).toBeNull();
  });

  it("demotes fast on repeated repairs", () => {
    for (let i = 0; i < 3; i++) recordTurnRepairs(STRONG_URL, STRONG_MODEL, 1);
    expect(getBand(STRONG_URL, STRONG_MODEL)).toBe("weak");
  });

  it("promotes slowly on clean runs", () => {
    for (let i = 0; i < 7; i++) recordTurnRepairs(STRONG_URL, STRONG_MODEL, 0);
    expect(getBand(STRONG_URL, STRONG_MODEL)).toBeNull();
    recordTurnRepairs(STRONG_URL, STRONG_MODEL, 0);
    expect(getBand(STRONG_URL, STRONG_MODEL)).toBe("strong");
  });

  it("forgives old repairs via the rolling window", () => {
    for (let i = 0; i < 3; i++) recordTurnRepairs(STRONG_URL, STRONG_MODEL, 2);
    expect(getBand(STRONG_URL, STRONG_MODEL)).toBe("weak");
    for (let i = 0; i < 10; i++) recordTurnRepairs(STRONG_URL, STRONG_MODEL, 0);
    expect(getBand(STRONG_URL, STRONG_MODEL)).toBe("strong");
  });

  it("survives corrupt storage and empty keys", () => {
    localStorage.setItem("vtai.modelBands", "not json{{");
    expect(getBand(WEAK_URL, WEAK_MODEL)).toBeNull();
    expect(() => recordTurnRepairs("", "", 1)).not.toThrow();
    expect(getBand("", "")).toBeNull();
  });
});

describe("resolvePromptTier", () => {
  it("uses the heuristic without evidence", () => {
    expect(resolvePromptTier("http://localhost:11434/v1", "qwen2.5-coder:7b")).toBe("weak");
    expect(resolvePromptTier("https://api.openai.com/v1", "gpt-4o")).toBe("strong");
  });

  it("lets observed behavior override the heuristic both ways", () => {
    // Unknown strong-looking model that keeps needing repairs -> compact.
    for (let i = 0; i < 3; i++) recordTurnRepairs(STRONG_URL, "mystery-model-9", 2);
    expect(resolvePromptTier(STRONG_URL, "mystery-model-9")).toBe("weak");
    // Heuristic-weak model with a long clean streak -> full prompt.
    const localUrl = "http://localhost:11434/v1";
    for (let i = 0; i < 8; i++) recordTurnRepairs(localUrl, "bandmodel:7b", 0);
    expect(resolvePromptTier(localUrl, "bandmodel:7b")).toBe("strong");
  });
});
