import { useEffect, useState } from "react";
import type { AuditInput, CenterTab, Lane } from "../types";
import { isHtmlPreview, isMarkdownPreview, markdownToHtmlSrcDoc, textToHtmlSrcDoc } from "../lib/preview";
import { useEditorTabs } from "./useEditorTabs";
import { useDiffGate } from "./useDiffGate";

// Per-lane editor composition: tab/buffer state (useEditorTabs), the Diff
// review gate (useDiffGate), live preview. App sees one hook with the same
// contract as before; domains stay separate and separately tested.
export function useEditor(opts: {
  lane: Lane;
  setLanes: React.Dispatch<React.SetStateAction<Lane[]>>;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
  workspaceRoot: string;
  cwd: string;
  centerTab: CenterTab;
  setCenterTab: (t: CenterTab) => void;
  refreshFiles: (dir: string, laneId?: string) => Promise<void>;
  refreshGit: () => void;
  refreshSkills: () => void;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  logAudit: (laneId: string, e: AuditInput) => void;
}) {
  const tabs = useEditorTabs({
    lane: opts.lane,
    setLanes: opts.setLanes,
    updateLane: opts.updateLane,
    workspaceRoot: opts.workspaceRoot,
    setCenterTab: opts.setCenterTab,
  });
  const gate = useDiffGate({
    lane: opts.lane,
    updateLane: opts.updateLane,
    workspaceRoot: opts.workspaceRoot,
    cwd: opts.cwd,
    openPath: tabs.openPath,
    editorText: tabs.editorText,
    originalText: tabs.originalText,
    setOriginals: tabs.setOriginals,
    setBuffers: tabs.setBuffers,
    setOriginalText: tabs.setOriginalText,
    setEditorText: tabs.setEditorText,
    refreshFiles: opts.refreshFiles,
    refreshGit: opts.refreshGit,
    refreshSkills: opts.refreshSkills,
    commitMsg: opts.commitMsg,
    setCommitMsg: opts.setCommitMsg,
    logAudit: opts.logAudit,
  });

  const [previewDoc, setPreviewDoc] = useState("");

  // Live preview doc: recompute when file text / tab changes
  useEffect(() => {
    if (opts.centerTab !== "preview") return;
    const openPath = tabs.openPath;
    const editorText = tabs.editorText;
    let cancelled = false;
    (async () => {
      if (!openPath) {
        if (!cancelled) setPreviewDoc(textToHtmlSrcDoc("(no file)", editorText));
        return;
      }
      if (isHtmlPreview(openPath)) {
        if (!cancelled) setPreviewDoc(editorText);
      } else if (isMarkdownPreview(openPath)) {
        const doc = await markdownToHtmlSrcDoc(editorText);
        if (!cancelled) setPreviewDoc(doc);
      } else {
        if (!cancelled) setPreviewDoc(textToHtmlSrcDoc(openPath, editorText));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opts.centerTab, tabs.openPath, tabs.editorText]);

  return {
    openPath: tabs.openPath,
    setOpenPath: tabs.setOpenPath,
    tabs: tabs.tabs,
    buffers: tabs.buffers,
    originals: tabs.originals,
    editorText: tabs.editorText,
    originalText: tabs.originalText,
    setEditorText: tabs.setEditorText,
    shellH: tabs.shellH,
    ptyH: tabs.ptyH,
    onHResizerDown: tabs.onHResizerDown,
    previewDoc,
    previewUrl: tabs.previewUrl,
    setPreviewUrl: tabs.setPreviewUrl,
    openFile: tabs.openFile,
    closeTab: tabs.closeTab,
    retargetTabs: tabs.retargetTabs,
    dropTabsUnder: tabs.dropTabsUnder,
    saveFile: gate.saveFile,
    approveDiff: gate.approveDiff,
    approveAndCommit: gate.approveAndCommit,
  };
}
