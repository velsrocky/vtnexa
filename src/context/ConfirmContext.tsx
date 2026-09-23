import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/** Async user confirmation. Default (no provider: tests, headless) falls back
 *  to the blocking window.confirm so hooks stay testable without a wrapper.
 *  In the app, ConfirmProvider (mounted in main.tsx above App) shows a
 *  non-blocking in-window modal instead — nothing blocks the renderer thread. */
export type RequestConfirm = (message: string) => Promise<boolean>;

const fallbackConfirm: RequestConfirm = (message) => Promise.resolve(window.confirm(message));

const ConfirmContext = createContext<RequestConfirm>(fallbackConfirm);

export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const request: RequestConfirm = useCallback(
    (message) => new Promise<boolean>((resolve) => setPending({ message, resolve })),
    [],
  );

  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  function settle(v: boolean) {
    setPending((p) => {
      p?.resolve(v);
      return null;
    });
  }

  return (
    <ConfirmContext.Provider value={request}>
      {children}
      {pending && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => settle(false)}
        >
          <div
            style={{
              background: "var(--bg, #1e1e1e)",
              // NOTE: the variable is --text (see App.css per-theme blocks).
              // --fg never existed, so the fallback #eee rendered near-white
              // text on light themes (Paper) — the "empty dialog" reports.
              color: "var(--text, #eee)",
              border: "1px solid var(--border, #555)",
              borderRadius: 8,
              padding: "16px 20px",
              maxWidth: 480,
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") settle(false);
              if (e.key === "Enter") settle(true);
            }}
          >
            <p style={{ margin: "0 0 16px", whiteSpace: "pre-wrap" }}>{pending.message}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => settle(false)}>Cancel</button>
              <button ref={confirmRef} onClick={() => settle(true)}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
