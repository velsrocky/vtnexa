import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_VERSION, provisionNode, replaceDirectoryAtomically } from "./provision-node.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(projectRoot, "sidecar", "browser");
const stageRoot = join(projectRoot, "src-tauri", "sidecar-stage");
const dst = join(stageRoot, "browser");
const cacheDir = join(projectRoot, ".cache", "node-runtime", NODE_VERSION);
const nodeModules = join(src, "node_modules");

mkdirSync(stageRoot, { recursive: true });
let candidate = mkdtempSync(join(stageRoot, ".browser-stage-"));
try {
  const runtime = await provisionNode({ stageDir: candidate, cacheDir });
  for (const file of ["server.js", "runtime.js", "package.json"]) {
    cpSync(join(src, file), join(candidate, file));
  }
  try {
    cpSync(nodeModules, join(candidate, "node_modules"), { recursive: true, dereference: true });
  } catch (error) {
    console.error(`stage-sidecar: ${nodeModules} missing or unreadable (${error.code ?? error}).`);
    console.error("Run: cd sidecar/browser && pnpm install --prod --ignore-scripts");
    throw new Error("sidecar dependencies are unavailable");
  }
  await replaceDirectoryAtomically(candidate, dst);
  candidate = null;
  console.log(`stage-sidecar: staged into ${dst} (Node ${runtime.descriptor.key}, archive-backed)`);
} catch (error) {
  console.error(`stage-sidecar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (candidate) rmSync(candidate, { recursive: true, force: true });
}
