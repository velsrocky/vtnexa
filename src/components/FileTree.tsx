import type { FileEntry, SideTab } from "../types";
import type { SkillInfo } from "../types";
import type { CreatingState, RenamingState } from "../hooks/useFiles";

export default function FileTree({ cwd, workspaceRoot, files, creating, renaming, skills, conventionsName, width, setCreating, setRenaming, setCwd, openFile, createEntry, doRename, doDelete, createSkill, setInput, setSideTab }: {
  cwd: string;
  workspaceRoot: string;
  files: FileEntry[];
  creating: CreatingState | null;
  renaming: RenamingState | null;
  skills: SkillInfo[];
  conventionsName: string;
  width: number;
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
}) {
  return (
    <aside className="files" style={{ width }}>
      <div className="pane-title row-between">
        <span className="ellipsis">{cwd || workspaceRoot || "(pick a workspace)"}</span>
        <span className="tabs small">
          <button onClick={() => setCreating({ isDir: false, name: "" })} title="New file in this folder">＋file</button>
          <button onClick={() => setCreating({ isDir: true, name: "" })} title="New folder here">＋dir</button>
        </span>
      </div>
      <div className="filelist">
        {creating && (
          <div className="filerow">
            {creating.isDir ? "📁" : "📄"}{" "}
            <input
              autoFocus
              value={creating.name}
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
              onClick={() => (f.is_dir ? setCwd(f.path) : openFile(f.path))}
              onDoubleClick={() => f.is_dir && setCwd(f.path)}
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
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    doDelete(f.path, f.is_dir);
                  }}
                  title="Delete (permanent)"
                >
                  ×
                </button>
              </span>
            </div>
          ),
        )}
      </div>
      <button onClick={() => workspaceRoot && setCwd(workspaceRoot)}>⌂ workspace root</button>
      <div className="pane-title row-between" style={{ marginTop: 8 }}>
        <span>
          skills ({skills.length}){conventionsName ? ` · ${conventionsName} ✓` : ""}
        </span>
        <span className="tabs small">
          <button onClick={createSkill} title="New skill in .vtnexa/skills/">＋</button>
        </span>
      </div>
      <div className="filelist" style={{ flex: "0 1 auto", maxHeight: 150 }}>
        {skills.map((s) => (
          <div
            key={s.name}
            className="filerow"
            title={s.description || s.name}
            onClick={() => {
              setInput(`/${s.name} `);
              setSideTab("chat");
            }}
          >
            <span className="ellipsis" style={{ flex: 1 }}>
              ⚡ /{s.name}
              {s.description && <span className="muted"> - {s.description}</span>}
            </span>
          </div>
        ))}
        {skills.length === 0 && (
          <div className="muted small">no skills - ＋ adds one</div>
        )}
      </div>
    </aside>
  );
}
