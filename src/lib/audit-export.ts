// Checksums detect accidental edits. They do not authenticate an audit trail.
import type { AuditEvent } from "../types";

export interface AuditEntry {
  timestamp: string;
  windowLabel: string;
  tool: string;
  status: 'approved' | 'rejected' | 'auto';
  detail: string;
  hash?: string;
  id?: string;
  ok?: boolean;
  ms?: number;
  note?: string;
}

export function auditEntries(events: AuditEvent[], windowLabel: string): AuditEntry[] {
  return events.map((event) => ({
    timestamp: new Date(event.ts).toISOString(), windowLabel,
    tool: event.tool, status: event.decision, detail: event.args,
    id: event.id, ok: event.ok, ms: event.ms, note: event.note,
  }));
}

// Canonical serialization: explicit field order, independent of JSON key
// order on disk. (An array-replacer was previously used here; it dropped
// every entry's fields and hashed "[{}]" no matter what the log contained.)
export async function computeHash(entries: AuditEntry[]): Promise<string> {
  const payload = JSON.stringify(
    entries.map((e) => [e.timestamp ?? "", e.windowLabel ?? "", e.tool ?? "", e.status ?? "", e.detail ?? "", e.id ?? "", e.ok ?? null, e.ms ?? null, e.note ?? ""]),
  );
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildAuditExport(entries: AuditEntry[]): Promise<string> {
  const hash = await computeHash(entries);
  return JSON.stringify({
    version: 1,
    retention: "Up to the latest 100 events in this session; argument details may be truncated.",
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    hash,
    entries,
  }, null, 2);
}

export async function exportAuditLog(entries: AuditEntry[]): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const data = await buildAuditExport(entries);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${timestamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return (JSON.parse(data) as { hash: string }).hash;
}

export async function verifyAuditExport(data: string): Promise<{ valid: boolean; hash: string | null }> {
  try {
    const payload = JSON.parse(data) as { hash?: string; entryCount?: number; entries?: AuditEntry[] };
    const expectedHash = payload.hash ?? null;
    if (!Array.isArray(payload.entries) || typeof expectedHash !== "string") return { valid: false, hash: null };
    const entries = [...payload.entries];
    // Accept the old checksum trailer only in its defined final position.
    const last = entries[entries.length - 1];
    if (last?.tool === "_checksum" && last.hash === expectedHash) entries.pop();
    if (entries.some((entry) => !entry || entry.hash !== undefined ||
      typeof entry.timestamp !== "string" || typeof entry.windowLabel !== "string" ||
      typeof entry.tool !== "string" || typeof entry.detail !== "string" ||
      !["auto", "approved", "rejected"].includes(entry.status)) ||
      (payload.entryCount !== undefined && payload.entryCount !== entries.length)) {
      return { valid: false, hash: expectedHash };
    }
    const computedHash = await computeHash(entries);
    return { valid: computedHash === expectedHash, hash: expectedHash };
  } catch {
    return { valid: false, hash: null };
  }
}
