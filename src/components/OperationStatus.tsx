import type { OperationState } from "../types";

export default function OperationStatus({ state, className = "" }: { state?: OperationState; className?: string }) {
  if (!state || state.status === "idle") return null;
  const role = state.status === "error" ? "alert" : "status";
  return (
    <span className={`operation-status ${state.status} ${className}`.trim()} role={role} aria-live="polite">
      {state.message}
    </span>
  );
}
