import { Children, cloneElement, isValidElement, useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";

export type AccessibleDialogInitialFocus =
  | "dialog"
  | "first"
  | "cancel"
  | "confirm"
  | HTMLElement
  | (() => HTMLElement | null);

export interface AccessibleDialogProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  initialFocus?: AccessibleDialogInitialFocus;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  pending?: boolean;
  showClose?: boolean;
  closeLabel?: string;
  describedBy?: string;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  footer?: ReactNode;
}

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=true]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.getAttribute("aria-hidden") === "true" || element.hidden) return false;
    if (element instanceof HTMLInputElement && element.type === "hidden") return false;
    return element.getAttribute("tabindex") !== "-1";
  });
}

function disablePendingChildren(children: ReactNode, pending: boolean): ReactNode {
  if (!pending) return children;
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const props = child.props as { children?: ReactNode };
    if (["button", "input", "select", "textarea"].includes(String(child.type))) {
      return cloneElement(child as ReactElement<{ disabled?: boolean }>, { disabled: true });
    }
    if (props.children) return cloneElement(child, undefined, disablePendingChildren(props.children, true));
    return child;
  });
}

export function AccessibleDialog({
  title,
  children,
  onClose,
  role = "dialog",
  initialFocus = "first",
  initialFocusRef,
  closeOnBackdrop = true,
  closeOnEscape = true,
  pending = false,
  showClose = true,
  closeLabel = "Close",
  describedBy,
  className = "",
  bodyClassName = "",
  testId,
  footer,
}: AccessibleDialogProps) {
  const titleId = `${useId()}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const pendingRef = useRef(pending);
  const initialFocusRefValue = useRef(initialFocus);
  const initialFocusElementRef = useRef(initialFocusRef);
  const initialElementRef = useRef<HTMLElement | null>(initialFocusRef?.current ?? null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const backdropHandledRef = useRef(false);
  onCloseRef.current = onClose;
  pendingRef.current = pending;
  initialFocusRefValue.current = initialFocus;
  initialFocusElementRef.current = initialFocusRef;
  initialElementRef.current = initialFocusRef?.current ?? null;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTarget = () => {
      const panel = panelRef.current;
      if (!panel) return;
      let target: HTMLElement | null = initialElementRef.current ?? initialFocusElementRef.current?.current ?? null;
      if (!target) {
        const requested = initialFocusRefValue.current;
        if (requested === "dialog") {
          target = panel;
        } else if (typeof requested === "function") {
          target = requested();
        } else if (requested instanceof HTMLElement) {
          target = requested;
        } else if (requested === "cancel" || requested === "confirm") {
          target = panel.querySelector<HTMLElement>(`[data-dialog-initial-focus="${requested}"]`);
        }
      }
      if (!target || !panel.contains(target)) target = focusableElements(panel)[0] ?? panel;
      target.focus();
    };
    const raf = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(focusTarget) : null;
    const timer = raf == null ? window.setTimeout(focusTarget, 0) : null;
    return () => {
      if (raf != null) window.cancelAnimationFrame(raf);
      if (timer != null) window.clearTimeout(timer);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function requestClose() {
    if (!pendingRef.current) onCloseRef.current();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const elements = focusableElements(panel);
    if (elements.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panel || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="accessible-dialog-overlay"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || !closeOnBackdrop) return;
        backdropHandledRef.current = true;
        requestClose();
        window.setTimeout(() => {
          backdropHandledRef.current = false;
        }, 0);
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || !closeOnBackdrop) return;
        if (backdropHandledRef.current) {
          backdropHandledRef.current = false;
          return;
        }
        requestClose();
      }}
    >
      <div
        ref={panelRef}
        className={`accessible-dialog ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={pending || undefined}
        data-testid={testId}
        tabIndex={-1}
      >
        <div className="accessible-dialog-header">
          <h2 id={titleId}>{title}</h2>
          {showClose && (
            <button type="button" onClick={requestClose} disabled={pending} aria-label={closeLabel}>
              ×
            </button>
          )}
        </div>
        <div className={`accessible-dialog-body ${bodyClassName}`.trim()}>{disablePendingChildren(children, pending)}</div>
        {footer && <div className="accessible-dialog-footer">{disablePendingChildren(footer, pending)}</div>}
      </div>
    </div>
  );
}

export default AccessibleDialog;
