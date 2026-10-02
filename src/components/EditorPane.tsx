import type { ReactNode } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { CenterTab, OperationState, Workspace } from "../types";
import BrowserPane from "./BrowserPane";
import TerminalPane from "./TerminalPane";
import { languageFromPath } from "../lib/preview";
import { basenamePath } from "../lib/path";
import { useInputHistory } from "../hooks/useInputHistory";
import OperationStatus from "./OperationStatus";

// Center column: tabbed edit/diff/preview/browser/git panes + review-gate
// row + one-shot shell + this window's PTY.
export default function EditorPane({ ws, ptyId, shellOperation, workspaceOperation, openPath, tabs, buffers, originals, editorText, originalText, setEditorText, monacoTheme, centerTab, setCenterTab, gitCount, gitPane, previewUrl, setPreviewUrl, previewDoc, openFile, closeTab, saveFile, commitMsg, setCommitMsg, approveDiff, approveAndCommit, onRejectDiff, undo, redo, canUndo, canRedo, undoLabel, shellCmd, onShellCmdChange, runShell, shellH, ptyH, themeId, onHResizerDown }: {
  ws: Workspace;
  ptyId: string;
  shellOperation?: OperationState;
  workspaceOperation?: OperationState;
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
  closeTab: (path: string) => void | Promise<void>;
  saveFile: () => void;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  approveDiff: () => void;
  approveAndCommit: () => void;
  onRejectDiff: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  shellCmd: string;
  onShellCmdChange: (v: string) => void;
  runShell: () => void;
  shellH: number;
  ptyH: number;
  themeId: string;
  onHResizerDown: (which: "shell" | "pty") => (e: React.MouseEvent) => void;
}) {
  const hist = useInputHistory();
  const shellBlocked = shellOperation?.status === "pending" || workspaceOperation?.status === "pending";
  return (
    <section className="editor">
      <div className="pane-title row-between">
        <span className="ellipsis">
          {openPath || "(no file)"}
          {ws.pendingDiff && (
            <span className="pill" style={{ marginLeft: 8 }}>
              {ws.pendingDiff.path === openPath ? `review: ${basenamePath(openPath)}` : `review: ${basenamePath(ws.pendingDiff.path)} (not open)`}
            </span>
          )}
        </span>
        <span className="tabs small" role="tablist" aria-label="Editor views">
          {(["edit", "diff", "preview", "browser", "git"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={centerTab === t}
              className={centerTab === t ? "active" : ""}
              onClick={() => setCenterTab(t)}
            >
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
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openFile(p);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-current={p === openPath ? "page" : undefined}
                title={p}
              >
                {dirty ? "● " : ""}
                {basenamePath(p)}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(p);
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
        <span className="gate" title="Undo covers approved writes, renames and file deletes (not shell/terminal/directory ops). Stack resets on reload. /undo /redo work from chat too.">
          <button onClick={undo} disabled={!canUndo} title={canUndo ? `Undo ${undoLabel}` : "Nothing to undo"}>
            ↩ Undo
          </button>
          <button onClick={redo} disabled={!canRedo} title={canRedo ? "Redo" : "Nothing to redo"}>
            ↪ Redo
          </button>
        </span>
      </div>
      <div className="pane-title">shell - one-shot (agent tool parity)</div>
      <div className="row">
        <input
          value={shellCmd}
          onChange={(e) => onShellCmdChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (shellBlocked) return;
              hist.push(shellCmd);
              void runShell();
              return;
            }
            if (hist.applyKey(e, () => shellCmd, onShellCmdChange)) e.preventDefault();
          }}
          placeholder="one-shot shell (↑/↓ history)"
          className="grow"
          aria-label="One-shot shell command"
        />
        <button
          onClick={() => void runShell()}
          disabled={shellBlocked}
          title={workspaceOperation?.status === "pending" ? "Waiting for the workspace change to finish." : undefined}
        >
          Run
        </button>
        <OperationStatus state={shellOperation} />
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
