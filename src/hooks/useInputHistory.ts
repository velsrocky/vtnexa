import { useRef } from "react";

// Up/down command history for a single input (bash-style). In-memory per
// window lifetime - deliberately not persisted: history is low value and
// session.json size matters.
export function useInputHistory(max = 50) {
  const items = useRef<string[]>([]);
  const idx = useRef(-1); // -1 = editing the live draft
  const draft = useRef("");

  function push(text: string) {
    const t = text.trim();
    if (!t) return;
    const arr = items.current;
    if (arr[arr.length - 1] === t) return;
    arr.push(t);
    if (arr.length > max) arr.shift();
    idx.current = -1;
    draft.current = "";
  }

  /**
   * Handle a navigation key. Returns true when consumed (caller should
   * preventDefault). Escape drops back to the saved draft while browsing.
   */
  function applyKey(
    e: { key: string },
    get: () => string,
    set: (v: string) => void,
  ): boolean {
    const arr = items.current;
    if (e.key === "ArrowUp") {
      if (!arr.length) return false;
      if (idx.current === -1) {
        draft.current = get();
        idx.current = arr.length - 1;
      } else if (idx.current > 0) {
        idx.current -= 1;
      }
      set(arr[idx.current]);
      return true;
    }
    if (e.key === "ArrowDown") {
      if (idx.current === -1 || !arr.length) return false;
      if (idx.current < arr.length - 1) {
        idx.current += 1;
        set(arr[idx.current]);
      } else {
        idx.current = -1;
        set(draft.current);
      }
      return true;
    }
    if (e.key === "Escape" && idx.current !== -1) {
      idx.current = -1;
      set(draft.current);
      return true;
    }
    return false;
  }

  return { push, applyKey };
}
