/**
 * Jev (TypeSafe System One) decision helper.
 *
 * Jev is NOT a chat/code-completion model: it takes a `state` plus a map of
 * typed `questions` and returns structured `answers` keyed by question ID.
 * The coding agent keeps its current chat model; call this helper only when
 * code needs a fast, calibrated, structured decision (routing, scoring,
 * yes/no checks, guardrails).
 *
 * Gateway override (this integration only):
 * - POST only to https://api.experientiallabs.ai/v1/systemone
 * - Bearer key read ONLY from EXPERIENTIAL_API_KEY (never logged, never
 *   requested as a TypeSafe key, never sent anywhere else).
 * - Model sent as "jev-latest" exactly (a caller-selected ":free" spelling
 *   such as "jev-latest:free" is preserved verbatim, never normalized).
 *
 * Request reference: https://docs.typesafe.ai/introduction/quickstart
 * Input-budget source: https://docs.typesafe.ai/primitives
 *
 * Safety contract:
 * - Bounded timeout, single attempt, no automatic retries, no Idempotency-Key
 *   (an unknown outcome may already be charged).
 * - No streaming and no Chat Completions / Responses / Messages facade.
 * - Answers are advisory: probabilities and confidence are NOT guarantees of
 *   correctness. Never execute a returned choice, merge a change, or bypass
 *   review automatically — always show the decision + usage to the user.
 */

/** Gateway endpoint. All Jev traffic goes here and nowhere else. */
export const JEV_GATEWAY_URL = "https://api.experientiallabs.ai/v1/systemone";

/** Default model string, sent exactly. */
export const JEV_MODEL = "jev-latest";

/** Alternate spelling the gateway may offer; preserved verbatim when selected. */
export const JEV_MODEL_FREE = "jev-latest:free";

/** Name of the only environment variable the Bearer key is read from. */
export const JEV_API_KEY_ENV = "EXPERIENTIAL_API_KEY";

/**
 * Approximate shared input budget (tokens) for state + all question
 * definitions in one request. This is NOT a total context window and NOT an
 * output limit. Keep state to a concise diff + test summary, never the
 * entire repository. Estimate with {@link estimateJevInputTokens}.
 */
export const JEV_INPUT_BUDGET_TOKENS = 32_000;

/** Platform admission bounds (not provider limits). */
export const JEV_MAX_QUESTIONS = 32;
export const JEV_MAX_CHOICE_OPTIONS = 64;
export const JEV_MIN_SCORE_LEVELS = 2;
export const JEV_MAX_SCORE_LEVELS = 10;

/** Bounded transport timeout default (ms). Single attempt, no retries. */
export const JEV_DEFAULT_TIMEOUT_MS = 30_000;

/** Structured values accepted for state, instructions, and criteria fields. */
export type JevStructured = string | Record<string, unknown> | unknown[];

/** State under judgment: text, object, or array. */
export type JevState = JevStructured;

/** One option description in a Choice question (null = no extra detail). */
export type JevChoiceOption = string | Record<string, unknown> | unknown[] | null;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevStructured;
  /** Maps each option (e.g. accept/review) to its description. */
  criteria: Record<string, JevChoiceOption>;
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: JevStructured;
  /** Optional clarification of what yes (true) and no (false) mean. */
  criteria?: {
    true?: string | Record<string, unknown> | unknown[];
    false?: string | Record<string, unknown> | unknown[];
  };
}

export type JevScoreLevel = string | Record<string, unknown> | unknown[];

export interface JevScoreQuestion {
  type: "score";
  instructions: JevStructured;
  /** Ordered list of level descriptions (low → high). */
  criteria: JevScoreLevel[];
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

/** Map keyed by caller-chosen question IDs; answers return under the same IDs. */
export type JevQuestions = Record<string, JevQuestion>;

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

export type JevErrorKind = "missing-key" | "validation" | "http" | "transport" | "timeout" | "parse";

/** Typed Jev failure. The Bearer key value is never included in any message. */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;

