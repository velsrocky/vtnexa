// Copy Monaco's minified editor into public/vs (served, not bundled).
import { cpSync, rmSync } from "node:fs";

rmSync("public/vs", { recursive: true, force: true });
cpSync("node_modules/monaco-editor/min/vs", "public/vs", { recursive: true });
console.log("sync-monaco: public/vs updated");
