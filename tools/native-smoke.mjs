import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractArchive, hostPackageSuffixes, localPackageRoot } from "./desktop-platform.mjs";
import { verifyPackageContents } from "./verify-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = process.argv[2] ?? localPackageRoot(root);
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const suffix = hostPackageSuffixes().find((name) => name.endsWith(`${process.arch}.zip`));
const scratch = await mkdtemp(join(tmpdir(), "scidigitizer-native-smoke-"));
const extracted = join(scratch, "unpacked");
const foreignCwd = join(scratch, "foreign cwd 测试");
await mkdir(foreignCwd);
const proof = join(scratch, "native-write-proof.txt");
const callback = "/__native_smoke_" + randomBytes(16).toString("hex");
let child;
let timeout;
let settle;
let lastState;
let nativeErrors = "";
const requests = [];
const result = new Promise((resolve) => { settle = resolve; });

function probeScript() {
  // Only the test server injects this probe. No test hooks or extra native
  // permissions are shipped in the app. Test the real embedded app in its WebView.
  return `<script>
  (() => {
    let sent = false;
    const report = async (value) => {
      if (sent) return;
      sent = true;
      await fetch(${JSON.stringify(callback)}, {method: 'POST', body: JSON.stringify(value)});
    };
    window.addEventListener('error', event => report({error: String(event.message)}));
    window.addEventListener('unhandledrejection', event => report({error: String(event.reason)}));
    const timer = setInterval(async () => {
      const canvas = document.querySelector('#plot-image-canvas');
      fetch(${JSON.stringify(callback + "/state")}, {method: 'POST', body: JSON.stringify({
        canvasWidth: canvas?.width, emptyHidden: document.querySelector('#empty-state')?.hidden,
        bridge: !!window.SciDigitizerDesktop, nativeAPI: !!window.Neutralino
      })}).catch(() => {});
      if (!canvas || canvas.width < 300 || !document.querySelector('#empty-state')?.hidden
        || !window.SciDigitizerDesktop || !window.Neutralino) return;
      clearInterval(timer);
      try {
        await Neutralino.filesystem.writeBinaryFile(${JSON.stringify(proof)}, new TextEncoder().encode('native smoke ok').buffer);
        await report({ok: true, width: canvas.width, height: canvas.height});
      } catch (error) { await report({error: String(error?.message || error)}); }
    }, 200);
  })();
  </script>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

const appPortReservation = createServer();
let origin;
const harness = createServer(async (request, response) => {
  try {
    if ([callback, callback + "/state"].includes(request.url) && request.method === "POST") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) throw new Error("Invalid native smoke callback.");
      }
      if (request.url.endsWith("/state")) lastState = JSON.parse(body);
      else settle(JSON.parse(body));
      response.end("ok");
      return;
    }
    if (request.method !== "GET" || !request.url.startsWith("/")) {
      response.writeHead(400).end();
      return;
    }
    if (requests.length < 20) requests.push(new URL(request.url, "http://localhost").pathname);
    const upstream = await fetch(origin + request.url, { signal: AbortSignal.timeout(5000) });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get("content-type") ?? "application/octet-stream";
    response.writeHead(upstream.status, { "content-type": type });
    response.end(type.includes("text/html") ? bytes.toString("utf8").replace("</head>", probeScript() + "</head>") : bytes);
  } catch (error) {
    settle({ error: error.message });
    response.writeHead(500).end("Native smoke proxy failed");
  }
});

try {
  await listen(appPortReservation);
  const appPort = appPortReservation.address().port;
  await new Promise((resolve) => appPortReservation.close(resolve));
  origin = `http://127.0.0.1:${appPort}`;
  await extractArchive(join(packages, `SciDigitizer-${metadata.version}-${suffix}`), extracted);
  await verifyPackageContents(extracted, suffix);
  const executable = process.platform === "darwin"
    ? join(extracted, "SciDigitizer.app", "Contents", "MacOS", "SciDigitizer")
    : join(extracted, process.platform === "win32" ? "SciDigitizer.exe" : "SciDigitizer");
  await listen(harness);
  child = spawn(executable, [
    `--port=${appPort}`, `--url=http://127.0.0.1:${harness.address().port}/`,
    "--window-hidden=true", "--window-use-saved-state=false",
  ], { cwd: foreignCwd, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (data) => { nativeErrors = (nativeErrors + data.toString()).slice(-3000); });
  child.once("error", (error) => settle({ error: error.message }));
  child.once("exit", (code, signal) => settle({ error: `Native app exited before readiness: ${signal ?? code}` }));
  timeout = setTimeout(() => settle({ error: "Native WebView did not load the sample and complete the native write within 45 seconds." }), 45000);
  const report = await result;
  if (!report.ok) throw new Error(`${report.error ?? "Native smoke failed."}\nLast WebView state: ${JSON.stringify(lastState)}\nResource requests: ${requests.join(", ")}\n${nativeErrors}`);
  if (await readFile(proof, "utf8") !== "native smoke ok") throw new Error("Native file-write proof is missing or invalid.");
  console.log(`Native ${process.platform}/${process.arch}: sample ${report.width}×${report.height}, embedded resources, Unicode working directory and native file write passed.`);
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  harness.closeAllConnections();
  await new Promise((resolve) => harness.close(resolve));
  if (appPortReservation.listening) await new Promise((resolve) => appPortReservation.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
