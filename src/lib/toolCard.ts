import type { ToolEvent } from "../types";

/** Short human label for a tool call's args: first meaningful field, else head of the JSON. */
export function toolArgsSummary(tool: string, argsJson: string): string {
  const preferred = ["path", "cmd", "command", "old_path", "url", "query", "skill", "name"];
  try {
    const o = JSON.parse(argsJson);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const k of preferred) {
        const v = (o as Record<string, unknown>)[k];
        if (typeof v === "string" && v.length > 0) return shorten(v, 80);
      }
      const firstVal = Object.values(o as Record<string, unknown>).find((v) => v != null);
      if (firstVal !== undefined) return shorten(JSON.stringify(firstVal), 60);
    }
  } catch {
    /* non-JSON args (e.g. truncated or empty) */
  }
  return shorten(argsJson || tool, 60);
}

function shorten(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Persistable, size-capped copy of a turn's tool events (for session.json). */
export function trimToolEvents(tools: ToolEvent[]): ToolEvent[] {
  return tools.slice(-20).map((t) => ({
    tool: t.tool,
    args: t.args.slice(0, 200),
    decision: t.decision,
    ok: t.ok,
    ms: t.ms,
  }));
}

/** Restore-side validation: keep only well-formed events. */
export function reviveToolEvents(v: unknown): ToolEvent[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ToolEvent[] = [];
  for (const e of v) {
    const t = e as Partial<ToolEvent>;
    if (
      typeof t?.tool === "string" &&
      typeof t?.args === "string" &&
      (t.decision === "auto" || t.decision === "approved" || t.decision === "rejected") &&
      typeof t?.ok === "boolean" &&
      typeof t?.ms === "number"
    ) {
      out.push({ tool: t.tool, args: t.args, decision: t.decision, ok: t.ok, ms: t.ms });
    }
  }
  return out.length > 0 ? out : undefined;
}