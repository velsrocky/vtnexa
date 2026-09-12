import { useState } from "react";
import type { AuditInput } from "../types";
import {
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
  type GitFile,
  type GitLogEntry,
} from "../lib/tauri";

// Git tab state + actions for this window: status/diff/log/commit.
export function useGit(opts: {
  getRoot: () => string;
  logAudit: (e: AuditInput) => void;
}) {
  const [branch, setBranch] = useState("");
  const [root, setRoot] = useState("");
  const [files, setFiles] = useState<GitFile[]>([]);
  const [sel, setSel] = useState("");
  const [diffText, setDiffText] = useState("");
  const [logList, setLogList] = useState<GitLogEntry[]>([]);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState("");
  const [commitMsg, setCommitMsg] = useState("");

  async function refreshGit(selPath?: string) {
    const r = opts.getRoot();
    if (!r) return;
    setNote("loading…");
    try {
      const [st, log] = await Promise.all([
        gitStatus(r),
        gitLog(r, 20).catch(() => [] as GitLogEntry[]),
      ]);
      setBranch(st.branch);
      setRoot(st.root);
      setFiles(st.files);
      setLogList(log);
      setNote(st.files.length ? `${st.files.length} changed` : "clean");
      const s = selPath ?? sel;
      if (s) {
        try {
          const abs = st.root.replace(/\/$/, "") + "/" + s;
          setDiffText(await gitDiff(r, abs));
        } catch (e) {
          setDiffText(`diff failed: ${e}`);
        }
      } else {
        setDiffText("");
      }
    } catch (e) {
      const m = String(e);
      setBranch("");
      setRoot("");
      setFiles([]);
      setLogList([]);
      setDiffText("");
      setNote(m.includes("not a git repository") ? "not a git repo" : `git error: ${m}`);
    }
  }

  async function selectGitFile(relPath: string) {
    setSel(relPath);
    const r = opts.getRoot();
    if (!r || !root) return;
    try {
      setDiffText(await gitDiff(r, root.replace(/\/$/, "") + "/" + relPath));
    } catch (e) {
      setDiffText(`diff failed: ${e}`);
    }
  }

  async function commitListed() {
    const r = opts.getRoot();
    const m = msg.trim();
    if (!m) {
      setNote("commit message required");
      return;
    }
    if (!files.length || !root) {
      setNote("nothing to commit");
      return;
    }
    const absFiles = files.map((f) => root.replace(/\/$/, "") + "/" + f.path);
    const t0 = Date.now();
    try {
      const res = await gitCommit(r, m, absFiles);
      setMsg("");
      await refreshGit();
      // Set the confirmation AFTER the refresh: refreshGit() rewrites the
      // note, so setting it first would flash and vanish.
      setNote(`committed ${res.hash.slice(0, 7)}`);
      opts.logAudit({
        tool: "git_commit",
        args: JSON.stringify({ files: files.map((f) => f.path), message: m }).slice(0, 1000),
        decision: "approved",
        ok: true,
        ms: Date.now() - t0,
        note: "user-approved from Git tab",
      });
    } catch (e) {
      await refreshGit();
      setNote(`commit failed: ${e}`);
      opts.logAudit({
        tool: "git_commit",
        args: JSON.stringify({ files: files.map((f) => f.path), message: m }).slice(0, 1000),
        decision: "approved",
        ok: false,
        ms: Date.now() - t0,
        note: String(e).slice(0, 200),
      });
    }
  }

  return {
    branch,
    root,
    files,
    sel,
    setSel,
    diffText,
    logList,
    msg,
    setMsg,
    note,
    setNote,
    commitMsg,
    setCommitMsg,
    refreshGit,
    selectGitFile,
    commitListed,
  };
}
