import { describe, expect, it } from "vitest";
import { reviveToolEvents, toolArgsSummary, trimToolEvents } from "./toolCard";

describe("toolArgsSummary", () => {
  it("prefers path/cmd/url fields", () => {
    expect(toolArgsSummary("fs_read", JSON.stringify({ path: "/ws/src/main.ts" }))).toBe("/ws/src/main.ts");
    expect(toolArgsSummary("shell_run", JSON.stringify({ cmd: "ls -la", cwd: "." }))).toBe("ls -la");
    expect(toolArgsSummary("browser_navigate", JSON.stringify({ url: "http://x.dev/", width: 800 }))).toBe("http://x.dev/");
  });

  it("falls back to first value then raw args", () => {
    expect(toolArgsSummary("weird", JSON.stringify({ z: "first", a: "second" }))).toBe('"first"');
    expect(toolArgsSummary("weird", "not json at all")).toBe("not json at all");
    expect(toolArgsSummary("nexa_read", "{}")).toBe("{}");
  });

  it("shortens long values", () => {
    const long = "x".repeat(200);
    const out = toolArgsSummary("shell_run", JSON.stringify({ cmd: long }));
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("trimToolEvents", () => {
  it("keeps last 20 and caps args at 200 chars", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      tool: `t${i}`,
      args: "y".repeat(500),
      decision: "auto" as const,
      ok: true,
      ms: i,
    }));
    const out = trimToolEvents(events);
    expect(out).toHaveLength(20);
    expect(out[0].tool).toBe("t10");
    expect(out[19].tool).toBe("t29");
    expect(out[0].args.length).toBe(200);
  });
});

describe("reviveToolEvents", () => {
  it("round-trips valid events and rejects malformed ones", () => {
    const good = { tool: "fs_read", args: '{"path":"/a"}', decision: "auto" as const, ok: true, ms: 5 };
    expect(reviveToolEvents([good])).toEqual([good]);
    expect(reviveToolEvents([good, { tool: "x", args: 1, decision: "auto", ok: true, ms: 1 }, null, "junk"])).toEqual([good]);
    expect(reviveToolEvents("nope")).toBeUndefined();
    expect(reviveToolEvents([])).toBeUndefined();
  });
});
