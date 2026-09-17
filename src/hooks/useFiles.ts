import { useState } from "react";
import type { UndoEntry, Workspace } from "../types";
import { fsCreate, fsDelete, fsRead, fsRename } from "../lib/tauri";
import { claimFor } from "../lib/approval";
import { baseName, dirName } from "../lib/utils";

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
}) {
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);

  async function createEntry() {
    if (!creating) return;
    const name = creating.name.trim().replace(/^\/+/, "");
    if (!name) {
      setCreating(null);
      return;
    }
    const parent = opts.cwd || opts.workspaceRoot;
    if (!parent) return;
    const target = parent.replace(/\/$/, "") + "/" + name;
    try {
      await fsCreate(target, creating.isDir);
      setCreating(null);
      opts.refreshFiles(opts.cwd);
      if (!creating.isDir) opts.openFile(target);
    } catch (e) {
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\ncreate failed: ${e}` }));
    }
  }

  async function doRename() {
    if (!renaming) return;
    const name = renaming.name.trim().replace(/^\/+/, "").split("/").pop() ?? "";
    if (!name || name === baseName(renaming.path)) {
      setRenaming(null);
      return;
    }
    const target = dirName(renaming.path) + "/" + name;
    try {
      await fsRename(renaming.path, target, await claimFor("fs_rename", { old_path: renaming.path, new_path: target }));
      opts.pushUndo({ kind: "rename", oldPath: renaming.path, newPath: target });
      opts.retargetTabs(renaming.path, target);
      setRenaming(null);
      opts.refreshFiles(opts.cwd);
    } catch (e) {
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nrename failed: ${e}` }));
    }
  }

  async function doDelete(path: string, isDir: boolean) {
    if (!window.confirm(`Permanently delete ${baseName(path)}${isDir ? " and everything inside it" : ""}?`)) return;
    // Snapshot file content for /undo (directory trees are out of scope).
    let content: string | null = null;
    if (!isDir) {
      try {
        content = await fsRead(path);
      } catch {
        content = null;
      }
    }
    try {
      await fsDelete(path, isDir, await claimFor("fs_delete", { path }));
      if (content !== null) opts.pushUndo({ kind: "delete", path, content });
      opts.dropTabsUnder(path);
      opts.refreshFiles(opts.cwd);
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\n✓ deleted ${path}` }));
    } catch (e) {
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\ndelete failed: ${e}` }));
    }
  }

  return {
    creating,
    setCreating,
    renaming,
    setRenaming,
    createEntry,
    doRename,
    doDelete,
  };
}
