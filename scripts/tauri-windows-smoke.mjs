import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { retryUntil, WebDriverClient } from "./tauri-driver-client.mjs";

export const TAURI_DRIVER_VERSION = "2.0.6";
const DEFAULT_TIMEOUT_MS = 90000;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--app") result.app = argv[++index];
    else if (argument === "--driver") result.driver = argv[++index];
    else if (argument === "--native-driver") result.nativeDriver = argv[++index];
    else if (argument === "--port") result.port = Number(argv[++index]);
    else if (argument === "--native-port") result.nativePort = Number(argv[++index]);
    else if (argument === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

function usage() {
  return [
    "Windows Tauri WebDriver smoke",
    "",
    "Usage: node scripts/tauri-windows-smoke.mjs --app <absolute-path-to-vtnexa.exe>",
    "",
    `Launches tauri-driver ${TAURI_DRIVER_VERSION} and drives the real WebView2 application.`,
  ].join("\n");
}

function numberOption(value, fallback) {
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  if (!port) throw new Error("could not allocate a WebDriver port");
  return port;
}

async function waitForPort(port, child, timeoutMs, getSpawnError) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "port did not accept connections";
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw new Error(`tauri-driver could not start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`tauri-driver exited before listening (code ${child.exitCode ?? "signal"})`);
    }
    try {
      await new Promise((resolveProbe, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const fail = (error) => {
          socket.destroy();
          reject(error);
        };
        socket.once("connect", () => {
          socket.destroy();
          resolveProbe();
        });
        socket.once("error", fail);
        socket.setTimeout(500, () => fail(new Error("connection timeout")));
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(lastError);
}

async function launchDriver({ driver, port, nativePort, nativeDriver, env, logs, timeoutMs }) {
  const args = ["--port", String(port), "--native-port", String(nativePort)];
  if (nativeDriver) args.push("--native-driver", nativeDriver);
  const child = spawn(driver, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const spawnState = { error: null };
  const append = (chunk) => {
    if (logs.join("").length < 16000) logs.push(String(chunk));
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", (error) => {
    spawnState.error = error;
    append(`\n${error.message}`);
  });
  try {
    await waitForPort(port, child, Math.min(timeoutMs, 30000), () => spawnState.error);
  } catch (error) {
    throw new Error(`launch tauri-driver ${TAURI_DRIVER_VERSION}: ${error instanceof Error ? error.message : String(error)}\n${logs.join("")}`);
  }
  return child;
}

async function stopDriver(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
    await Promise.race([once(child, "exit"), delay(3000)]);
  }
}

function testId(id) {
  return `[data-testid="${id}"]`;
}

async function waitForTestId(client, id, timeoutMs, description) {
  return retryUntil(() => client.findElement(testId(id)), {
    timeoutMs,
    intervalMs: 250,
    description,
  });
}

function comparablePath(value) {
  const text = String(value ?? "").replace(/^\\\\\?\\/, "").replace(/\//g, "\\");
  return text.replace(/[\\]+$/, "").toLowerCase();
}

async function verifyApplicationPath(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("--app is required");
  const application = resolve(value);
  if (!/^[A-Za-z]:[\\/]/.test(application)) throw new Error(`application path must be absolute: ${application}`);
  if (!application.toLowerCase().endsWith(".exe")) throw new Error(`application must be a Windows executable: ${application}`);
  const info = await stat(application);
  if (!info.isFile()) throw new Error(`application is not a file: ${application}`);
  return application;
}

async function runStep(name, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runSmoke(options = {}) {
  if (process.platform !== "win32") throw new Error("the Tauri WebDriver smoke is Windows-only");
  const timeoutMs = numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const application = await verifyApplicationPath(options.app);
  const driver = options.driver || process.env.TAURI_DRIVER_BIN || join(homedir(), ".cargo", "bin", "tauri-driver.exe");
  const nativeDriver = options.nativeDriver || process.env.TAURI_DRIVER_NATIVE_DRIVER || undefined;
  const port = numberOption(options.port, await freePort());
  const nativePort = numberOption(options.nativePort, await freePort());
  const workspace = await mkdtemp(join(tmpdir(), "vtnexa-webdriver-workspace-"));
  const profile = await mkdtemp(join(tmpdir(), "vtnexa-webdriver-profile-"));
  if (!isAbsolute(workspace) || !/^[A-Za-z]:[\\/]/.test(workspace)) throw new Error(`temporary workspace is not an absolute Windows path: ${workspace}`);
  const logs = [];
  const client = new WebDriverClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs });
  let driverProcess;
  let failure;
  let closeFailure;
  try {
    driverProcess = await runStep(`launch tauri-driver ${TAURI_DRIVER_VERSION}`, () =>
      launchDriver({
        driver,
        port,
        nativePort,
        nativeDriver,
        env: {
          ...process.env,
          TAURI_WEBVIEW_AUTOMATION: "true",
          WEBVIEW2_USER_DATA_FOLDER: profile,
        },
        logs,
        timeoutMs,
      }),
    );
    await runStep("create W3C session", () =>
      retryUntil(() => client.createSession(application), {
        timeoutMs,
        intervalMs: 500,
        description: "create W3C session",
      }),
    );
    await runStep("first-run renders", () => waitForTestId(client, "first-run", timeoutMs, "first-run view"));
    await runStep("enter absolute Windows workspace path", () =>
      retryUntil(async () => {
        const input = await client.findElement(testId("workspace-path-input"));
        await client.clear(input);
        await client.sendKeys(input, workspace);
      }, {
        timeoutMs,
        intervalMs: 300,
        description: "enter workspace path",
      }),
    );
    await runStep("submit workspace through actual Tauri IPC", () =>
      retryUntil(async () => {
        const button = await client.findElement(testId("workspace-path-submit"));
        await client.click(button);
      }, {
        timeoutMs,
        intervalMs: 300,
        description: "submit workspace path",
      }),
    );
    await runStep("workspace reaches ready workbench", () => waitForTestId(client, "workbench", timeoutMs, "ready workbench"));
    await runStep("Tauri IPC returns the selected workspace", async () => {
      const input = await waitForTestId(client, "workspace-root", timeoutMs, "workspace root");
      const actual = await retryUntil(() => client.getProperty(input, "value"), {
        timeoutMs,
        intervalMs: 250,
        description: "workspace root value",
      });
      if (comparablePath(actual) !== comparablePath(workspace)) {
        throw new Error(`workspace path mismatch: expected ${workspace}, got ${String(actual)}`);
      }
    });
    await runStep("Settings opens through the real UI", async () => {
      await retryUntil(async () => {
        const button = await client.findElement(testId("settings-button"));
        await client.click(button);
      }, {
        timeoutMs,
        intervalMs: 300,
        description: "open Settings",
      });
      await waitForTestId(client, "settings-dialog", timeoutMs, "Settings dialog");
    });
  } catch (error) {
    failure = error;
  } finally {
    if (client.sessionId) {
      try {
        await client.deleteSession();
      } catch (error) {
        closeFailure = new Error(`close WebDriver session: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await stopDriver(driverProcess);
    } catch (error) {
      const stopFailure = new Error(`stop tauri-driver: ${error instanceof Error ? error.message : String(error)}`);
      closeFailure = closeFailure ? new Error(`${closeFailure.message}; ${stopFailure.message}`) : stopFailure;
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
  if (failure || closeFailure) {
    const errors = [failure, closeFailure].filter(Boolean).map((error) => error.message);
    throw new Error(`${errors.join("; ")}${logs.length > 0 ? `\ntauri-driver diagnostics:\n${logs.join("")}` : ""}`);
  }
  console.log(`Tauri WebDriver smoke passed: ${application}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      await runSmoke(options);
    }
  } catch (error) {
    console.error(`tauri-windows-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
