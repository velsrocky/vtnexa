import type { Routine } from "../types";
import { detectPathStyle, normalizePath } from "./path";

export interface RoutineTrustRecord {
  identity: string;
  fingerprint: string;
}

export type RoutineTrustRecords = Record<string, RoutineTrustRecord>;

export interface TrustStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = "vtai.routineTrust.v1";

export function canonicalWorkspaceKey(workspace: string): string {
  const value = workspace.trim();
  if (!value) return "";
  const normalized = normalizePath(value);
  const result = detectPathStyle(normalized) === "windows" ? normalized.toLowerCase() : normalized;
  return result.length > 1 ? result.replace(/[\\/]+$/, "") : result;
}

export function routineContentFingerprint(routine: Routine): string {
  return JSON.stringify({
    id: routine.id,
    name: routine.name,
    prompt: routine.prompt,
    everyMs: routine.everyMs,
    enabled: routine.enabled,
  });
}

export function routineTrustStorageKey(
  workspace: string,
  windowLabel = "main",
): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(windowLabel)}:${encodeURIComponent(canonicalWorkspaceKey(workspace))}`;
}

function storageOrNull(storage?: TrustStorage | null): TrustStorage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function parseRecords(raw: string | null): RoutineTrustRecords {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const records: RoutineTrustRecords = {};
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!id || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.identity !== "string" || typeof record.fingerprint !== "string") continue;
      records[id] = { identity: record.identity, fingerprint: record.fingerprint };
    }
    return records;
  } catch {
    return {};
  }
}

function serializeRecords(records: RoutineTrustRecords): string {
  const sorted: RoutineTrustRecords = {};
  for (const id of Object.keys(records).sort()) sorted[id] = records[id];
  return JSON.stringify(sorted);
}

export function readRoutineTrustRecords(
  workspace: string,
  windowLabel = "main",
  storage?: TrustStorage | null,
): RoutineTrustRecords {
  const store = storageOrNull(storage);
  if (!store || !canonicalWorkspaceKey(workspace)) return {};
  return parseRecords(store.getItem(routineTrustStorageKey(workspace, windowLabel)));
}

export function writeRoutineTrustRecords(
  workspace: string,
  windowLabel: string,
  records: RoutineTrustRecords,
  storage?: TrustStorage | null,
): void {
  const store = storageOrNull(storage);
  if (!store || !canonicalWorkspaceKey(workspace)) return;
  const key = routineTrustStorageKey(workspace, windowLabel);
  if (Object.keys(records).length === 0) store.removeItem(key);
  else store.setItem(key, serializeRecords(records));
}

export function isRoutineTrusted(
  routine: Routine,
  workspace: string,
  windowLabel = "main",
  storage?: TrustStorage | null,
): boolean {
  if (!routine.enabled) return false;
  const record = readRoutineTrustRecords(workspace, windowLabel, storage)[routine.id];
  return record?.identity === routine.id && record.fingerprint === routineContentFingerprint(routine);
}

export function reconcileRoutineTrust(
  routines: Routine[],
  workspace: string,
  windowLabel = "main",
  storage?: TrustStorage | null,
): Set<string> {
  const records = readRoutineTrustRecords(workspace, windowLabel, storage);
  const trusted = new Set<string>();
  const present = new Set(routines.map((routine) => routine.id));
  const merged = { ...records };
  for (const routine of routines) {
    const record = records[routine.id];
    if (!routine.enabled || !record || record.identity !== routine.id) {
      delete merged[routine.id];
      continue;
    }
    if (record.fingerprint !== routineContentFingerprint(routine)) {
      delete merged[routine.id];
      continue;
    }
    merged[routine.id] = record;
    trusted.add(routine.id);
  }
  for (const id of Object.keys(merged)) {
    if (!present.has(id)) delete merged[id];
  }
  writeRoutineTrustRecords(workspace, windowLabel, merged, storage);
  return trusted;
}

export function grantRoutineTrust(
  routine: Routine,
  workspace: string,
  windowLabel = "main",
  storage?: TrustStorage | null,
): void {
  if (!routine.enabled) return;
  const records = readRoutineTrustRecords(workspace, windowLabel, storage);
  records[routine.id] = {
    identity: routine.id,
    fingerprint: routineContentFingerprint(routine),
  };
  writeRoutineTrustRecords(workspace, windowLabel, records, storage);
}

export function revokeRoutineTrust(
  routineOrId: Routine | string,
  workspace: string,
  windowLabel = "main",
  storage?: TrustStorage | null,
): void {
  const id = typeof routineOrId === "string" ? routineOrId : routineOrId.id;
  const records = readRoutineTrustRecords(workspace, windowLabel, storage);
  delete records[id];
  writeRoutineTrustRecords(workspace, windowLabel, records, storage);
}

export function routineCanAutoRun(
  routine: Routine,
  trusted: boolean,
  now: number,
): boolean {
  return trusted && routine.enabled && routine.everyMs > 0 && (routine.nextRun ?? Infinity) <= now;
}

export function routineForPersistence(routine: Routine): Omit<Routine, "trusted"> {
  const { trusted: _trusted, ...value } = routine as Routine & { trusted?: boolean };
  return value;
}
