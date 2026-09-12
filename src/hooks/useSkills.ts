import { useState } from "react";
import type { SkillInfo, Workspace } from "../types";
import { fsRead, fsWrite, skillList } from "../lib/tauri";

// Project skills (.vtnexa/skills/*.md) + conventions (AGENTS.md/CLAUDE.md).
// The agent loads skill bodies on demand; conventions ride every turn.
export function useSkills(opts: {
  workspaceRoot: string;
  updateWs: (fn: (w: Workspace) => Workspace) => void;
  openFile: (path: string) => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [conventions, setConventions] = useState("");
  const [conventionsName, setConventionsName] = useState("");

  async function refreshSkills() {
    try {
      setSkills(await skillList());
    } catch {
      setSkills([]);
    }
  }

  async function loadConventions(root: string) {
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const text = await fsRead(`${root.replace(/\/$/, "")}/${f}`);
        if (text.trim()) {
          setConventionsName(f);
          setConventions(text.slice(0, 8000));
          return;
        }
      } catch {
        /* try next */
      }
    }
    setConventionsName("");
    setConventions("");
  }

  async function createSkill() {
    const raw = window.prompt("Skill name (letters, numbers, -, _):");
    if (!raw) return;
    const name = raw.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\ninvalid skill name` }));
      return;
    }
    if (!opts.workspaceRoot) return;
    try {
      const path = `${opts.workspaceRoot.replace(/\/$/, "")}/.vtnexa/skills/${name}.md`;
      await fsWrite(path, `# ${name}\n\nOne-line description of when to use this skill.\n\nInstructions for the agent...\n`);
      await refreshSkills();
      opts.openFile(path);
    } catch (e) {
      opts.updateWs((w) => ({ ...w, shellOut: w.shellOut + `\nskill create failed: ${e}` }));
    }
  }

  return {
    skills,
    conventions,
    conventionsName,
    refreshSkills,
    loadConventions,
    createSkill,
  };
}
