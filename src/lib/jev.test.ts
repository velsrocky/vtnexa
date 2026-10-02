import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JEV_GATEWAY_URL,
  JEV_INPUT_BUDGET_TOKENS,
  JevError,
  askJev,
  buildReviewState,
  estimateJevInputTokens,
  formatJevSummary,
  resolveJevApiKey,
  validateJevRequest,
  type JevQuestions,
  type JevResponse,
} from "./jev";

const KEY = "test-experiential-key";

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  );
  return calls;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REVIEW_Q: JevQuestions = {
  review: {
    type: "choice",
    instructions: "Should this diff be accepted or reviewed?",
    criteria: {
      accept: "Safe, small, tested change",
      review: "Needs human review",
    },
  },
  risky: {
    type: "noul",
    instructions: "Does the diff introduce an unreviewed risk?",
    criteria: { true: "Unreviewed risk present", false: "No new risk" },
  },
  quality: {
    type: "score",
    instructions: "Rate the change quality",
    criteria: ["Poor", "Acceptable", "Excellent"],
  },
};

const REVIEW_RES: JevResponse = {
  model: "jev-1.13.0",
  answers: {
    review: { type: "choice", choice: "review", probabilities: { accept: 0.2, review: 0.8 }, confidence: 0.6 },
    risky: { type: "noul", noul: 0.7 },
    quality: {
      type: "score",
      score: 1.2,
      legend: { "0": "Poor", "1": "Acceptable", "2": "Excellent" },
      probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
      confidence: 0.5,
    },
  },
  usage: { input_tokens: 392, output_tokens: 65 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveJevApiKey", () => {
  it("prefers an explicit key and never logs it", () => {
    expect(resolveJevApiKey(KEY)).toBe(KEY);
  });
  it("stops with missing-key when the env is unset", () => {
    vi.stubGlobal("process", { env: {} });
    expect(() => resolveJevApiKey()).toThrowError(JevError);
    try {
      resolveJevApiKey();
    } catch (e) {
      expect((e as JevError).kind).toBe("missing-key");
      // Guidance: set locally; never asks to paste or log the value.
      expect((e as Error).message).toMatch(/EXPERIENTIAL_API_KEY is not set/);
      expect((e as Error).message).not.toMatch(/Bearer/);
    }
  });
});

describe("validateJevRequest", () => {
  it("accepts a well-formed choice/noul/score batch", () => {
    expect(() => validateJevRequest({ diff: "x" }, REVIEW_Q, "jev-latest")).not.toThrow();
  });
  it("preserves the :free spelling instead of normalizing it", () => {
    expect(() => validateJevRequest("state", REVIEW_Q, "jev-latest:free")).not.toThrow();
  });
  it("rejects non-Jev chat models (coding agent keeps its chat model)", () => {
    expect(() => validateJevRequest("s", REVIEW_Q, "gpt-4o")).toThrowError(/jev-latest/);
  });
  it("enforces at most 32 questions per request", () => {
    const many: JevQuestions = {};
    for (let i = 0; i < 33; i++) many[`q${i}`] = { type: "noul", instructions: `Judge ${i}?` };
    expect(() => validateJevRequest("s", many)).toThrowError(/32/);
  });
  it("enforces at most 64 options per choice", () => {
    const criteria: Record<string, string> = {};
    for (let i = 0; i < 65; i++) criteria[`opt${i}`] = `Option ${i}`;
    expect(() =>
      validateJevRequest("s", { c: { type: "choice", instructions: "Pick one", criteria } }),
    ).toThrowError(/64/);
  });
  it.each([[1], [11]])("enforces 2-10 levels per score (got %i)", (n) => {
    const criteria = Array.from({ length: n }, (_, i) => `Level ${i}`);
    expect(() =>
      validateJevRequest("s", { s: { type: "score", instructions: "Rate it", criteria } }),
    ).toThrowError(/2-10/);
  });
  it("rejects empty state (send a concise diff + tests, not the repo)", () => {
    expect(() => validateJevRequest("", REVIEW_Q)).toThrowError(/state/);
  });
});

