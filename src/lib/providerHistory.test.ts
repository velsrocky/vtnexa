// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { asKind, loadHist, loadLastUsed, saveHist } from "./providerHistory";

afterEach(() => {
  localStorage.clear();
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

describe("loadLastUsed", () => {
  it("prefers history head, else the local default", () => {
    expect(loadLastUsed()).toMatchObject({ baseUrl: "http://localhost:11434/v1" });
    saveHist([{ baseUrl: "https://a.test", model: "am", apiKey: "K", kind: "openai" }]);
    expect(loadLastUsed()).toMatchObject({ baseUrl: "https://a.test", model: "am", apiKey: "K" });
  });
});
