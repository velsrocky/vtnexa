// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadFeedback, rateMessage, ratingMap } from "./feedback";

afterEach(() => {
  localStorage.clear();
});

function rate(id: string, rating: 1 | -1 = 1) {
  return rateMessage({
    messageId: id,
    sessionId: "ses_1",
    model: "m",
    rating,
    prompt: "do x",
    answer: "did x",
  });
}

describe("feedback store", () => {
  it("starts empty and survives corrupt storage", () => {
    expect(loadFeedback()).toEqual([]);
    localStorage.setItem("vtai.feedback", "not json{{");
    expect(loadFeedback()).toEqual([]);
  });

  it("upserts by messageId (re-rating overwrites)", () => {
    rate("m1", 1);
    rate("m2", -1);
    rate("m1", -1);
    const list = loadFeedback();
    expect(list).toHaveLength(2);
    expect(ratingMap(list)).toEqual({ m1: -1, m2: -1 });
  });

  it("truncates long prompts/answers and caps the list", () => {
    rateMessage({
      messageId: "m1",
      sessionId: "s",
      model: "m",
      rating: 1,
      prompt: "p".repeat(1000),
      answer: "a".repeat(5000),
    });
    const [e] = loadFeedback();
    expect(e.prompt).toHaveLength(500);
    expect(e.answer).toHaveLength(2000);
    for (let i = 0; i < 210; i++) rate(`m${i}`);
    expect(loadFeedback().length).toBeLessThanOrEqual(200);
  });

  it("ignores empty message ids", () => {
    rateMessage({ messageId: "", sessionId: "s", model: "m", rating: 1, prompt: "", answer: "" });
    expect(loadFeedback()).toEqual([]);
  });
});
