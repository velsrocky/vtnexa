import { createContext, useCallback, useContext, useState } from "react";
import AccessibleDialog from "../components/AccessibleDialog";

/** Async user confirmation. Default (no provider: tests, headless) falls back
 *  to the blocking window.confirm so hooks stay testable without a wrapper.
 *  In the app, ConfirmProvider (mounted in main.tsx above App) shows a
 *  non-blocking in-window modal instead — nothing blocks the renderer thread. */
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

  const request: RequestConfirm = useCallback(
    (message) => new Promise<boolean>((resolve) => setPending({ message, resolve })),
    [],
  );

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
        <AccessibleDialog
          title="Confirm"
          role="alertdialog"
          initialFocus="cancel"
          describedBy="confirm-message"
          onClose={() => settle(false)}
          closeLabel="Cancel confirmation"
        >
          <p id="confirm-message" className="confirm-message">{pending.message}</p>
          <div className="dialog-actions">
            <button type="button" data-dialog-initial-focus="cancel" onClick={() => settle(false)}>
              Cancel
            </button>
            <button type="button" data-dialog-initial-focus="confirm" onClick={() => settle(true)}>
              Confirm
            </button>
          </div>
        </AccessibleDialog>
      )}
    </ConfirmContext.Provider>
  );
}
