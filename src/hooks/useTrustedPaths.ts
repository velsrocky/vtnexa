import { useEffect, useState } from "react";
import type { TrustedPath } from "../types";

const STORAGE_KEY = "vtai.trustedPaths";

/** Mirror of the backend's normalize_trusted_pattern (workspace.rs): fail
 *  fast in the UI so the backend isn't the only place saying no. */
export function validateTrustedPattern(raw: string): string | null {
  const t = raw.trim().replace(/\\/g, "/");
  if (!t) return "Pattern is empty";
  if (t.length > 256) return "Pattern too long (256 max)";
  if (t.includes("\0")) return "Invalid pattern";
  const parts = t.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "Pattern matches everything (refused)";
  for (const s of parts) {
    if (s === "." || s === "..") return "'..' and '.' are not allowed";
    if (s === "~" || s.startsWith("~")) return "'~' is not allowed";
  }
  return null;
}

export function normalizeTrustedPattern(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

export function useTrustedPaths() {
  const [paths, setPaths] = useState<TrustedPath[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
    } catch {}
  }, [paths]);

  function addPath(pattern: string, reason: string) {
    if (!pattern.trim()) return "Pattern is empty";
    const err = validateTrustedPattern(pattern);
    if (err) return err;
    if (paths.length >= 50) return "Too many entries (50 max)";
    const norm = normalizeTrustedPattern(pattern);
    if (paths.some((p) => normalizeTrustedPattern(p.pattern).toLowerCase() === norm.toLowerCase())) {
      return "Already trusted";
    }
    setPaths((prev) => [...prev, { pattern: norm, reason: reason.slice(0, 256) }]);
    return null;
  }

  function removePath(idx: number) {
    setPaths(prev => prev.filter((_, i) => i !== idx));
  }

  return { paths, addPath, removePath };
}
