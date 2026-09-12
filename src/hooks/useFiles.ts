import { useState } from "react";
import type { Lane } from "../types";
import { fsCreate, fsDelete, fsRename } from "../lib/tauri";
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
  lane: Lane;
  updateLane: (id: string, fn: (l: Lane) => Lane) => void;
  refreshFiles: (dir: string, laneId?: string) => Promise<void>;
  openFile: (path: string) => void;
  retargetTabs: (oldP: string, newP: string) => void;
  dropTabsUnder: (path: string) => void;
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
      opts.updateLane(opts.lane.id, (l) => ({ ...l, shellOut: l.shellOut + `\ncreate failed: ${e}` }));
    }
  }

  async function doRename() {
    if (!renaming) return;
    const name = renaming.name.trim().split("/").pop() ?? "";
    if (!name || name === baseName(renaming.path)) {
      setRenaming(null);
      return;
    }
    const target = dirName(renaming.path) + "/" + name;
    try {
      await fsRename(renaming.path, target);
      opts.retargetTabs(renaming.path, target);
      setRenaming(null);
      opts.refreshFiles(opts.cwd);
    } catch (e) {
      opts.updateLane(opts.lane.id, (l) => ({ ...l, shellOut: l.shellOut + `\nrename failed: ${e}` }));
    }
  }

  async function doDelete(path: string, isDir: boolean) {
    if (!window.confirm(`Permanently delete ${baseName(path)}${isDir ? " and everything inside it" : ""}?`)) return;
    try {
      await fsDelete(path, isDir);
      opts.dropTabsUnder(path);
      opts.refreshFiles(opts.cwd);
      opts.updateLane(opts.lane.id, (l) => ({ ...l, shellOut: l.shellOut + `\n✓ deleted ${path}` }));
    } catch (e) {
      opts.updateLane(opts.lane.id, (l) => ({ ...l, shellOut: l.shellOut + `\ndelete failed: ${e}` }));
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
