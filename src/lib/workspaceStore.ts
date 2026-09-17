// Minimal window-scoped store: extracts audit + approval-queue logic out of
// App.tsx so the god-component shrinks and the rules are unit-testable.
// No external dep: plain subscribe/notify, React via useSyncExternalStore.

export interface AuditEntry {
  id: string;
  ts: number;
  tool: string;
  decision: "auto" | "approved" | "rejected";
  ok: boolean;
  ms: number;
}

export interface PendingApproval {
  tool: string;
  args: Record<string, unknown>;
}

const AUDIT_MAX = 100;

export function createWorkspaceStore() {
  let audit: AuditEntry[] = [];
  let pending: PendingApproval[] = [];
  const listeners = new Set<() => void>();
  let seq = 0;

  function notify() {
    for (const l of listeners) l();
  }

  function log(entry: Omit<AuditEntry, "id" | "ts">): AuditEntry {
    const full = { ...entry, id: `a${++seq}`, ts: Date.now() };
    audit = [...audit, full].slice(-AUDIT_MAX);
    notify();
    return full;
  }

  function enqueue(tool: string, args: Record<string, unknown>) {
    pending = [...pending, { tool, args }];
    notify();
  }

  function resolveHead(ok: boolean): PendingApproval | null {
    const [head, ...rest] = pending;
    if (!head) return null;
    pending = rest;
    notify();
    void ok;
    return head;
  }

  function snapshot() {
    return { audit, pending };
  }

  function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  return { log, enqueue, resolveHead, snapshot, subscribe };
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
