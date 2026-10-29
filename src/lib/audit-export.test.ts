// @vitest-environment node
import { describe, expect, it } from "vitest";
import { auditEntries, buildAuditExport, computeHash, verifyAuditExport, type AuditEntry } from "./audit-export";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  timestamp: "2026-01-01T00:00:00Z",
  windowLabel: "main",
  tool: "shell_run",
  status: "auto",
  detail: "ls -la",
  ...over,
});

const wrap = (entries: AuditEntry[], hash: string) =>
  JSON.stringify({
    hash,
    entries: [...entries, { hash, timestamp: "2026-01-01T00:00:01Z", tool: "_checksum" }],
  });

describe("computeHash", () => {
  it("is deterministic for identical logs", async () => {
    expect(await computeHash([entry()])).toBe(await computeHash([entry()]));
  });

  it("changes when any entry field changes", async () => {
    const base = await computeHash([entry()]);
    for (const over of [
      { timestamp: "2026-01-02T00:00:00Z" },
      { windowLabel: "second" },
      { tool: "fs_write" },
      { status: "rejected" as const },
      { detail: "rm -rf /" },
    ]) {
      expect(await computeHash([entry(over)])).not.toBe(base);
    }
  });

  it("is content-sensitive, not shape-sensitive (regression: '[{}]' hash)", async () => {
    const a = await computeHash([entry(), entry({ detail: "x" })]);
    const b = await computeHash([entry(), entry({ detail: "y" })]);
    const empty = await computeHash([]);
    expect(new Set([a, b, empty]).size).toBe(3);
  });
});

describe("verifyAuditExport", () => {
  it("exports actual retained events and checks result/timing fields too", async () => {
    const entries = auditEntries([{ id: "event1", ts: 1, tool: "shell_run", args: "{}", decision: "auto", ok: true, ms: 12, note: "workspace" }], "main-2");
    const exported = await buildAuditExport(entries);
    expect((await verifyAuditExport(exported)).valid).toBe(true);
    const payload = JSON.parse(exported);
    expect(payload.retention).toContain("100");
    expect(payload.entries[0]).toMatchObject({ windowLabel: "main-2", status: "auto", ok: true, ms: 12 });
    payload.entries[0].ok = false;
    expect((await verifyAuditExport(JSON.stringify(payload))).valid).toBe(false);
  });

  it("rejects hash fields used to hide entries and an incorrect count", async () => {
    const payload = JSON.parse(await buildAuditExport([entry()]));
    payload.entries.push({ ...entry(), hash: "hidden" });
    expect((await verifyAuditExport(JSON.stringify(payload))).valid).toBe(false);
    payload.entries.pop();
    payload.entryCount = 0;
    expect((await verifyAuditExport(JSON.stringify(payload))).valid).toBe(false);
  });
  it("accepts an untouched export", async () => {
    const entries = [entry(), entry({ tool: "git_commit", status: "approved" })];
    const res = await verifyAuditExport(wrap(entries, await computeHash(entries)));
    expect(res).toEqual({ valid: true, hash: await computeHash(entries) });
  });

  it("rejects a tampered entry", async () => {
    const entries = [entry(), entry({ tool: "git_commit", status: "approved" })];
    const file = JSON.parse(wrap(entries, await computeHash(entries)));
    file.entries[0].status = "auto";
    file.entries[0].detail = "rm -rf ~";
    expect((await verifyAuditExport(JSON.stringify(file))).valid).toBe(false);
  });

  it("rejects a deleted entry", async () => {
    const entries = [entry(), entry({ tool: "git_commit", status: "approved" })];
    const file = JSON.parse(wrap(entries, await computeHash(entries)));
    file.entries.splice(1, 1);
    expect((await verifyAuditExport(JSON.stringify(file))).valid).toBe(false);
  });

  it("survives key reordering on disk (canonical serialization)", async () => {
    const entries = [entry()];
    const hash = await computeHash(entries);
    const reordered = entries.map((e) => ({
      detail: e.detail,
      status: e.status,
      tool: e.tool,
      windowLabel: e.windowLabel,
      timestamp: e.timestamp,
    }));
    const res = await verifyAuditExport(wrap(reordered as AuditEntry[], hash));
    expect(res.valid).toBe(true);
  });

  it("fails closed on malformed input", async () => {
    expect(await verifyAuditExport("not json")).toEqual({ valid: false, hash: null });
    expect(await verifyAuditExport("{}")).toEqual({ valid: false, hash: null });
  });
});
