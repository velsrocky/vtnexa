import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../types";

export async function fsList(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("fs_list", { path });
}

export async function fsRead(path: string): Promise<string> {
  return invoke<string>("fs_read", { path });
}

export async function fsWrite(path: string, content: string): Promise<void> {
  return invoke<void>("fs_write", { path, content });
}

export async function fsCreate(path: string, isDir?: boolean): Promise<string> {
  return invoke<string>("fs_create", { path, is_dir: isDir ?? false });
}

export async function fsRename(oldPath: string, newPath: string): Promise<string> {
  return invoke<string>("fs_rename", { old_path: oldPath, new_path: newPath });
}

export async function fsDelete(path: string, recursive?: boolean): Promise<void> {
  return invoke<void>("fs_delete", { path, recursive: recursive ?? false });
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export async function fsSearch(
  query: string,
  path?: string,
  glob?: string,
  caseSensitive?: boolean,
  regex?: boolean,
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("fs_search", {
    query,
    path: path ?? null,
    glob: glob ?? null,
    caseSensitive: caseSensitive ?? false,
    regex: regex ?? false,
  });
}

export async function fsGlob(pattern: string, path?: string): Promise<string[]> {
  return invoke<string[]>("fs_glob", { pattern, path: path ?? null });
}

export interface GitFile {
  path: string;
  status: string;
}

export interface GitStatus {
  branch: string;
  root: string;
  files: GitFile[];
}

export interface GitCommitOut {
  hash: string;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { cwd });
}

export async function gitDiff(cwd: string, path?: string, staged?: boolean): Promise<string> {
  return invoke<string>("git_diff", { cwd, path: path ?? null, staged: staged ?? false });
}

export async function gitCommit(cwd: string, message: string, files?: string[]): Promise<GitCommitOut> {
  return invoke<GitCommitOut>("git_commit", { cwd, message, files: files ?? null });
}

export async function gitLog(cwd: string, limit?: number): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>("git_log", { cwd, limit: limit ?? null });
}

export async function gitInit(cwd: string): Promise<string> {
  return invoke<string>("git_init", { cwd });
}

export interface GitMergeOut {
  output: string;
}

export async function gitMerge(cwd: string, branch: string): Promise<GitMergeOut> {
  return invoke<GitMergeOut>("git_merge", { cwd, branch });
}

export interface GitWorktree {
  path: string;
  branch: string;
}

export async function gitWorktreeAdd(cwd: string, name: string): Promise<GitWorktree> {
  return invoke<GitWorktree>("git_worktree_add", { cwd, name });
}

export async function gitWorktreeRemove(cwd: string, path: string): Promise<void> {
  await invoke("git_worktree_remove", { cwd, path });
}

export async function gitWorktreeList(cwd: string): Promise<GitWorktree[]> {
  return invoke<GitWorktree[]>("git_worktree_list", { cwd });
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function shellRun(cwd: string, cmd: string): Promise<ShellResult> {
  return invoke<ShellResult>("shell_run", { cwd, cmd });
}

export async function lspDiagnostics(path: string): Promise<string> {
  return invoke<string>("lsp_diagnostics", { path });
}

export async function workspaceRoot(): Promise<string> {
  return invoke<string>("workspace_root");
}

export async function setWorkspaceRoot(path: string): Promise<string> {
  return invoke<string>("set_workspace_root", { path });
}

export type NexaKind = "pad" | "plan" | "memory";

export async function nexaRead(kind: NexaKind): Promise<string> {
  return invoke<string>("nexa_read", { kind });
}

export async function nexaWrite(kind: NexaKind, content: string): Promise<void> {
  return invoke<void>("nexa_write", { kind, content });
}

export async function sessionLoad(): Promise<string> {
  return invoke<string>("session_load");
}

export async function sessionSave(content: string): Promise<void> {
  return invoke<void>("session_save", { content });
}

// ---- Named sessions (.nexa/sessions/<id>.json) ----
// OpenCode-style: many sessions per directory, newest-first, explicit resume.
// The legacy single session.json above is kept as a backup and is no longer
// part of the new flow.
export interface SessionMeta {
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
  message_count: number;
  preview: string;
}

export async function sessionsList(): Promise<SessionMeta[]> {
  const raw = await invoke<string>("sessions_list");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return (parsed as SessionMeta[]).filter((s) => s && typeof s.id === "string");
}

export async function sessionGet(id: string): Promise<string> {
  return invoke<string>("session_get", { id });
}

export async function sessionPut(id: string, content: string): Promise<void> {
  await invoke<void>("session_put", { id, content });
}

export async function sessionDelete(id: string): Promise<void> {
  await invoke<void>("session_delete", { id });
}

export async function routinesLoad(): Promise<string> {
  return invoke<string>("routines_load");
}

export async function routinesSave(content: string): Promise<void> {
  return invoke<void>("routines_save", { content });
}

export interface SkillInfo {
  name: string;
  description: string;
}

export async function skillList(): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("skill_list");
}

export async function skillRead(name: string): Promise<string> {
  return invoke<string>("skill_read", { name });
}

// OS keychain for provider API keys. Throws when no credential store is
// available — callers fall back to their local copy.
export async function keyGet(baseUrl: string, model: string): Promise<string> {
  return invoke<string>("key_get", { baseUrl, model });
}

export async function keySet(baseUrl: string, model: string, secret: string): Promise<void> {
  return invoke<void>("key_set", { baseUrl, model, secret });
}
