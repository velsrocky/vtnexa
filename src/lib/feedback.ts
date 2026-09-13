import { uid } from "./utils";

export interface FeedbackEntry {
  id: string;
  messageId: string;
  sessionId: string;
  model: string;
  rating: 1 | -1;
  at: number;
  /** Truncated user prompt that led to the rated answer. */
  prompt: string;
  /** Truncated rated answer. */
  answer: string;
}

const KEY = "vtai.feedback";
const MAX = 200;

function valid(e: unknown): e is FeedbackEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.messageId === "string" &&
    (o.rating === 1 || o.rating === -1) &&
    typeof o.at === "number"
  );
}

export function loadFeedback(): FeedbackEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(valid).slice(0, MAX);
  } catch {
    return [];
  }
}

function store(next: FeedbackEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX)));
  } catch {
    /* ignore quota errors */
  }
}

/** Upsert a rating by messageId (re-rating overwrites). Returns the list. */
export function rateMessage(input: {
  messageId: string;
  sessionId: string;
  model: string;
  rating: 1 | -1;
  prompt: string;
  answer: string;
}): FeedbackEntry[] {
  if (!input.messageId) return loadFeedback();
  const entry: FeedbackEntry = {
    id: uid(),
    messageId: input.messageId,
    sessionId: input.sessionId ?? "",
    model: input.model ?? "",
    rating: input.rating,
    at: Date.now(),
    prompt: input.prompt.slice(0, 500),
    answer: input.answer.slice(0, 2000),
  };
  const next = [entry, ...loadFeedback().filter((e) => e.messageId !== input.messageId)].slice(
    0,
    MAX,
  );
  store(next);
  return next;
}

export function ratingMap(list: FeedbackEntry[]): Record<string, 1 | -1> {
  const out: Record<string, 1 | -1> = {};
  for (const e of list) out[e.messageId] = e.rating;
  return out;
}
