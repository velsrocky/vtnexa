import { useEffect, useState } from "react";
import type { TrustedPath } from "../types";

const STORAGE_KEY = "vtai.trustedPaths";

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
    if (!pattern) return;
    setPaths(prev => [...prev, { pattern, reason }]);
  }

  function removePath(idx: number) {
    setPaths(prev => prev.filter((_, i) => i !== idx));
  }

  return { paths, addPath, removePath };
}
