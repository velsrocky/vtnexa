import { gitInit } from "../lib/tauri";
import type { GitFile, GitLogEntry } from "../lib/tauri";

export default function GitPane({ branch, files, sel, diffText, logList, msg, setMsg, note, setNote, laneCwd, fallbackCwd, refreshGit, selectGitFile, commitListed }: {
  branch: string;
  files: GitFile[];
  sel: string;
  diffText: string;
  logList: GitLogEntry[];
  msg: string;
  setMsg: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  laneCwd: string;
  fallbackCwd: string;
  refreshGit: () => void;
  selectGitFile: (relPath: string) => void;
  commitListed: () => void;
}) {
  return (
    <div className="git-col">
      <div className="row">
        <span className={branch ? "pill on" : "pill"}>{branch ? `⎇ ${branch}` : "○ no repo"}</span>
        <button onClick={() => refreshGit()} title="Refresh git status">↻</button>
        {note === "not a git repo" && (
          <button
            onClick={async () => {
              try {
                await gitInit(laneCwd || fallbackCwd);
                refreshGit();
              } catch (e) {
                setNote(`init failed: ${e}`);
              }
            }}
          >
            Init repo
          </button>
        )}
        <span className="muted small">{note}</span>
      </div>
      <div className="git-body">
        <div className="git-files">
          <div className="pane-title">changed ({files.length})</div>
          <div className="filelist">
            {files.map((f) => (
              <div
                key={f.path}
                className="filerow"
                style={f.path === sel ? { background: "var(--hover)" } : undefined}
                onClick={() => selectGitFile(f.path)}
              >
                <span className="el-tag">{f.status || "?"}</span> {f.path}
              </div>
            ))}
            {files.length === 0 && branch && (
              <div className="muted small">working tree clean</div>
            )}
          </div>
        </div>
        <div className="git-diff">
          <div className="pane-title">{sel || "select a file to see its diff"}</div>
          <pre className="term small">{diffText || "—"}</pre>
        </div>
      </div>
      <div className="row">
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitListed()}
          placeholder="commit message - commits the listed files only"
          className="grow"
        />
        <button onClick={commitListed} disabled={!files.length}>
          Commit listed
        </button>
      </div>
      <div className="pane-title">recent commits</div>
      <div className="git-log">
        {logList.map((c) => (
          <div key={c.hash} className="muted small">
            {c.hash.slice(0, 7)} · {c.date} · {c.author} · {c.message}
          </div>
        ))}
      </div>
    </div>
  );
}
