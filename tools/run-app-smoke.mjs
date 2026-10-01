#!/usr/bin/env node
// Run the real UI against a private HTTP server and a private browser profile.
// No existing Chrome session, browser storage, or development server is reused.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
if (process.argv.includes("--help")) {
  console.log(`Usage: node tools/run-app-smoke.mjs

Runs the HTTP/worker and file/synchronous app smoke tests in isolated Chrome.
Requires Node.js 22+, Python 3, and Chrome/Chromium; no browser download occurs.
Optional environment variables:
  CHROME_BIN        Chrome executable path (otherwise discovered locally)
  PYTHON            Python 3 executable (otherwise python3 or python)
  SMOKE_TIMEOUT_MS  Time limit per smoke mode (default: 180000)

Build the current file bundle first with npm run build:file.`);
  process.exit(0);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("SMOKE_TIMEOUT_MS must be a positive number.");
}
if (typeof WebSocket === "undefined") throw new Error("Use Node.js 22 or later for browser smoke tests.");

const controller = new AbortController();
const children = new Set();
let profile;
let signalReceived;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    signalReceived = signal;
    controller.abort(new Error(`Browser smoke interrupted by ${signal}.`));
  });
}

function start(executable, args, { env = process.env, forward = false } = {}) {
  const child = spawn(executable, args, {
    cwd: root,
    env,
    // A private process group lets cleanup also stop Chrome's subprocesses.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const task = { child, output: "", done: false, spawnError: null };
  children.add(task);
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", (chunk) => {
      task.output = (task.output + chunk.toString()).slice(-16_384);
      if (forward) destination.write(chunk);
    });
  }
  task.closed = new Promise((resolveClosed) => {
    child.on("error", (error) => { task.spawnError = error; });
    child.on("close", (code, signal) => {
      task.done = true;
      task.code = code;
      task.signal = signal;
      resolveClosed();
    });
  });
  return task;
}

function pause(ms) {
  return new Promise((resolvePause, reject) => {
    if (controller.signal.aborted) return reject(controller.signal.reason);
    const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
    const timer = setTimeout(() => {
      controller.signal.removeEventListener("abort", abort);
      resolvePause();
    }, ms);
    controller.signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitUntil(task, check, label, limit = 20_000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (task.spawnError) throw task.spawnError;
    const result = await check();
    if (result) return result;
    if (task.done) throw new Error(`${label} exited (${task.code ?? task.signal}).\n${task.output}`);
    await pause(50);
  }
  throw new Error(`Timed out after ${limit} ms: ${label}.\n${task.output}`);
}

async function stop(task) {
  const { child } = task;
  if (!child.pid) {
    await task.closed;
    children.delete(task);
    return;
  }
  if (process.platform === "win32") {
    if (!task.done) {
      await new Promise((resolveStop) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", resolveStop);
        killer.on("close", resolveStop);
      });
    }
  } else {
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    killGroup("SIGTERM");
    let timer;
    await Promise.race([task.closed, new Promise((resolveStop) => { timer = setTimeout(resolveStop, 1_500); })]);
    clearTimeout(timer);
    // The parent can exit before its Chrome renderer children do.
    killGroup("SIGKILL");
  }
  await task.closed;
  children.delete(task);
}

async function findExecutable(override, candidates, name) {
  for (const candidate of override ? [override] : candidates.filter(Boolean)) {
    const task = start(candidate, ["--version"]);
    try {
      await waitUntil(task, () => task.done, `${name} executable check`, 5_000);
      if (task.code === 0 && (name !== "Python" || /^Python 3\./m.test(task.output))) {
        console.log(task.output.trim());
        return candidate;
      }
    } catch (error) {
      if (controller.signal.aborted) throw error;
    } finally {
      await stop(task);
    }
  }
  throw new Error(`${name} was not found. Set ${name === "Chrome" ? "CHROME_BIN" : "PYTHON"} to its executable path.`);
}

async function runMode(label, url, origin, debuggingPort) {
  console.log(`\nBrowser smoke: ${label}`);
  const task = start(process.execPath, [join(root, "tools/app-smoke.mjs")], {
    env: {
      ...process.env,
      SCIDITIZER_ORIGIN: origin,
      SCIDITIZER_URL: url,
      CHROME_DEBUG_PORT: String(debuggingPort),
    },
    forward: true,
  });
  try {
    await waitUntil(task, () => task.done, `${label} smoke`, timeoutMs);
    if (task.code !== 0) throw new Error(`${label} smoke failed (${task.code ?? task.signal}).`);
  } finally {
    await stop(task);
  }
}

try {
  const python = await findExecutable(process.env.PYTHON, ["python3", "python"], "Python");
  const chrome = await findExecutable(process.env.CHROME_BIN, [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    process.platform === "darwin" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter(Boolean).map((base) => join(base, "Google", "Chrome", "Application", "chrome.exe")),
  ], "Chrome");
  const server = start(python, [join(root, "tools/serve.py")], {
    env: { ...process.env, SCIDIGITIZER_HOST: "127.0.0.1", SCIDIGITIZER_PORT: "0", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
  });
  const origin = await waitUntil(server, () => {
    const port = server.output.match(/http:\/\/localhost:(\d+)\//)?.[1];
    return port ? `http://127.0.0.1:${port}` : null;
  }, "private HTTP server");
  profile = await mkdtemp(join(tmpdir(), "scidigitizer-app-smoke-"));
  const browser = start(chrome, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--disable-component-update", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ]);
  const debuggingPort = await waitUntil(browser, async () => {
    try {
      const port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
  }, "private Chrome");
  await waitUntil(browser, async () => {
    try {
      return (await fetch(`http://127.0.0.1:${debuggingPort}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      })).ok;
    } catch {
      return false;
    }
  }, "private Chrome debugging endpoint");
  await runMode("HTTP / worker", `${origin}/`, origin, debuggingPort);
  await runMode("file / synchronous", pathToFileURL(join(root, "index.html")).href, origin, debuggingPort);
  console.log("\nBoth browser smoke modes passed.");
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = signalReceived === "SIGINT" ? 130 : signalReceived === "SIGTERM" ? 143 : 1;
} finally {
  for (const task of [...children].reverse()) {
    try { await stop(task); }
    catch (error) { console.error(`Failed to stop private test process: ${error.message}`); process.exitCode = 1; }
  }
  if (profile) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { console.error(`Could not remove temporary browser profile ${profile}: ${error.message}`); process.exitCode = 1; }
  }
}
