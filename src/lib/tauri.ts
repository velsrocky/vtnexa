import { invoke } from "@tauri-apps/api/core";
import type { Approval } from "./approval";
import type { FileEntry } from "../types";

function approvalArgs(a?: Approval): { approvalToken: string | null; approvalDetail: string | null } {
  return { approvalToken: a?.token ?? null, approvalDetail: a?.detail ?? null };
}

export async function fsList(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("fs_list", { path });
}

export async function fsRead(path: string): Promise<string> {
  return invoke<string>("fs_read", { path });
}

export async function fsWrite(path: string, content: string, approval?: Approval): Promise<void> {
  return invoke<void>("fs_write", { path, content, ...approvalArgs(approval) });
}

export async function fsCreate(path: string, isDir?: boolean): Promise<string> {
  return invoke<string>("fs_create", { path, is_dir: isDir ?? false });
}

export async function fsRename(oldPath: string, newPath: string, approval?: Approval): Promise<string> {
  return invoke<string>("fs_rename", {
    old_path: oldPath,
    new_path: newPath,
    ...approvalArgs(approval),
  });
}

export async function fsDelete(path: string, recursive?: boolean, approval?: Approval): Promise<void> {
  return invoke<void>("fs_delete", {
    path,
    recursive: recursive ?? false,
    ...approvalArgs(approval),
  });
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

export async function gitCommit(
  cwd: string,
  message: string,
  files?: string[],
  approval?: Approval,
): Promise<GitCommitOut> {
  return invoke<GitCommitOut>("git_commit", {
    cwd,
    message,
    files: files ?? null,
    ...approvalArgs(approval),
  });
}

export async function gitLog(cwd: string, limit?: number): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>("git_log", { cwd, limit: limit ?? null });
}

export async function gitInit(cwd: string): Promise<string> {
  return invoke<string>("git_init", { cwd });
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function shellRun(cwd: string, cmd: string, approval?: Approval): Promise<ShellResult> {
  // Tauri v2 binds args camelCase: the Rust `approval_token`/`approval_detail`
  // params MUST be sent as approvalToken/approvalDetail (snake_case here
  // silently fails the whole command with "missing required key"). The
  // backend takes plain Strings, so send "" (never null) when unapproved.
  return invoke<ShellResult>("shell_run", {
    cwd,
    cmd,
    approvalToken: approval?.token ?? "",
    approvalDetail: approval?.detail ?? "",
  });
}

export interface ShellPoll {
  status: string;
  code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  elapsed_ms: number;
}

export async function shellBg(cwd: string, cmd: string, approval?: Approval): Promise<string> {
  return invoke<string>("shell_bg", { cwd, cmd, ...approvalArgs(approval) });
}

export async function shellPoll(id: string): Promise<ShellPoll> {
  return invoke<ShellPoll>("shell_poll", { id });
}

export async function shellKill(id: string, approval?: Approval): Promise<string> {
  return invoke<string>("shell_kill", { id, ...approvalArgs(approval) });
}

export async function lspDiagnostics(path: string, approval?: Approval): Promise<string> {
  return invoke<string>("lsp_diagnostics", { path, ...approvalArgs(approval) });
}

export interface LspOpArgs {
  op: string;
  path: string;
  line?: number;
  character?: number;
  symbol?: string;
  approval?: Approval;
}

export async function lspOp(args: LspOpArgs): Promise<string> {
  return invoke<string>("lsp_op", {
    op: args.op,
    path: args.path,
    line: args.line ?? null,
    character: args.character ?? null,
    symbol: args.symbol ?? null,
    ...approvalArgs(args.approval),
  });
}

export async function workspaceRoot(): Promise<string> {
  return invoke<string>("workspace_root");
}

export async function setWorkspaceRoot(path: string, confirmDangerous?: boolean): Promise<string> {
  return invoke<string>("set_workspace_root", { path, confirm_dangerous: confirmDangerous ?? null });
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
