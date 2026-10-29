// Opt-in real-model checks. No native UI or native approval claims are made:
// this runs the production TS agent with a temporary-filesystem IPC adapter.
import { createServer } from "vite";
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(join(tmpdir(), "vtnexa-live-validation-"));
const cloud = process.argv.includes("--cloud");
const cancelOnly = process.argv.includes("--cancel-only");
const fullPrompt = process.argv.includes("--full-prompt");
const modelIndex = process.argv.indexOf("--model");
const selectedModel = modelIndex >= 0 ? process.argv[modelIndex + 1] : process.env.VTNEXA_TEST_MODEL;
const taskIndex = process.argv.indexOf("--task");
const taskFilter = taskIndex >= 0 ? process.argv[taskIndex + 1] : null;
const cfg = cloud ? {
  baseUrl: process.env.VTNEXA_TEST_BASE_URL,
  model: selectedModel,
  apiKey: process.env.VTNEXA_TEST_API_KEY,
  kind: process.env.VTNEXA_TEST_KIND ?? "openai",
} : { baseUrl: "http://127.0.0.1:11434/v1", model: selectedModel ?? "qwen2.5-coder:7b", apiKey: "", kind: "ollama" };
if (!cfg.baseUrl || !cfg.model || (cloud && !cfg.apiKey)) throw new Error("Configure VTNEXA_TEST_BASE_URL, VTNEXA_TEST_MODEL, and VTNEXA_TEST_API_KEY for cloud checks. Never put keys in script arguments.");

