import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loader } from "@monaco-editor/react";
// Monaco served from local static files (public/vs, copied from
// node_modules/monaco-editor/min/vs by the predev/prebuild script) instead of
// the default jsdelivr CDN. Required for offline use and the Tauri CSP
// (script-src 'self', no CDN host). Workers load same-origin via getWorkerUrl.
loader.config({ paths: { vs: "/vs" } });
import "./App.css";
import type { CenterTab, SideTab } from "./types";
import ApprovalModal from "./components/ApprovalModal";
import RoutinesModal from "./components/RoutinesModal";
import GitPane from "./components/GitPane";
import FileTree from "./components/FileTree";
import ChatPane from "./components/ChatPane";
import EditorPane from "./components/EditorPane";
import TopBar from "./components/TopBar";
import ProviderBar from "./components/ProviderBar";
import WorkspaceBar from "./components/WorkspaceBar";
import { useGit } from "./hooks/useGit";
import { useLanes } from "./hooks/useLanes";
import { useAgentTurn } from "./hooks/useAgentTurn";
import { useNexa } from "./hooks/useNexa";
import { useSession } from "./hooks/useSession";
import { useEditor } from "./hooks/useEditor";
import { useFiles } from "./hooks/useFiles";
import { useProvider } from "./hooks/useProvider";
import { useWorktree } from "./hooks/useWorktree";
import { useShell } from "./hooks/useShell";
import { usePrefs } from "./hooks/usePrefs";
import { useSkills } from "./hooks/useSkills";
import { useWorkspace, useLaneFollow } from "./hooks/useWorkspace";
import { useInit } from "./hooks/useInit";
import { useRoutines } from "./hooks/useRoutines";

