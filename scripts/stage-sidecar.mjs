// Cross-platform staging of the browser sidecar into the Tauri resources
// (replaces the POSIX rm/cp script: CI builds Windows/macOS/Linux too).
// Usage: node scripts/stage-sidecar.mjs
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const src = "sidecar/browser";
const dst = join("src-tauri", "sidecar-stage", "browser");

rmSync(join("src-tauri", "sidecar-stage"), { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const f of ["server.js", "package.json"]) {
  cpSync(join(src, f), join(dst, f));
}
const nm = join(src, "node_modules");
try {
  // dereference = true: pnpm's symlinked store must be flattened for bundling.
  cpSync(nm, join(dst, "node_modules"), { recursive: true, dereference: true });
} catch (e) {
  console.error(`stage-sidecar: ${nm} missing or unreadable (${e.code ?? e}).`);
  console.error("Run: cd sidecar/browser && pnpm install --prod --ignore-scripts");
  process.exit(1);
}
console.log(`stage-sidecar: staged into ${dst}`);
