// Mirror skill docs into the Tauri resource dir (flattened for bundling).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const src = ".vtnexa/skills";
const dst = join("src-tauri", ".vtnexa", "skills");

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
let n = 0;
if (existsSync(src)) {
  for (const f of readdirSync(src)) {
    if (f.endsWith(".md")) {
      copyFileSync(join(src, f), join(dst, f));
      n++;
    }
  }
}
console.log(`sync-skills: ${n} skill doc(s) mirrored to ${dst}`);