  constructor(kind: JevErrorKind, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStructured(value: unknown): value is JevStructured {
  return typeof value === "string" || Array.isArray(value) || isRecord(value);
}

function structuredSize(value: JevStructured): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

/**
 * Resolve the Bearer key. Reads ONLY from EXPERIENTIAL_API_KEY (explicit
 * argument wins, otherwise the local environment). Throws a `missing-key`
 * JevError when unset — the caller must set it locally. Never asks for the
 * value, never logs it.
 */
export function resolveJevApiKey(explicit?: string): string {
  if (explicit !== undefined && explicit !== null && String(explicit).length > 0) {
    return String(explicit);
  }
  let fromEnv: unknown;
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    fromEnv = proc?.env?.[JEV_API_KEY_ENV];
  } catch {
    fromEnv = undefined;
  }
  if (typeof fromEnv !== "string" || fromEnv.length === 0) {
    try {
      const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
      const viteVal = viteEnv?.[JEV_API_KEY_ENV];
      if (typeof viteVal === "string" && viteVal.length > 0) fromEnv = viteVal;
    } catch {
      /* import.meta unavailable (non-Vite runtime) — fall through to the error */
    }
  }
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  throw new JevError(
    "missing-key",
    `${JEV_API_KEY_ENV} is not set locally. Set it in your shell environment and retry — do not paste the key into chat, logs, or source. No request was sent.`,
  );
}

/** True for the only model strings this helper sends (preserves :free). */
export function isJevModel(model: string): boolean {
  return model === JEV_MODEL || model === JEV_MODEL_FREE;
}

/**
 * Validate a Jev request against the gateway admission bounds before any
 * network I/O (so a malformed request is never charged). Throws a
 * `validation` JevError describing the offending field.
 */
export function validateJevRequest(state: JevState, questions: JevQuestions, model: string = JEV_MODEL): void {
  if (!isJevModel(model)) {
    throw new JevError(
      "validation",
      `model must be "${JEV_MODEL}" exactly ("${JEV_MODEL_FREE}" also accepted verbatim); got ${JSON.stringify(model)}. Jev is a decision helper, not a chat-model replacement — keep the coding agent on its current chat model.`,
    );
  }
  if (!isStructured(state) || !structuredSize(state)) {
    throw new JevError(
      "validation",
      "state must be a non-empty string, object, or array. Send a concise diff + test summary, not the entire repository.",
    );
  }
  if (!isRecord(questions as unknown)) {
    throw new JevError("validation", "questions must be a map keyed by question ID.");
  }
  const ids = Object.keys(questions);
  if (ids.length < 1) throw new JevError("validation", "questions must contain at least one question.");
  if (ids.length > JEV_MAX_QUESTIONS) {
    throw new JevError(
      "validation",
      `at most ${JEV_MAX_QUESTIONS} questions per request (gateway admission bound); got ${ids.length}. Split independent questions across requests — an answer is never fed into another question in the same request.`,
    );
  }
  for (const id of ids) {
    if (!id) throw new JevError("validation", "question IDs must be non-empty strings.");
    const q = (questions as Record<string, unknown>)[id] as Partial<JevQuestion> | null | undefined;
    if (!q || typeof q !== "object") throw new JevError("validation", `question "${id}" must be an object with type + instructions.`);
    if (q.type !== "choice" && q.type !== "noul" && q.type !== "score") {
      throw new JevError("validation", `question "${id}".type must be "choice", "noul", or "score".`);
    }
    const instructions = q.instructions as unknown;
    if (!isStructured(instructions) || !structuredSize(instructions)) {
      throw new JevError(
        "validation",
        `question "${id}".instructions must be a non-empty string, object, or array describing the judgment.`,
      );
    }
    if (q.type === "choice") {
      const criteria = (q as JevChoiceQuestion).criteria;
      if (!isRecord(criteria)) {
        throw new JevError(
          "validation",
          `question "${id}" (choice) needs criteria: a map of option → description (e.g. accept/review).`,
        );
      }
      const options = Object.keys(criteria);
      if (options.length < 2) {
        throw new JevError("validation", `question "${id}" (choice) needs at least 2 options; got ${options.length}.`);
      }
      if (options.length > JEV_MAX_CHOICE_OPTIONS) {
        throw new JevError(
          "validation",
          `question "${id}" (choice) allows at most ${JEV_MAX_CHOICE_OPTIONS} options per request (gateway admission bound); got ${options.length}.`,
        );
      }
    }
    if (q.type === "noul") {
      const criteria = (q as JevNoulQuestion).criteria;
      if (criteria !== undefined) {
        if (!isRecord(criteria)) {
          throw new JevError(
            "validation",
            `question "${id}" (noul) criteria, when present, must describe true/false (e.g. { true: "...", false: "..." }).`,
          );
        }
        for (const side of ["true", "false"] as const) {
          const v = (criteria as Record<string, unknown>)[side];
          if (v !== undefined && !isStructured(v as unknown)) {
            throw new JevError("validation", `question "${id}" (noul) criteria.${side} must be a string, object, or array.`);
          }
        }
      }
    }
    if (q.type === "score") {
      const criteria = (q as JevScoreQuestion).criteria;
      if (!Array.isArray(criteria)) {
        throw new JevError(
          "validation",
          `question "${id}" (score) needs criteria: an ordered list of level descriptions (low → high).`,
        );
      }
      if (criteria.length < JEV_MIN_SCORE_LEVELS || criteria.length > JEV_MAX_SCORE_LEVELS) {
        throw new JevError(
          "validation",
          `question "${id}" (score) needs ${JEV_MIN_SCORE_LEVELS}-${JEV_MAX_SCORE_LEVELS} levels (gateway admission bound); got ${criteria.length}.`,
        );
      }
    }
  }
}

/**
 * Rough shared-input estimate (chars ÷ 4) over state + all question
 * definitions. Approximate only — the gateway counts the true tokens (~32k
 * shared budget). Use to keep requests small before a charged call.
 */
export function estimateJevInputTokens(state: JevState, questions: JevQuestions): number {
  let chars: number;
  try {
    chars = JSON.stringify({ state, questions })?.length ?? 0;
  } catch {
    chars = String(state).length + Object.keys(questions).length * 200;
  }
  return Math.ceil(chars / 4);
}

/** Truncate helper that marks cut text so the model never sees a silent gap. */
function truncateMarked(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 24))}\n…[truncated ${text.length - (maxChars - 24)} chars]`;
}

/**
 * Build a concise review state (diff + test summary), never the whole repo.
 * Caps each part so typical calls stay far under the ~32k shared budget.
 */
export function buildReviewState(
  diff: string,
  testSummary: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const state: Record<string, string> = {
    diff: truncateMarked(diff || "(no diff)", 12_000),
    tests: truncateMarked(testSummary || "(no test summary)", 4_000),
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (!k) continue;
      state[k] = truncateMarked(String(v ?? ""), 2_000);
    }
  }
  return state;
}

export interface AskJevOptions {
  /** Overrides the env lookup (mainly for tests). Never logged. */
  apiKey?: string;
  /** Defaults to "jev-latest"; "jev-latest:free" is preserved verbatim. */
  model?: string;
  /** Bounded timeout in ms (default 30s). No retries regardless. */
  timeoutMs?: number;
  /** Fetch implementation override (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional outer abort (e.g. Stop button); combined with the timeout. */
  signal?: AbortSignal;
}

function httpHint(status: number): string {
  if (status === 401) return "Missing/invalid key. Check the Authorization header / env value (401).";
  if (status === 422) return "Request failed validation — see the body detail for the offending field (422).";
  if (status === 429) return "Rate limited — back off before retrying (429). No automatic retry was made.";
  if (status === 529) return "Gateway overloaded — retry later with backoff (529). No automatic retry was made.";
  return "";
}

/**
 * Ask Jev one batch of INDEPENDENT questions about the same state.
 *
 * One POST, one attempt, bounded timeout. Never retries, never sets
 * Idempotency-Key, never streams. Throws JevError (`missing-key` before any
 * I/O, `validation` before any charged call, `http`/`timeout`/`transport`/
 * `parse` after). Read answers by question ID (e.g. response.answers.review).
 */
export async function askJev(
  state: JevState,
  questions: JevQuestions,
  opts: AskJevOptions = {},
): Promise<JevResponse> {
  const model = opts.model ?? JEV_MODEL;
  validateJevRequest(state, questions, model);
  const apiKey = resolveJevApiKey(opts.apiKey);
  const fetchImpl = opts.fetchImpl ?? (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== "function") {
    throw new JevError("transport", "fetch is unavailable in this runtime — cannot reach the Jev gateway.");
  }
  const timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new JevError("validation", "timeoutMs must be within 1..120000 ms.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Jev request timed out", "TimeoutError")), timeoutMs);
  const onOuterAbort = (): void => controller.abort(opts.signal?.reason ?? new DOMException("Aborted", "AbortError"));
  if (opts.signal) {
    if (opts.signal.aborted) onOuterAbort();
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let res: Response;
  try {
    // Single attempt: no retries, no Idempotency-Key, no streaming, no
    // Chat Completions / Responses / Messages facade — plain JSON POST.
    res = await fetchImpl(JEV_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err?.name === "TimeoutError" || controller.signal.aborted) {
      throw new JevError("timeout", `Jev request timed out after ${timeoutMs} ms — outcome unknown (may already be charged). No retry was made.`);
    }
    throw new JevError("transport", `Jev transport error: ${String(err?.message || err).slice(0, 300)} — outcome unknown (may already be charged). No retry was made.`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  if (!res.ok) {
    let snippet: string;
    try {
      snippet = (await res.text()).slice(0, 2000);
    } catch {
      snippet = "";
    }
    const hint = httpHint(res.status);
    throw new JevError(
      "http",
      `Jev gateway HTTP ${res.status}${hint ? ` — ${hint}` : ""}${snippet ? ` Body: ${snippet}` : ""} No retry was made.`,
      res.status,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new JevError("parse", "Jev gateway returned non-JSON on a 2xx response.");
  }
  if (!isRecord(data) || !isRecord(data.answers) || !isRecord(data.usage)) {
    throw new JevError("parse", "Jev gateway response shape invalid — expected { model, answers, usage }.");
  }
  return {
    model: typeof data.model === "string" ? data.model : model,
    answers: data.answers as unknown as Record<string, JevAnswer>,
    usage: data.usage as unknown as JevUsage,
  };
}

/** One-line rendering of a single answer (decision only, IDs preserved). */
export function formatJevAnswer(id: string, answer: JevAnswer): string {
  if (answer.type === "choice") {
    return `${id}: choice="${answer.choice}" confidence=${answer.confidence} probabilities=${JSON.stringify(answer.probabilities)}`;
  }
  if (answer.type === "score") {
    return `${id}: score=${answer.score} confidence=${answer.confidence} legend=${JSON.stringify(answer.legend)}`;
  }
  return `${id}: noul=${answer.noul}`;
}

/**
 * Human-readable decision + usage summary. Show this to the user; it performs
 * no action. Probabilities/confidence are not guarantees of correctness —
 * human review is still required.
 */
export function formatJevSummary(response: JevResponse): string {
  const lines = Object.entries(response.answers).map(([id, a]) => formatJevAnswer(id, a));
  lines.push(
    `usage: input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens} model=${response.model}`,
  );
  lines.push(
    "Note: probabilities/confidence are not guarantees of correctness. No choice was executed, nothing was merged, and no review was bypassed.",
  );
  return lines.join("\n");
}