const tasks = [
  { name: "bug-fix", code: "export function sum(values) { return values.reduce((total, value) => total - value, 0); }\n", tests: "assert.equal(sum([1,2,3]),6); assert.equal(sum([]),0); assert.equal(sum([-2,3]),1);", imports: "sum", prompt: "Fix sum: it currently subtracts instead of adding. Preserve the API and empty-array behavior." },
  { name: "feature", code: "export function sum(values) { return values.reduce((total, value) => total + value, 0); }\n", imports: "sum, average", tests: "assert.equal(sum([1,2]),3); assert.equal(average([2,4,6]),4); assert.equal(average([]),0); assert.equal(average([-2,2]),0);", prompt: "Add an exported average(values) function. Use sum(values) and return 0 for an empty array. Preserve sum." },
  { name: "refactor", code: "export function double(value) { if (!Number.isFinite(value)) throw new TypeError('finite number required'); return value * 2; }\nexport function triple(value) { if (!Number.isFinite(value)) throw new TypeError('finite number required'); return value * 3; }\n", imports: "double, triple", tests: "assert.equal(double(3),6); assert.equal(triple(-2),-6); assert.throws(()=>double(NaN),TypeError); assert.throws(()=>triple(Infinity),TypeError); assert.throws(()=>double('3'),TypeError);", prompt: "Refactor double and triple to share one internal validation helper. Keep the exported API, behavior and error message unchanged. Number.isFinite should appear only once." },
];
if (taskFilter && !tasks.some((task) => task.name === taskFilter)) throw new Error(`Unknown task: ${taskFilter}`);
const server = await createServer({ root: repo, configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
const summary = { startedAt: new Date().toISOString(), scope: `production ${fullPrompt ? "useAgentTurn prompt and orchestration" : "TS agent loop"} + real provider + real fixture files; filesystem IPC adapter, not native GUI`, provider: { ...cfg, apiKey: undefined }, output, tasks: [] };
try {
  const { chatWithTools } = await server.ssrLoadModule("/src/lib/providers.ts");
  if (cancelOnly) {
    const controller = new AbortController();
    let streamed = false;
    let firstChunk = "";
    const started = Date.now();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      await chatWithTools(cfg, [{ role: "user", content: "Write a long story about a lighthouse. Use plain text and do not use tools." }], (text) => {
        if (text.trim() && !/^\s*\[(?:note:|tool )/.test(text) && !streamed) { streamed = true; firstChunk = text.slice(0, 100); controller.abort(); }
      }, { signal: controller.signal, policy: { planMode: true, allowedTools: { skill: "cancellation-check", tools: [] } } });
      summary.cancellation = { passed: false, streamed, error: "request finished without surfacing cancellation" };
    } catch (error) {
      summary.cancellation = { passed: streamed && controller.signal.aborted && error.name === "AbortError", streamed, firstChunk, errorName: error.name, elapsedMs: Date.now() - started };
    } finally { clearTimeout(deadline); }
    try {
      const reply = await chatWithTools(cfg, [{ role: "user", content: "Reply with the single word ready. Do not use tools." }], () => undefined, { signal: AbortSignal.timeout(30_000), policy: { planMode: true, allowedTools: { skill: "cancellation-check", tools: [] } } });
      summary.requestAfterStop = { passed: /\bready\b/i.test(reply) && !reply.includes("Unresolved tool failures"), receivedResponse: !!reply.trim(), reply };
    } catch (error) { summary.requestAfterStop = { passed: false, error: String(error) }; }
  }
  for (const task of cancelOnly ? [] : tasks.filter((item) => !taskFilter || item.name === taskFilter)) {
    const root = await realpath(await mkdtemp(join("/tmp", `nexa-${task.name}-`)));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/math.mjs"), task.code);
    const testSource = `import assert from 'node:assert/strict';\nimport { ${task.imports} } from './src/math.mjs';\n${task.tests}\n`;
    await writeFile(join(root, "math.test.mjs"), testSource);
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    const events = [];
    let transcript = "";
    const tokens = new Set();
    const jobs = new Map();
    let revision = 0;
    let testedRevision = -1;
    const nodeArgs = (command) => {
      const words = command.trim().split(/\s+/);
      if (words[0] !== "node" || !["--test", "--check"].includes(words[1])) throw new Error("fixture runner permits node --test or node --check only");
      for (const file of words.slice(2)) checked(file);
      return words.slice(1);
    };
    const checked = (path) => {
      const absolute = resolve(root, path || ".");
      const rel = relative(root, absolute);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("outside fixture refused");
      return absolute;
    };
    globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
      events.push({ command, path: args.path, at: new Date().toISOString() });
      if (command === "plugin:path|is_absolute") return isAbsolute(args.path);
      if (command === "plugin:path|normalize") return resolve(args.path);
      if (command === "plugin:path|resolve") return resolve(...args.paths);
      if (command === "path_is_within") { try { checked(args.path); return true; } catch { return false; } }
      if (command === "approval_claim") { const token = randomUUID(); tokens.add(token); return token; }
      if (command === "fs_read") return readFile(checked(args.path), "utf8");
      if (command === "fs_list") return Promise.all((await readdir(checked(args.path), { withFileTypes: true })).filter((entry) => entry.name !== ".git").map((entry) => ({ name: entry.name, path: join(checked(args.path), entry.name), is_dir: entry.isDirectory() })));
      if (command === "fs_write") {
        if (!tokens.delete(args.approvalToken)) throw new Error("adapter approval missing");
        if (checked(args.path) !== join(root, "src/math.mjs")) throw new Error("only the implementation fixture may be edited; tests are immutable");
        await writeFile(checked(args.path), args.content);
        revision++;
        return;
      }
      if (command === "shell_run") {
        if (!tokens.delete(args.approvalToken)) throw new Error("adapter approval missing");
        try {
          const commandArgs = nodeArgs(args.cmd);
          const tested = revision;
          const r = await exec(process.execPath, commandArgs, { cwd: root, timeout: 30_000 });
          if (commandArgs[0] === "--test") testedRevision = tested;
          return { ...r, code: 0 };
        }
        catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1 }; }
      }
      if (command === "shell_bg") {
        if (!tokens.delete(args.approvalToken)) throw new Error("adapter approval missing");
        const id = `job_${randomUUID()}`;
        const job = { status: "running", code: null, stdout_tail: "", stderr_tail: "", elapsed_ms: 0 };
        jobs.set(id, job);
        const started = Date.now();
        const commandArgs = nodeArgs(args.cmd);
        const tested = revision;
        void exec(process.execPath, commandArgs, { cwd: root, timeout: 30_000 }).then((result) => {
          if (commandArgs[0] === "--test") testedRevision = tested;
          Object.assign(job, { status: "done", code: 0, stdout_tail: result.stdout, stderr_tail: result.stderr, elapsed_ms: Date.now() - started });
        }, (error) => Object.assign(job, { status: "done", code: error.code ?? 1, stdout_tail: error.stdout ?? "", stderr_tail: error.stderr ?? "", elapsed_ms: Date.now() - started }));
        return id;
      }
      if (command === "shell_poll") { if (!jobs.has(args.id)) throw new Error("unknown job"); return { ...jobs.get(args.id) }; }
      throw new Error(`unsupported fixture IPC: ${command}`);
    } } };
    const record = { name: task.name, root, model: cfg.model, startedAt: new Date().toISOString() };
    try {
      let result;
      if (fullPrompt) {
        const { useAgentTurn } = await server.ssrLoadModule("/src/hooks/useAgentTurn.ts");
        const { newWorkspace } = await server.ssrLoadModule("/src/lib/utils.ts");
        let workspace = newWorkspace("device:ws", root, cfg);
        const abortRef = { current: null };
        const frameRef = { current: null };
        let run;
        globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
        globalThis.cancelAnimationFrame = clearTimeout;
        renderToString(createElement(function Harness() {
          const hook = useAgentTurn({
            ws: workspace, workspaceRoot: root, conventions: "", conventionsName: "", skills: [], provHistLength: 1,
            repoMap: "src/math.mjs\nmath.test.mjs", gitSnapshot: "temporary fixture, clean", openPath: "",
            startAgentTurn: () => 1, finishAgentTurn: (_id, status) => { record.agentStatus = status; },
            turnAbort: abortRef, stopTurnIdRef: { current: "" }, streamRaf: frameRef, stickBottom: { current: true },
            lastSynced: { current: { pad: "", plan: "", memory: "" } },
            updateWs: (fn) => { workspace = fn(workspace); }, logAudit: (event) => events.push(event), rememberProvider: () => {},
            setCenterTab: () => {}, setPadText: () => {}, setPlanText: () => {}, setMemoryText: () => {}, setNexaState: () => {}, setShowJump: () => {},
            flushStreamFrame: () => { if (frameRef.current) clearTimeout(frameRef.current); frameRef.current = null; },
            autoApproveWorkspace: true,
          });
          run = hook.runAgentTurn;
          return null;
        }));
        const deadline = setTimeout(() => abortRef.current?.abort(), 240_000);
        try { await run(`${task.prompt} Implementation: ${join(root, "src/math.mjs")}. Acceptance tests: ${join(root, "math.test.mjs")}. Run node --test before finishing.`); }
        finally { clearTimeout(deadline); if (frameRef.current) clearTimeout(frameRef.current); delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; }
        result = workspace.messages[workspace.messages.length - 1]?.content ?? "";
        transcript = workspace.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
      } else result = await chatWithTools(cfg, [
        { role: "system", content: `You are a coding agent. Workspace: ${root}. Use tools to read and edit files. The implementation is ${join(root, "src/math.mjs")}. Read that file first, write its full corrected content using fs_write with an absolute path, then run shell_run with cmd "node --test" and cwd ${root}. Tests are immutable. Do the work, then give a brief summary. Do not ask questions.` },
        { role: "user", content: `${task.prompt} Run node --test in the workspace before finishing.` },
      ], (text) => { transcript = (transcript + text).slice(-256_000); }, { signal: AbortSignal.timeout(240_000), policy: { workspaceRoot: root, cwd: root, autoApproveWorkspace: true, allowedTools: { skill: "device-validation", tools: ["fs_read", "fs_list", "fs_write", "shell_run"] } }, onUsage: (usage) => events.push({ usage }), onAudit: (event) => events.push({ ...event, at: new Date().toISOString() }) });
      record.answer = result;
      record.agentVerifiedFinalRevision = revision > 0 && testedRevision === revision;
      if (await readFile(join(root, "math.test.mjs"), "utf8") !== testSource) throw new Error("Acceptance tests were changed");
      const code = await readFile(join(root, "src/math.mjs"), "utf8");
      const test = await exec(process.execPath, ["--test"], { cwd: root, timeout: 30_000 });
      record.testOutput = test.stdout;
      // Independent contract checks complement the original immutable tests.
      // In particular, an exported helper violates a refactor's public API.
      const contract = `import assert from 'node:assert/strict';
        import * as math from './src/math.mjs';
        assert.deepEqual(Object.keys(math).sort(), ${JSON.stringify(task.imports.split(",").map((name) => name.trim()).sort())});
        ${task.name === "refactor" ? `for (const name of ['double', 'triple']) for (const value of [NaN, Infinity, '3']) {
          assert.throws(() => math[name](value), { name: 'TypeError', message: 'finite number required' });
        }` : ""}`;
      await exec(process.execPath, ["--input-type=module", "--eval", contract], { cwd: root, timeout: 30_000 });
      record.contractChecks = "public exports and error behavior passed";
      record.diff = (await exec("git", ["diff", "--", "src/math.mjs"], { cwd: root })).stdout;
      if (await readFile(join(root, "math.test.mjs"), "utf8") !== testSource) throw new Error("Acceptance tests were changed");
      record.passed = record.agentVerifiedFinalRevision && code !== task.code && (task.name !== "refactor" || code.split("Number.isFinite").length - 1 === 1) &&
        !result.includes("[Unresolved tool failures:") && !result.includes("[No workspace tools ran.") && (!fullPrompt || record.agentStatus === "success");
    } catch (error) { record.passed = false; record.error = String(error); record.testOutput = error.stdout; }
    record.diff = (await exec("git", ["diff", "--", "src/math.mjs"], { cwd: root })).stdout;
    record.finishedAt = new Date().toISOString();
    await writeFile(join(root, "events.json"), JSON.stringify(events, null, 2));
    await writeFile(join(root, "transcript.txt"), transcript);
    summary.tasks.push(record);
    await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ task: task.name, passed: record.passed, error: record.error, root }));
  }
} finally { await server.close(); delete globalThis.window; }
summary.finishedAt = new Date().toISOString();
await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`Evidence: ${output}/summary.json`);
if (summary.tasks.some((task) => !task.passed) || summary.cancellation?.passed === false || summary.requestAfterStop?.passed === false) process.exitCode = 1;
