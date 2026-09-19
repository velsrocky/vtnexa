import { createContext, useContext } from "react";
import type { ProviderConfig } from "../types";
import type { ThemeId } from "../lib/theme";
import type { ProviderEntry } from "../lib/providerHistory";
import type { SessionMeta } from "../lib/tauri";

/** Bar-level slices, fed by App and consumed via the hooks below.
 *  Phase 1 of the prop-drilling cleanup: TopBar / ProviderBar / WorkspaceBar /
 *  SessionBar read from context instead of ~30 threaded props. The ws-heavy
 *  panes (ChatPane, EditorPane, FileTree) stay on props until selector-shaped
 *  stores land — they re-render on every stream token and need memo boundaries
 *  first, not just a different pipe. */
export interface TopBarSlice {
  workspaceLabel: string;
  windowLabel: string;
  scheduledCount: number;
  mcpOn: boolean;
  mcpTools: number;
  themeId: ThemeId;
  onOpenRoutines: () => void;
  onOpenMcp: () => void;
  onOpenSettings: () => void;
  onThemeChange: (id: ThemeId) => void;
}

export interface ProviderBarSlice {
  windowLabel: string;
  editCfg: ProviderConfig;
  provHist: ProviderEntry[];
  provModels: string[];
  modelsNote: string;
  keychainOk: boolean | null;
  setEditCfg: (patch: Partial<ProviderConfig>) => void;
  refreshModels: () => void;
}

export interface WorkspaceBarSlice {
  workspaceRoot: string;
  setWorkspaceRoot: (v: string) => void;
  changeWorkspace: (v: string) => void;
  browseWorkspace: () => void;
  cwd: string;
  setCwd: (v: string) => void;
}

export interface SessionBarSlice {
  sessions: SessionMeta[];
  currentId: string;
  currentTitle: string;
  busy: boolean;
  onNew: () => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

export interface AppContextValue {
  top: TopBarSlice;
  provider: ProviderBarSlice;
  workspace: WorkspaceBarSlice;
  session: SessionBarSlice;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppContextProvider({
  value,
  children,
}: {
  value: AppContextValue;
  children: React.ReactNode;
}) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useSlice<K extends keyof AppContextValue>(key: K): AppContextValue[K] {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error(`AppContext: ${key} bar rendered outside AppContextProvider`);
  return ctx[key];
}

export const useTopBar = () => useSlice("top");
export const useProviderBar = () => useSlice("provider");
export const useWorkspaceBar = () => useSlice("workspace");
export const useSessionBar = () => useSlice("session");
