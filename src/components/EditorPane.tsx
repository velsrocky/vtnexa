import type { ReactNode } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { CenterTab, Workspace } from "../types";
import BrowserPane from "./BrowserPane";
import TerminalPane from "./TerminalPane";
import { languageFromPath } from "../lib/preview";
import { baseName } from "../lib/utils";

// Center column: tabbed edit/diff/preview/browser/git panes + review-gate
// row + one-shot shell + this window's PTY.
export default function EditorPane({ ws, ptyId, busy, openPath, tabs, buffers, originals, editorText, originalText, setEditorText, monacoTheme, centerTab, setCenterTab, gitCount, gitPane, previewUrl, setPreviewUrl, previewDoc, openFile, closeTab, saveFile, isolateWorktree, leaveWorktree, mergeWorktree, commitMsg, setCommitMsg, approveDiff, approveAndCommit, onRejectDiff, shellCmd, onShellCmdChange, runShell, shellH, ptyH, themeId, onHResizerDown }: {
  ws: Workspace;
  ptyId: string;
  busy: boolean;
  openPath: string;
  tabs: string[];
  buffers: Record<string, string>;
  originals: Record<string, string>;
  editorText: string;
  originalText: string;
  setEditorText: (v: string) => void;
  monacoTheme: string;
  centerTab: CenterTab;
  setCenterTab: (t: CenterTab) => void;
  gitCount: number;
  gitPane: ReactNode;
  previewUrl: string;
  setPreviewUrl: (v: string) => void;
  previewDoc: string;
  openFile: (path: string) => void;
  closeTab: (path: string) => void;
  saveFile: () => void;
  isolateWorktree: () => void;
  leaveWorktree: () => void;
  mergeWorktree: () => void;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  approveDiff: () => void;
  approveAndCommit: () => void;
  onRejectDiff: () => void;
  shellCmd: string;
  onShellCmdChange: (v: string) => void;
  runShell: () => void;
  shellH: number;
  ptyH: number;
  themeId: string;
  onHResizerDown: (which: "shell" | "pty") => (e: React.MouseEvent) => void;
}) {
  return (
    <section className="editor">
      <div className="pane-title row-between">
        <span className="ellipsis">
          {openPath || "(no file)"}
          {ws.pendingDiff && (
            <span className="pill" style={{ marginLeft: 8 }}>
              {ws.pendingDiff.path === openPath ? `review: ${openPath.split("/").pop()}` : `review: ${ws.pendingDiff.path.split("/").pop()} (not open)`}
            </span>
          )}
        </span>
        <span className="tabs small">
          {(["edit", "diff", "preview", "browser", "git"] as const).map((t) => (
            <button key={t} className={centerTab === t ? "active" : ""} onClick={() => setCenterTab(t)}>
              {t === "edit"
                ? "Edit"
                : t === "diff"
                  ? "Diff"
                  : t === "preview"
                    ? "Preview"
                    : t === "browser"
                      ? "Browser"
                      : `Git${gitCount ? ` (${gitCount})` : ""}`}
            </button>
          ))}
        </span>
      </div>
      {tabs.length > 0 && (
        <div className="row tabbar">
          {tabs.map((p) => {
            const dirty = (buffers[p] ?? "") !== (originals[p] ?? "");
            return (
              <span
                key={p}
                className={p === openPath ? "tab active" : "tab"}
                onClick={() => openFile(p)}
                title={p}
              >
                {dirty ? "● " : ""}
                {baseName(p)}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(p);
                  }}
                  title="Close tab"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      {centerTab === "edit" && (
        <div className="monaco-wrap">
          <Editor
            height="100%"
            theme={monacoTheme}
            language={languageFromPath(openPath)}
            value={editorText}
            onChange={(v) => setEditorText(v ?? "")}
            options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
          />
        </div>
      )}
      {centerTab === "diff" && (
        <div className="monaco-wrap">
          <DiffEditor
            height="100%"
            theme={monacoTheme}
            language={languageFromPath(ws.pendingDiff ? ws.pendingDiff.path : openPath)}
            original={ws.pendingDiff ? ws.pendingDiff.original : originalText}
            modified={ws.pendingDiff ? ws.pendingDiff.content : editorText}
            options={{ renderSideBySide: true, automaticLayout: true }}
          />
        </div>
      )}
      {centerTab === "preview" && (
        <div className="preview-col">
          <div className="row">
            <input
              value={previewUrl}
              onChange={(e) => setPreviewUrl(e.target.value)}
              placeholder="live URL e.g. http://localhost:5173 (empty = file preview)"
              className="grow"
            />
            {previewUrl && <button onClick={() => setPreviewUrl("")}>×</button>}
          </div>
          {previewUrl ? (
            <iframe title="live-preview" src={previewUrl} className="preview-frame" sandbox="allow-scripts allow-same-origin" />
          ) : (
            // Static file preview: no scripts. Markdown is DOMPurify-sanitized,
            // text is escaped, HTML renders inert. Live URLs keep scripts (user-entered).
            <iframe title="file-preview" srcDoc={previewDoc} className="preview-frame" sandbox="" />
          )}
        </div>
      )}
      {centerTab === "browser" && (
        <div className="monaco-wrap browser-wrap">
          <BrowserPane />
        </div>
      )}
      {centerTab === "git" && gitPane}
      <div className="row">
        <button onClick={saveFile}>Stage → review gate</button>
        {ws.worktree ? (
          <>
            <span
              className="pill"
              style={{ background: "var(--accent)", color: "var(--accent-text)" }}
              title={`Isolated in worktree ${ws.worktree.path} - committed work stays on ${ws.worktree.branch}`}
            >
              {`⎇ ${ws.worktree.branch.replace(/^vtnexa\//, "")}`}
            </span>
            <button onClick={mergeWorktree} title="git merge this window's branch into the main checkout">
              ⇣ merge to main
            </button>
            <button onClick={leaveWorktree} title="Leave the worktree (uncommitted changes are discarded)">
              leave
            </button>
          </>
        ) : (
          <button
            onClick={isolateWorktree}
            title="Isolate this window in its own git worktree + branch so parallel windows never edit the same files"
          >
            ⎇ isolate
          </button>
        )}
        {ws.pendingDiff && (
          <span className="gate">
            pending: {ws.pendingDiff.path}
            <button onClick={approveDiff}>Approve & apply</button>
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="commit msg (for Approve & commit)"
              title="Used only by Approve & commit"
            />
            <button onClick={approveAndCommit} title="Apply the diff and commit that file">
              Approve & commit
            </button>
            <button onClick={onRejectDiff}>Reject</button>
          </span>
        )}
      </div>
      <div className="pane-title">shell - one-shot (agent tool parity)</div>
      <div className="row">
        <input
          value={shellCmd}
          onChange={(e) => onShellCmdChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runShell()}
          placeholder="one-shot shell"
          className="grow"
        />
        <button onClick={runShell} disabled={busy}>
          Run
        </button>
      </div>
      <div className="hresizer" onMouseDown={onHResizerDown("shell")} title="Drag to resize shell output" />
      <pre className="term small" style={{ height: shellH }}>{ws.shellOut || "$ one-shot ready"}</pre>
      <div className="pane-title">terminal - real PTY (interactive)</div>
      <div className="hresizer" onMouseDown={onHResizerDown("pty")} title="Drag to resize terminal" />
      <div className="pty-stack">
        <TerminalPane ptyId={ptyId} cwd={ws.cwd} themeId={themeId} height={ptyH} />
      </div>
    </section>
  );
}
