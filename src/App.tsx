import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loader } from "@monaco-editor/react";
if (import.meta.env.MODE === "development") {
  loader.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.56.0/min/vs" } });
} else {
  loader.config({ paths: { vs: "/vs" } });
}
import "./App.css";
import type { CenterTab, SideTab } from "./types";
import RoutinesModal from "./components/RoutinesModal";
import McpModal from "./components/McpModal";
import GitPane from "./components/GitPane";
import FileTree from "./components/FileTree";
import ChatPane from "./components/ChatPane";
import EditorPane from "./components/EditorPane";
import TopBar from "./components/TopBar";
import SettingsModal from "./components/SettingsModal";
import ProviderBar from "./components/ProviderBar";
import WorkspaceBar from "./components/WorkspaceBar";
import SessionBar from "./components/SessionBar";
import { invoke } from "@tauri-apps/api/core";
import { baseName, didExhaustBudget } from "./lib/utils";
import { loadFeedback, rateMessage, ratingMap } from "./lib/feedback";
import { useGit } from "./hooks/useGit";
import { useWorkspaceState, windowLabel, ptyId } from "./hooks/useWorkspaceState";
import { useAgentTurn } from "./hooks/useAgentTurn";
import { useNexa } from "./hooks/useNexa";
import { useSessions } from "./hooks/useSessions";
import { useEditor } from "./hooks/useEditor";
import { useFiles } from "./hooks/useFiles";
import { useProvider } from "./hooks/useProvider";
import { useShell } from "./hooks/useShell";
import { usePrefs } from "./hooks/usePrefs";
import { useSkills } from "./hooks/useSkills";
import { useWorkspace } from "./hooks/useWorkspace";
import { useInit } from "./hooks/useInit";
import { useRoutines } from "./hooks/useRoutines";
import { useMcp } from "./hooks/useMcp";
import { AppContextProvider, type AppContextValue } from "./context/AppContext";

