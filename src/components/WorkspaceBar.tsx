export default function WorkspaceBar({ workspaceRoot, setWorkspaceRoot, changeWorkspace, browseWorkspace, cwd, setCwd }: {
  workspaceRoot: string;
  setWorkspaceRoot: (v: string) => void;
  changeWorkspace: (v: string) => void;
  browseWorkspace: () => void;
  cwd: string;
  setCwd: (v: string) => void;
}) {
  return (
    <div className="configbar">
      <span className="muted small">workspace</span>
      <input
        value={workspaceRoot}
        onChange={(e) => setWorkspaceRoot(e.target.value)}
        onBlur={(e) => changeWorkspace(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && changeWorkspace((e.target as HTMLInputElement).value)}
        placeholder="/home/you/project (sandbox root)"
        className="grow"
        title="All fs/shell/PTY access is confined to this dir"
      />
      <button onClick={browseWorkspace} title="Pick workspace folder">Browse…</button>
      <span className="muted small">cwd</span>
      <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="current dir (inside workspace)" className="grow" />
    </div>
  );
}
