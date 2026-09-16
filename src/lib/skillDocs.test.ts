import { describe, expect, it } from "vitest";
// @ts-expect-error no @types/node in this repo (see vite.config.ts)
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error no @types/node in this repo (see vite.config.ts)
import { join } from "node:path";

// Contract for bundled skills (.vtnexa/skills/*.md): filename matches the
// `# name` header + one-line description, so skill_list/skill_read and the
// --help text stay truthful. The scaffold skill additionally pins the
// load-bearing rules distilled from real failed scaffolds.
const DIR = ".vtnexa/skills";
const EXPECTED = ["commit", "docs", "explain", "fix", "map", "refactor", "review", "scaffold", "test"];

function read(name: string): string {
  return readFileSync(join(DIR, `${name}.md`), "utf8");
}

describe("bundled skill docs", () => {
  it("ships exactly the documented set with matching headers", () => {
    expect(readdirSync(DIR).filter((f: string) => f.endsWith(".md")).sort()).toEqual(
      EXPECTED.map((n) => `${n}.md`),
    );
    for (const name of EXPECTED) {
      const [header, , description] = read(name).split("\n");
      expect(header).toBe(`# ${name}`);
      expect(description?.trim().length).toBeGreaterThan(0);
    }
  });

  it("scaffold skill pins non-interactive, verifiable creation", () => {
    const doc = read("scaffold");
    for (const marker of [
      "shell_bg", // long work polls instead of timing out
      "non-interactive", // no tty in shell_run, ever
      "no-install", // scaffold and install are separate steps
      "nexa_write", // toolchain facts go to Memory for later turns
      "@fresh", // adopt subdirectory scaffolds into root, never nest silently
      "lsp_diagnostics", // verify before summarizing
    ]) {
      expect(doc).toContain(marker);
    }
  });
});