export default function App() {
  const [auditNote, setAuditNote] = useState("");
  const { themeId, setThemeId, theme, leftW, rightW, onResizerDown } = usePrefs();

  const {
    lanes,
    setLanes,
    activeId,
    setActiveId,
    activeIdRef,
    lane,
    laneBusy,
    busyLanes,
    setLaneBusy,
    unseen,
    setUnseen,
    turnAborts,
    streamRafs,
    pendingTools,
    setPendingTools,
    resolveHead,
    updateLane,
    logAudit,
    stopTurn,
    flushStreamFrame,
    laneName,
    addLane,
    isolateLane,
    closeLane,
  } = useLanes();

  // Per-lane UI: each lane remembers its own center tab, side tab, chat
  // draft and preview URL - switching lanes restores the lane as left.
  const centerTab = lane.centerTab;
  const setCenterTab = (t: CenterTab) =>
    updateLane(lane.id, (l) => (l.centerTab === t ? l : { ...l, centerTab: t }));
  const sideTab = lane.sideTab;
  const setSideTab = (t: SideTab) =>
    updateLane(lane.id, (l) => (l.sideTab === t ? l : { ...l, sideTab: t }));
  const input = lane.chatDraft;
  const setInput = (v: string) =>
    updateLane(lane.id, (l) => (l.chatDraft === v ? l : { ...l, chatDraft: v }));

  const {
    workspaceRoot,
    setWorkspaceRoot,
    cwd,
    setCwdState,
    setCwd,
    files,
    refreshFiles,
    wsCommitted,
  } = useWorkspace({ laneId: lane.id, updateLane });

  const {
    provHist,
    provModels,
    modelsNote,
    keychainOk,
    rememberProvider,
    refreshModels,
    editCfg,
    setEditCfg,
  } = useProvider({ lane, updateLane });

  const {
    branch: gitBranch,
    files: gitFiles,
    sel: gitSel,
    diffText: gitDiffText,
    logList: gitLogList,
    msg: gitMsg,
    setMsg: setGitMsg,
    note: gitNote,
    setNote: setGitNote,
    commitMsg,
    setCommitMsg,
    refreshGit,
    selectGitFile,
    commitListed,
  } = useGit({
    getRoot: () => lane.cwd || cwd,
    laneId: lane.id,
    logAudit,
  });

  const {
    skills,
    conventions,
    conventionsName,
    refreshSkills,
    loadConventions,
    createSkill,
  } = useSkills({
    workspaceRoot,
    lane,
    updateLane,
    // Resolved when createSkill runs (event time), after useEditor below.
    openFile: (path: string) => openFile(path),
  });

  const {
    openPath,
    setOpenPath,
    tabs,
    buffers,
    originals,
    editorText,
    originalText,
    setEditorText,
    shellH,
    ptyH,
    onHResizerDown,
    previewDoc,
    previewUrl,
    setPreviewUrl,
    openFile,
    closeTab,
    retargetTabs,
    dropTabsUnder,
    saveFile,
    approveDiff,
    approveAndCommit,
  } = useEditor({
    lane,
    setLanes,
    updateLane,
    workspaceRoot,
    cwd,
    centerTab,
    setCenterTab,
    refreshFiles,
    refreshGit,
    refreshSkills,
    commitMsg,
    setCommitMsg,
    logAudit,
  });

  const {
    creating,
    setCreating,
    renaming,
    setRenaming,
    createEntry,
    doRename,
    doDelete,
  } = useFiles({
    cwd,
    workspaceRoot,
    lane,
    updateLane,
    refreshFiles,
    openFile,
    retargetTabs,
    dropTabsUnder,
  });

  const { leaveWorktree, mergeWorktree } = useWorktree({
    lane,
    workspaceRoot,
    updateLane,
    setCwdState,
    refreshFiles,
    refreshGit,
    logAudit,
  });

  const { shellCmd, onShellCmdChange, runShell } = useShell({
    lane,
    cwd,
    setLanes,
    setLaneBusy,
    updateLane,
  });


  // Chat autoscroll: stick to bottom on new/streamed messages, unless the user
  // scrolled up to read history (then show a jump button instead of yanking).
  const msgsRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const scrollMsgsToBottom = useCallback((smooth = false) => {
    const el = msgsRef.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Switching lanes follows that lane's directory in the file tree and
  // keeps its PTY in that directory (see useLaneFollow). Here: re-stick
  // chat to the newly active lane's latest message.
  const prevLaneId = useRef(activeId);
  useEffect(() => {
    if (prevLaneId.current === activeId) return;
    prevLaneId.current = activeId;
    // New lane, new conversation: re-stick chat to the latest message.
    stickBottom.current = true;
    setShowJump(false);
  }, [activeId]);
  useLaneFollow({ activeId, laneId: lane.id, laneCwd: lane.cwd, cwd, workspaceRoot, setCwdState });

  // ---- Routines: scheduled agent runs, one dedicated lane each ----
  // Stored per-project in .nexa/routines.json. The 30s ticker fires at most
  // one due routine per tick (backpressure for local models).
  const {
    padText,
    setPadText,
    planText,
    setPlanText,
    memoryText,
    setMemoryText,
    nexaState,
    setNexaState,
    nexaReady,
    lastSynced,
    loadNexa,
  } = useNexa({ workspaceRoot });

  const { expandSkill, runAgentTurn } = useAgentTurn({
    lanes,
    lane,
    workspaceRoot,
    conventions,
    conventionsName,
    skills,
    provHistLength: provHist.length,
    busyLanes,
    activeIdRef,
    turnAborts,
    streamRafs,
    stickBottom,
    lastSynced,
    updateLane,
    setLaneBusy,
    logAudit,
    rememberProvider,
    setUnseen,
    setPendingTools,
    setCenterTab,
    setPadText,
    setPlanText,
    setMemoryText,
    setNexaState,
    setShowJump,
    flushStreamFrame,
  });

  const { saveSessionNow, loadSession, sessionReady } = useSession({
    lanes,
    activeId,
    workspaceRoot,
    setLanes,
    setActiveId,
    setCwdState,
    updateLane,
  });

  const {
    routines,
    persistRoutines,
    loadRoutines,
    addRoutine,
    runRoutine,
    routinesReady,
    showRoutines,
    setShowRoutines,
    newRoutine,
    setNewRoutine,
  } = useRoutines({
    lanes,
    workspaceRoot,
    cwd,
    busyLanes,
    runAgentTurn,
    addLane,
    isolateLane,
    inheritProvider: lane.provider,
  });

  const { changeWorkspace, browseWorkspace } = useInit({
    laneId: lane.id,
    workspaceRoot,
    wsCommitted,
    nexaReady,
    sessionReady,
    routinesReady,
    setWorkspaceRoot,
    setCwdState,
    setLanes,
    setOpenPath,
    updateLane,
    saveSessionNow,
    loadSession,
    loadNexa,
    loadRoutines,
    refreshSkills,
    loadConventions,
  });

  useEffect(() => {
    refreshFiles(cwd, lane?.id);
  }, [cwd, lane?.id, refreshFiles]);

  // Scroll after paint (rAF): layout (flex/scrollHeight) is settled then.
  useLayoutEffect(() => {
    if (sideTab !== "chat") return;
    if (!stickBottom.current) return;
    const raf = requestAnimationFrame(() => scrollMsgsToBottom());
    return () => cancelAnimationFrame(raf);
  }, [lane.messages, lane.id, sideTab, busyLanes, scrollMsgsToBottom]);

  // Git tab: refresh status when opened, when the lane changes, or when
  // the lane cwd changes (fresh data over the restored per-lane cache).
  useEffect(() => {
    if (centerTab !== "git") return;
    refreshGit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerTab, lane.id, lane.cwd]);

  async function sendChat() {
    if (!input.trim() || busyLanes[activeId]) return;
    const text = input;
    setInput("");
    runAgentTurn(activeId, await expandSkill(text));
  }

  // Scheduler: every 30s, fire the single most-overdue routine (at most one
  // per tick - backpressure for local models). Also catches overdue runs
  // shortly after startup.
  useEffect(() => {
    if (!routinesReady.current || !workspaceRoot) return;
    const tick = () => {
      const now = Date.now();
      const due = routines
        .filter((r) => r.enabled && r.everyMs > 0 && (r.nextRun ?? 0) <= now)
        .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))[0];
      if (due) runRoutine(due);
    };
    const interval = setInterval(tick, 30_000);
    const once = setTimeout(tick, 10_000);
    return () => {
      clearInterval(interval);
      clearTimeout(once);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routines, lanes, busyLanes, workspaceRoot, padText, planText, memoryText]);

  return (
    <div className="shell">
      {showRoutines && (
        <RoutinesModal
          routines={routines}
          newRoutine={newRoutine}
          setNewRoutine={setNewRoutine}
          persistRoutines={persistRoutines}
          addRoutine={addRoutine}
          runRoutine={runRoutine}
          onClose={() => setShowRoutines(false)}
        />
      )}
      <ApprovalModal
        queue={pendingTools}
        laneName={laneName}
        onResolve={resolveHead}
      />
      <TopBar
        lanes={lanes}
        activeLaneId={lane.id}
        busyLanes={busyLanes}
        unseen={unseen}
        scheduledCount={routines.filter((r) => r.enabled && r.everyMs > 0).length}
        themeId={themeId}
        onSelectLane={setActiveId}
        onAddLane={() => {
          const id = addLane(workspaceRoot, cwd, lane.provider);
          void isolateLane(id, workspaceRoot);
        }}
        onOpenRoutines={() => setShowRoutines(true)}
        onThemeChange={setThemeId}
        onCloseLane={(id) => closeLane(id, workspaceRoot)}
      />
      <ProviderBar
        laneName={lane.name}
        editCfg={editCfg}
        provHist={provHist}
        provModels={provModels}
        modelsNote={modelsNote}
        keychainOk={keychainOk}
        setEditCfg={setEditCfg}
        refreshModels={refreshModels}
      />
      <WorkspaceBar
        workspaceRoot={workspaceRoot}
        setWorkspaceRoot={setWorkspaceRoot}
        changeWorkspace={changeWorkspace}
        browseWorkspace={browseWorkspace}
        cwd={cwd}
        setCwd={setCwd}
      />
      <div className="main">
        <FileTree
          cwd={cwd}
          workspaceRoot={workspaceRoot}
          files={files}
          creating={creating}
          renaming={renaming}
          skills={skills}
          conventionsName={conventionsName}
          width={leftW}
          setCreating={setCreating}
          setRenaming={setRenaming}
          setCwd={setCwd}
          openFile={openFile}
          createEntry={createEntry}
          doRename={doRename}
          doDelete={doDelete}
          createSkill={createSkill}
          setInput={setInput}
          setSideTab={setSideTab}
        />
        <div className="resizer" onMouseDown={onResizerDown("left")} title="Drag to resize panels" />

        <EditorPane
          lane={lane}
          lanes={lanes}
          laneBusy={laneBusy}
          openPath={openPath}
          tabs={tabs}
          buffers={buffers}
          originals={originals}
          editorText={editorText}
          originalText={originalText}
          setEditorText={setEditorText}
          monacoTheme={theme.monaco}
          centerTab={centerTab}
          setCenterTab={setCenterTab}
          gitCount={gitFiles.length}
          gitPane={
            <GitPane
              branch={gitBranch}
              files={gitFiles}
              sel={gitSel}
              diffText={gitDiffText}
              logList={gitLogList}
              msg={gitMsg}
              setMsg={setGitMsg}
              note={gitNote}
              setNote={setGitNote}
              laneCwd={lane.cwd}
              fallbackCwd={cwd}
              refreshGit={refreshGit}
              selectGitFile={selectGitFile}
              commitListed={commitListed}
            />
          }
          previewUrl={previewUrl}
          setPreviewUrl={setPreviewUrl}
          previewDoc={previewDoc}
          openFile={openFile}
          closeTab={closeTab}
          saveFile={saveFile}
          leaveWorktree={leaveWorktree}
          mergeWorktree={mergeWorktree}
          commitMsg={commitMsg}
          setCommitMsg={setCommitMsg}
          approveDiff={approveDiff}
          approveAndCommit={approveAndCommit}
          onRejectDiff={() => updateLane(lane.id, (l) => ({ ...l, pendingDiff: null }))}
          shellCmd={shellCmd}
          onShellCmdChange={onShellCmdChange}
          runShell={runShell}
          shellH={shellH}
          ptyH={ptyH}
          themeId={themeId}
          onHResizerDown={onHResizerDown}
        />
        <div className="resizer" onMouseDown={onResizerDown("right")} title="Drag to resize panels" />

        <ChatPane
          lane={lane}
          laneBusy={laneBusy}
          sideTab={sideTab}
          setSideTab={setSideTab}
          width={rightW}
          msgsRef={msgsRef}
          stickBottom={stickBottom}
          showJump={showJump}
          setShowJump={setShowJump}
          scrollMsgsToBottom={scrollMsgsToBottom}
          input={input}
          setInput={setInput}
          sendChat={sendChat}
          stopTurn={stopTurn}
          padText={padText}
          setPadText={setPadText}
          planText={planText}
          setPlanText={setPlanText}
          memoryText={memoryText}
          setMemoryText={setMemoryText}
          nexaState={nexaState}
          auditNote={auditNote}
          setAuditNote={setAuditNote}
        />
      </div>
    </div>
  );
}