// One OS window = one independent VTNexa instance. Multiple windows are
// siblings: separate workspace roots (enforced per-label in the Rust
// backend), separate PTYs, separate sessions, separate everything.
export default function App() {
  const [auditNote, setAuditNote] = useState("");
  const [ratings, setRatings] = useState<Record<string, 1 | -1>>(() => ratingMap(loadFeedback()));
  const { themeId, setThemeId, theme, leftW, rightW, onResizerDown, skillH, onSkillResizerDown } = usePrefs();
  const [showSettings, setShowSettings] = useState(false);

  const {
    ws,
    setWs,
    busy,
    setBusy,
    turnAbort,
    stopTurnIdRef,
    streamRaf,
    updateWs,
    logAudit,
    stopTurn,
    flushStreamFrame,
  } = useWorkspaceState();

  const centerTab = ws.centerTab;
  const setCenterTab = (t: CenterTab) =>
    updateWs((w) => (w.centerTab === t ? w : { ...w, centerTab: t }));
  const sideTab = ws.sideTab;
  const setSideTab = (t: SideTab) =>
    updateWs((w) => (w.sideTab === t ? w : { ...w, sideTab: t }));
  const input = ws.chatDraft;
  const setInput = (v: string) =>
    updateWs((w) => (w.chatDraft === v ? w : { ...w, chatDraft: v }));

  const {
    workspaceRoot,
    setWorkspaceRoot,
    cwd,
    setCwdState,
    setCwd,
    files,
    refreshFiles,
    wsCommitted,
  } = useWorkspace({ updateWs, ptyId });

  const {
    provHist,
    provModels,
    modelsNote,
    keychainOk,
    rememberProvider,
    refreshModels,
    editCfg,
    setEditCfg,
  } = useProvider({ ws, updateWs });

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
    getRoot: () => ws.cwd || cwd,
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
    updateWs,
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
    pushUndo,
    undo,
    redo,
    canUndo,
    canRedo,
    undoLabel,
  } = useEditor({
    ws,
    setWs,
    updateWs,
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
    updateWs,
    refreshFiles,
    openFile,
    retargetTabs,
    dropTabsUnder,
    pushUndo,
  });

  const { shellCmd, onShellCmdChange, runShell } = useShell({
    ws,
    cwd,
    setBusy,
    updateWs,
  });

  // Chat autoscroll: stick to bottom on new/streamed messages, unless the
  // user scrolled up to read history (then show a jump button).
  const msgsRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const scrollMsgsToBottom = useCallback((smooth = false) => {
    const el = msgsRef.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

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

  // Pre-packed turn context: cheap orientation so the model spends its
  // tool budget on the task, not on discovering cwd/tree/git/memory.
  const repoMap = files
    .slice(0, 40)
    .map((f) => `${f.is_dir ? "dir " : "file "}${f.name}`)
    .join("\n");
  const gitSnapshot = gitBranch
    ? `${gitBranch} · ${gitFiles.length} changed${gitFiles.length ? `: ${gitFiles.slice(0, 10).map((f) => f.path).join(", ")}${gitFiles.length > 10 ? "…" : ""}` : ""}`
    : "";
  const { expandSkill, runAgentTurn } = useAgentTurn({
    ws,
    workspaceRoot,
    conventions,
    conventionsName,
    skills,
    provHistLength: provHist.length,
    memoryText,
    repoMap,
    gitSnapshot,
    openPath,
    busy,
    turnAbort,
    stopTurnIdRef,
    streamRaf,
    stickBottom,
    lastSynced,
    updateWs,
    setBusy,
    logAudit,
    rememberProvider,
    setCenterTab,
    setPadText,
    setPlanText,
    setMemoryText,
    setNexaState,
    setShowJump,
    flushStreamFrame,
    planMode: ws.planMode,
    pushUndo,
  });

  const {
    sessions,
    currentId: sessionId,
    currentTitle: sessionTitle,
    sessionsReady,
    refreshSessions,
    persistCurrent: saveSessionNow,
    newSession,
    resumeSession,
    removeSession,
    bootFresh,
  } = useSessions({
    ws,
    workspaceRoot,
    setWs,
    setCwdState,
    setOpenPath,
    note: (text) => updateWs((w) => ({ ...w, shellOut: w.shellOut + text })),
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
  } = useRoutines({ busy, runAgentTurn });

  const {
    mcpOn,
    setMcpOn,
    servers: mcpServers,
    toolCount: mcpTools,
    errorCount: mcpErrors,
    loading: mcpLoading,
    signingIn: mcpSigningIn,
    note: mcpNote,
    refresh: refreshMcp,
    setServerOn: setMcpServerOn,
    signIn: signInMcp,
    signOut: signOutMcp,
    showMcp,
    setShowMcp,
  } = useMcp({ workspaceRoot });

  const { changeWorkspace, browseWorkspace } = useInit({
    workspaceRoot,
    wsCommitted,
    nexaReady,
    sessionsReady,
    routinesReady,
    setWorkspaceRoot,
    setCwdState,
    setWs,
    setOpenPath,
    updateWs,
    saveSessionNow,
    bootFresh,
    loadNexa,
    loadRoutines,
    refreshSkills,
    loadConventions,
  });

  useEffect(() => {
    refreshFiles(cwd);
  }, [cwd, refreshFiles]);

  // Scroll after paint (rAF): layout (flex/scrollHeight) is settled then.
  useLayoutEffect(() => {
    if (sideTab !== "chat") return;
    if (!stickBottom.current) return;
    const raf = requestAnimationFrame(() => scrollMsgsToBottom());
    return () => cancelAnimationFrame(raf);
  }, [ws.messages, sideTab, busy, scrollMsgsToBottom]);

  // Git tab: refresh status when opened or when the cwd changes.
  useEffect(() => {
    if (centerTab !== "git") return;
    refreshGit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshGit is render-scoped (new identity per render); this effect is event-like (tab/cwd change), not data-driven
  }, [centerTab, ws.cwd]);

  async function sendChat() {
    if (!input.trim() || busy) return;
    const text = input;
    setInput("");
    // Local commands: undo/redo the last captured file op, no agent turn.
    const cmd = text.trim().toLowerCase();
    if (cmd === "/undo") {
      await undo();
      return;
    }
    if (cmd === "/redo") {
      await redo();
      return;
    }
    runAgentTurn(await expandSkill(text));
  }

  // Continue a turn that died of tool budget: fresh rounds over the full
  // history (which already holds every tool result). Transparent user
  // message, not hidden state.
  function continueTurn() {
    if (busy) return;
    runAgentTurn(
      "▶ Continue the task from the tool results above. Do not repeat completed steps; pick up exactly where you stopped. If you are done, say what was accomplished instead of calling more tools.",
    );
  }

  // Ctrl/Cmd+Shift+N: open an independent window (same as the TopBar button;
  // second app launch does this too via the single-instance hook).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        invoke("create_window").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runRoutine is render-scoped; re-subscribing the 30s interval on every render would reset the timer and starve routines
  }, [routines, busy, workspaceRoot, padText, planText, memoryText]);

  // Bar slices for AppContext (phase 1 of the prop-drilling cleanup): the
  // same values previously threaded as ~30 individual props. Memoized so the
  // bars don't re-render on unrelated state (e.g. stream tokens in ws).
  const barCtx: AppContextValue = useMemo(
    () => ({
      top: {
        workspaceLabel: baseName(workspaceRoot),
        windowLabel,
        scheduledCount: routines.filter((r) => r.enabled && r.everyMs > 0).length,
        mcpOn,
        mcpTools,
        themeId,
        onOpenRoutines: () => setShowRoutines(true),
        onOpenMcp: () => setShowMcp(true),
        onOpenSettings: () => setShowSettings(true),
        onThemeChange: setThemeId,
      },
      provider: {
        windowLabel,
        editCfg,
        provHist,
        provModels,
        modelsNote,
        keychainOk,
        setEditCfg,
        refreshModels,
      },
      workspace: {
        workspaceRoot,
        setWorkspaceRoot,
        changeWorkspace,
        browseWorkspace,
        cwd,
        setCwd,
      },
      session: {
        sessions,
        currentId: sessionId,
        currentTitle: sessionTitle,
        busy,
        onNew: () => void newSession(),
        onResume: (id) => void resumeSession(id),
        onDelete: (id) => void removeSession(id),
        onRefresh: () => void refreshSessions(),
      },
    }),
    [
      workspaceRoot,
      routines,
      mcpOn,
      mcpTools,
      themeId,
      editCfg,
      provHist,
      provModels,
      modelsNote,
      keychainOk,
      setEditCfg,
      refreshModels,
      setWorkspaceRoot,
      changeWorkspace,
      browseWorkspace,
      cwd,
      setCwd,
      sessions,
      sessionId,
      sessionTitle,
      busy,
      newSession,
      resumeSession,
      removeSession,
      refreshSessions,
    ],
  );

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
      {showMcp && (
        <McpModal
          mcpOn={mcpOn}
          setMcpOn={(on) => void setMcpOn(on)}
          servers={mcpServers}
          toolCount={mcpTools}
          errorCount={mcpErrors}
          loading={mcpLoading}
          signingIn={mcpSigningIn}
          note={mcpNote}
          onToggleServer={(name, on) => void setMcpServerOn(name, on)}
          onSignIn={(name) => void signInMcp(name)}
          onSignOut={(name) => void signOutMcp(name)}
          onRefresh={() => void refreshMcp()}
          onClose={() => setShowMcp(false)}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
      <AppContextProvider value={barCtx}>
        <TopBar />
        <ProviderBar />
        <WorkspaceBar />
        <SessionBar />
      </AppContextProvider>
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
          skillH={skillH}
          onSkillResizerDown={onSkillResizerDown}
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
          ws={ws}
          ptyId={ptyId}
          busy={busy}
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
              wsCwd={ws.cwd}
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
          commitMsg={commitMsg}
          setCommitMsg={setCommitMsg}
          approveDiff={approveDiff}
          approveAndCommit={approveAndCommit}
          onRejectDiff={() => updateWs((w) => ({ ...w, pendingDiff: null }))}
          undo={() => void undo()}
          redo={() => void redo()}
          canUndo={canUndo}
          canRedo={canRedo}
          undoLabel={undoLabel}
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
          ws={ws}
          busy={busy}
          sideTab={sideTab}
          setSideTab={setSideTab}
          width={rightW}
          skills={skills}
          msgsRef={msgsRef}
          stickBottom={stickBottom}
          showJump={showJump}
          setShowJump={setShowJump}
          scrollMsgsToBottom={scrollMsgsToBottom}
          input={input}
          setInput={setInput}
          sendChat={sendChat}
          stopTurn={stopTurn}
          planMode={ws.planMode}
          onTogglePlan={() => updateWs((w) => ({ ...w, planMode: !w.planMode }))}
          showContinue={didExhaustBudget(ws.messages)}
          onContinue={continueTurn}
          ratings={ratings}
          onRateMessage={(messageId, rating) => {
            const msgs = ws.messages;
            const idx = msgs.findIndex((m) => m.id === messageId);
            const answer = idx >= 0 ? msgs[idx].content : "";
            let prompt = "";
            for (let i = idx - 1; i >= 0; i--) {
              if (msgs[i].role === "user") {
                prompt = msgs[i].content;
                break;
              }
            }
            const next = rateMessage({
              messageId,
              sessionId,
              model: ws.provider.model,
              rating,
              prompt,
              answer,
            });
            setRatings(ratingMap(next));
          }}
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
