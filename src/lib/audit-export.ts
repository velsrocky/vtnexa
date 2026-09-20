// Audit log export with cryptographic hash verification.

export interface AuditEntry {
  timestamp: string;
  windowLabel: string;
  tool: string;
  status: 'approved' | 'rejected' | 'auto';
  detail: string;
  hash?: string;
}

// Canonical serialization: explicit field order, independent of JSON key
// order on disk. (An array-replacer was previously used here; it dropped
// every entry's fields and hashed "[{}]" no matter what the log contained.)
export async function computeHash(entries: AuditEntry[]): Promise<string> {
  const payload = JSON.stringify(
    entries.map((e) => [e.timestamp ?? "", e.windowLabel ?? "", e.tool ?? "", e.status ?? "", e.detail ?? ""]),
  );
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function exportAuditLog(entries: AuditEntry[]): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = await computeHash(entries);
  const payload = {
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    hash,
    entries: [...entries, { hash, timestamp: new Date().toISOString(), tool: '_checksum' }]
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${timestamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return hash;
}

export async function verifyAuditExport(data: string): Promise<{ valid: boolean; hash: string | null }> {
  try {
    const payload = JSON.parse(data) as { hash?: string; entries?: (AuditEntry & { hash?: string })[] };
    const expectedHash = payload.hash ?? null;
    const entries = (payload.entries ?? []).filter((e) => !e.hash);
    const computedHash = await computeHash(entries);
    return { valid: computedHash === expectedHash, hash: expectedHash };
  } catch {
    return { valid: false, hash: null };
  }
}
