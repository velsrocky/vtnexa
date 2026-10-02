import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { OperationState, UndoEntry, Workspace } from "../types";
import { fsCreate, fsDelete, fsRead, fsRename } from "../lib/tauri";
import { claimFor } from "../lib/approval";
import { basenamePath, dirnamePath, joinPath } from "../lib/path";
import { useConfirm } from "../context/ConfirmContext";

export interface CreatingState {
  isDir: boolean;
  name: string;
}

export interface RenamingState {
  path: string;
  name: string;
}

// File-tree mutations: create/rename/delete via the sandboxed backend.
// Tab/buffer retargeting is coordinated through useEditor callbacks.
export function useFiles(opts: {
  cwd: string;
  workspaceRoot: string;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  refreshFiles: (dir: string) => Promise<void>;
  openFile: (path: string) => void;
  retargetTabs: (oldP: string, newP: string) => void;
  dropTabsUnder: (path: string) => void;
  pushUndo: (e: UndoEntry) => void;
  workspaceGenerationRef?: MutableRefObject<number>;
  sessionEpochRef?: MutableRefObject<number>;
}) {
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const activeRef = useRef(false);
  const scopeGeneration = useRef<number | null>(null);
  const scopeSession = useRef<number | null>(null);
  const confirm = useConfirm();

  function sameScope() {
    return (
      (opts.workspaceGenerationRef == null || opts.workspaceGenerationRef.current === scopeGeneration.current) &&
      (opts.sessionEpochRef == null || opts.sessionEpochRef.current === scopeSession.current)
    );
  }

  async function runFileOperation(message: string, operationFn: () => Promise<void>, successMessage: string) {
    if (activeRef.current) return false;
    activeRef.current = true;
    scopeGeneration.current = opts.workspaceGenerationRef?.current ?? null;
    scopeSession.current = opts.sessionEpochRef?.current ?? null;
    setOperation({ status: "pending", message });
    try {
      await operationFn();
      if (!sameScope()) {
        setOperation({ status: "idle" });
        return false;
      }
      setOperation({ status: "success", message: successMessage });
      return true;
    } catch (error) {
      if (sameScope()) setOperation({ status: "error", message: `${message.replace(/…$/, "")} failed: ${error}` });
      else setOperation({ status: "idle" });
      return false;
    } finally {
      activeRef.current = false;
    }
  }

  async function createEntry() {
    if (!creating) return;
    const name = basenamePath(creating.name.trim());
    if (!name || name === "." || name === "..") {
      setCreating(null);
      return;
    }
    const parent = opts.cwd || opts.workspaceRoot;
    if (!parent) return;
    const target = joinPath(parent, name);
    await runFileOperation(
      "Creating file…",
      async () => {
        await fsCreate(target, creating.isDir);
        if (!sameScope()) return;
        setCreating(null);
        await opts.refreshFiles(opts.cwd);
        if (!creating.isDir) opts.openFile(target);
      },
      creating.isDir ? "Folder created." : "File created.",
    );
  }

  async function doRename() {
    if (!renaming) return;
    const name = basenamePath(renaming.name.trim());
    if (!name || name === "." || name === ".." || name === basenamePath(renaming.path)) {
      setRenaming(null);
      return;
    }
    const target = joinPath(dirnamePath(renaming.path), name);
    await runFileOperation(
      "Renaming…",
      async () => {
        await fsRename(renaming.path, target, await claimFor("fs_rename", { old_path: renaming.path, new_path: target }));
        if (!sameScope()) return;
        opts.pushUndo({ kind: "rename", oldPath: renaming.path, newPath: target });
        opts.retargetTabs(renaming.path, target);
        setRenaming(null);
        await opts.refreshFiles(opts.cwd);
      },
      "File renamed.",
    );
  }

  async function doDelete(path: string, isDir: boolean) {
    if (!(await confirm(`Permanently delete ${basenamePath(path)}${isDir ? " and everything inside it" : ""}?`))) return;
    let content: string | null = null;
    if (!isDir) {
      try {
        content = await fsRead(path);
      } catch {
        content = null;
      }
    }
    await runFileOperation(
      "Deleting…",
      async () => {
        await fsDelete(path, isDir, await claimFor("fs_delete", { path }));
        if (!sameScope()) return;
        if (content !== null) opts.pushUndo({ kind: "delete", path, content });
        opts.dropTabsUnder(path);
        await opts.refreshFiles(opts.cwd);
        opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\n✓ deleted ${path}` }));
      },
      "File deleted.",
    );
  }

  return {
    creating,
    setCreating,
    renaming,
    setRenaming,
    createEntry,
    doRename,
    doDelete,
    operation,
    pending: operation.status === "pending",
  };
}