describe("askJev (mocked transport)", () => {
  it("POSTs once to the gateway only, with model jev-latest exactly", async () => {
    const calls = stubFetch((url, init) => {
      expect(url).toBe(JEV_GATEWAY_URL);
      expect(url).not.toMatch(/api\.typesafe\.ai/);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      // No automatic retries / idempotency / streaming facade.
      expect(headers["Idempotency-Key"]).toBeUndefined();
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("jev-latest");
      expect(body.state).toBeDefined();
      expect(body.questions.review.type).toBe("choice");
      expect(body.stream).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return json(REVIEW_RES);
    });
    const res = await askJev({ diff: "d", tests: "t" }, REVIEW_Q, { apiKey: KEY });
    expect(calls).toHaveLength(1);
    // Answers read by question ID, usage reported.
    expect(res.answers.review).toMatchObject({ type: "choice", choice: "review" });
    expect(res.answers.risky).toMatchObject({ type: "noul" });
    expect(res.usage).toMatchObject({ input_tokens: 392, output_tokens: 65 });
  });

  it("never sends when the key is missing (no fetch, missing-key error)", async () => {
    vi.stubGlobal("process", { env: {} });
    const calls = stubFetch(() => json(REVIEW_RES));
    await expect(askJev("s", REVIEW_Q)).rejects.toMatchObject({ kind: "missing-key" });
    expect(calls).toHaveLength(0);
  });

  it("does not retry charged outcomes: 429 surfaces after exactly one call", async () => {
    const calls = stubFetch(() => new Response("rate limited", { status: 429 }));
    await expect(askJev("s", REVIEW_Q, { apiKey: KEY })).rejects.toMatchObject({ kind: "http", status: 429 });
    expect(calls).toHaveLength(1);
  });

  it("surfaces HTTP errors with status (401/422)", async () => {
    stubFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(askJev("s", REVIEW_Q, { apiKey: KEY })).rejects.toMatchObject({ kind: "http", status: 401 });
    stubFetch(() => new Response("bad question", { status: 422 }));
    await expect(askJev("s", REVIEW_Q, { apiKey: KEY })).rejects.toMatchObject({ kind: "http", status: 422 });
  });

  it("surfaces transport errors without retrying", async () => {
    const calls = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(askJev("s", REVIEW_Q, { apiKey: KEY })).rejects.toMatchObject({ kind: "transport" });
    expect(calls).toHaveLength(1);
  });

  it("uses a bounded timeout (aborted fetch reads as timeout)", async () => {
    stubFetch((_url, init) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Jev request timed out", "TimeoutError")));
      });
    });
    await expect(askJev("s", REVIEW_Q, { apiKey: KEY, timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("review helpers", () => {
  it("builds a concise state (capped diff + tests, not the repo)", () => {
    const state = buildReviewState(`x`.repeat(20_000), `y`.repeat(8_000));
    expect(state.diff.length).toBeLessThan(20_000);
    expect(state.tests.length).toBeLessThan(8_000);
    expect(state.diff).toMatch(/truncated/);
  });
  it("estimates shared input against the ~32k budget constant", () => {
    expect(JEV_INPUT_BUDGET_TOKENS).toBe(32_000);
    expect(estimateJevInputTokens({ diff: "abc" }, REVIEW_Q)).toBeGreaterThan(0);
  });
  it("formats decisions by ID plus reported usage, with a no-auto-action note", () => {
    const out = formatJevSummary(REVIEW_RES);
    expect(out).toMatch(/review: choice="review"/);
    expect(out).toMatch(/risky: noul=0\.7/);
    expect(out).toMatch(/quality: score=1\.2/);
    expect(out).toMatch(/input_tokens=392/);
    expect(out).toMatch(/not guarantees of correctness/);
    expect(out).toMatch(/No choice was executed/);
  });
});
