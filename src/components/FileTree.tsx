import type { FileEntry, OperationState, SideTab } from "../types";
import type { SkillInfo } from "../types";
import type { CreatingState, RenamingState } from "../hooks/useFiles";
import OperationStatus from "./OperationStatus";

export default function FileTree({ cwd, workspaceRoot, files, creating, renaming, skills, conventionsName, width, skillH, onSkillResizerDown, setCreating, setRenaming, setCwd, openFile, createEntry, doRename, doDelete, createSkill, setInput, setSideTab, operation, workspaceOperation, agentActive = false }: {
  cwd: string;
  workspaceRoot: string;
  files: FileEntry[];
  creating: CreatingState | null;
  renaming: RenamingState | null;
  skills: SkillInfo[];
  conventionsName: string;
  width: number;
  skillH: number;
  onSkillResizerDown: (e: React.MouseEvent) => void;
  setCreating: (v: CreatingState | null) => void;
  setRenaming: (v: RenamingState | null) => void;
  setCwd: (v: string) => void;
  openFile: (path: string) => void;
  createEntry: () => void;
  doRename: () => void;
  doDelete: (path: string, isDir: boolean) => void;
  createSkill: () => void;
  setInput: (v: string) => void;
  setSideTab: (t: SideTab) => void;
  operation?: OperationState;
  workspaceOperation?: OperationState;
  agentActive?: boolean;
}) {
  const workspacePending = workspaceOperation?.status === "pending";
  const fileLocked = agentActive || workspacePending || operation?.status === "pending";
  const lockReason = agentActive
    ? "File changes pause while Commander is working."
    : workspacePending
      ? "Waiting for the workspace change to finish."
      : "Waiting for the current file operation.";
  return (
    <aside className="files" style={{ width }}>
      <div className="pane-title row-between">
        <span className="ellipsis">{cwd || workspaceRoot || "(pick a workspace)"}</span>
        <span className="tabs small">
          <button onClick={() => setCreating({ isDir: false, name: "" })} disabled={fileLocked} title={fileLocked ? lockReason : "New file in this folder"}>＋file</button>
          <button onClick={() => setCreating({ isDir: true, name: "" })} disabled={fileLocked} title={fileLocked ? lockReason : "New folder here"}>＋dir</button>
        </span>
      </div>
      <OperationStatus state={operation} />
      {fileLocked && operation?.status !== "pending" && <div className="muted small" role="status">{lockReason}</div>}
      <div className="filelist">
        {creating && (
          <div className="filerow">
            {creating.isDir ? "📁" : "📄"}{" "}
            <input
              autoFocus
               value={creating.name}
               disabled={fileLocked}
               onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") createEntry();
                if (e.key === "Escape") setCreating(null);
              }}
              onBlur={() => setCreating(null)}
              placeholder={creating.isDir ? "folder name" : "file name"}
              className="grow"
            />
          </div>
        )}
        {files.map((f) =>
          renaming?.path === f.path ? (
            <div key={f.path} className="filerow">
              {f.is_dir ? "📁" : "📄"}{" "}
              <input
                autoFocus
                 value={renaming.name}
                 disabled={fileLocked}
                 onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming(null)}
                className="grow"
              />
            </div>
          ) : (
            <div
              key={f.path}
               className="filerow"
               role="button"
               tabIndex={0}
               aria-label={`${f.is_dir ? "Open folder" : "Open file"} ${f.name}`}
               onClick={() => (f.is_dir ? setCwd(f.path) : openFile(f.path))}
               onDoubleClick={() => f.is_dir && setCwd(f.path)}
               onKeyDown={(e) => {
                 if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                 e.preventDefault();
                 if (f.is_dir) setCwd(f.path);
                 else openFile(f.path);
               }}
            >
              <span className="ellipsis" style={{ flex: 1 }}>
                {f.is_dir ? "📁" : "📄"} {f.name}
              </span>
              <span className="tabs small">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming({ path: f.path, name: f.name });
                  }}
                    title={fileLocked ? lockReason : "Rename"}
                    disabled={fileLocked}
                  >
                  ✎
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    doDelete(f.path, f.is_dir);
                  }}
                    title={fileLocked ? lockReason : "Delete (permanent)"}
                    disabled={fileLocked}
                  >
                  ×
                </button>
              </span>
            </div>
          ),
        )}
      </div>
      <button onClick={() => workspaceRoot && setCwd(workspaceRoot)} disabled={fileLocked} title={fileLocked ? lockReason : "Go to workspace root"}>⌂ workspace root</button>
      <div className="hresizer" onMouseDown={onSkillResizerDown} title="Drag to resize skills panel" />
      <div className="pane-title row-between" style={{ marginTop: 8 }}>
        <span>
          skills ({skills.length}){conventionsName ? ` · ${conventionsName} ✓` : ""}
        </span>
        <span className="tabs small">
          <button onClick={createSkill} disabled={fileLocked} title={fileLocked ? lockReason : "New skill in .vtnexa/skills/"}>＋</button>
        </span>
      </div>
      <div className="filelist" style={{ flex: "0 1 auto", maxHeight: skillH, overflowY: "auto" }}>
        {skills.map((s) => (
          <div
            key={s.name}
            className="filerow skillrow"
             title={s.description ? `/${s.name} - ${s.description}` : `/${s.name}`}
             role="button"
             tabIndex={0}
             onKeyDown={(e) => {
               if (e.key !== "Enter" && e.key !== " ") return;
               e.preventDefault();
               setInput(`/${s.name} `);
               setSideTab("chat");
             }}
             onClick={() => {
               setInput(`/${s.name} `);
               setSideTab("chat");
             }}
          >
            <span className="ellipsis">⚡ /{s.name}</span>
            {s.description && <span className="muted small skilldesc">{s.description}</span>}
          </div>
        ))}
        {skills.length === 0 && (
          <div className="muted small">no skills - ＋ adds one</div>
        )}
      </div>
    </aside>
  );
}
