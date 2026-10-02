import { memo } from "react";
import { useWorkspaceBar } from "../context/AppContext";
import OperationStatus from "./OperationStatus";

function WorkspaceBarInner() {
  const {
    workspaceRoot,
    setWorkspaceRoot,
    changeWorkspace,
    browseWorkspace,
    cwd,
    setCwd,
    operation,
    sessionOperation,
    agentActive = false,
    blockedReason = "Workspace changes pause while Commander is working.",
  } = useWorkspaceBar();
  const sessionPending = sessionOperation?.status === "pending";
  const locked = agentActive || sessionPending || operation?.status === "pending";
  const lockReason = agentActive
    ? blockedReason
    : sessionPending
      ? "Waiting for the current session save to finish."
      : operation?.status === "pending"
        ? "Waiting for the current workspace change to finish."
        : "";
  return (
    <div className="configbar">
      <span className="muted small">workspace</span>
      <input
        value={workspaceRoot}
        onChange={(e) => setWorkspaceRoot(e.target.value)}
        onBlur={(e) => changeWorkspace(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") changeWorkspace((e.target as HTMLInputElement).value);
        }}
        placeholder="C:\\Users\\you\\project (sandbox root)"
        className="grow"
        disabled={locked}
        title={lockReason || "All fs/shell/PTY access is confined to this folder"}
        aria-label="Workspace folder"
        data-testid="workspace-root"
      />
      <button onClick={browseWorkspace} disabled={locked} title={lockReason || "Pick workspace folder"}>
        Browse…
      </button>
      <span className="muted small">cwd</span>
      <input
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="current folder (inside workspace)"
        className="grow"
        disabled={locked}
        aria-label="Current workspace folder"
      />
      {lockReason && <span className="muted small" role="status">{lockReason}</span>}
      <OperationStatus state={operation} />
    </div>
  );
}

export default memo(WorkspaceBarInner);
