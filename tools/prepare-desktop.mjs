import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(projectRoot, "build", "desktop-web");
const config = JSON.parse(await readFile(join(projectRoot, "neutralino.config.json"), "utf8"));
const client = await readFile(join(projectRoot, "desktop", "vendor", "neutralino.js"));
if (config.cli.clientVersion !== "6.9.0" || config.cli.clientLibrary !== "/build/desktop-web/neutralino.js"
  || createHash("sha256").update(client).digest("hex") !== "7e9d355ee2e0a0284e4f726b09ed5d7e602b657eacd488b011a6eb390f2a7923") {
  throw new Error("Neutralino client version, path or checksum mismatch. Update the pinned client and its license together.");
}

const runtimeItems = [
  ["styles.css", "styles.css"],
  ["src", "src"],
  ["images/fig1.png", "images/fig1.png"],
  ["desktop/bridge.js", "desktop-bridge.js"],
  ["desktop/vendor/neutralino.js", "neutralino.js"],
];

async function copyItem(source, destination) {
  const target = join(outputRoot, destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(projectRoot, source), target, { recursive: true });
}

async function directorySize(path) {
  const entry = await stat(path);
  if (entry.isFile()) return entry.size;
  const names = await readdir(path);
  const sizes = await Promise.all(names.map((name) => directorySize(join(path, name))));
  return sizes.reduce((total, size) => total + size, 0);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await Promise.all(runtimeItems.map(([source, destination]) => copyItem(source, destination)));

const sourceIndex = await readFile(join(projectRoot, "index.html"), "utf8");
const appScriptPattern = /(\s*<script data-scidigitizer-loader>)/;
if (!appScriptPattern.test(sourceIndex)) {
  throw new Error("Could not find the SciDigitizer application loader in index.html.");
}

const nativeScripts = [
  '    <script src="desktop-bridge.js"></script>',
].join("\n");
const desktopIndex = sourceIndex.replace(appScriptPattern, `\n${nativeScripts}$1`);
await writeFile(join(outputRoot, "index.html"), desktopIndex);

const bytes = await directorySize(outputRoot);
const kib = (bytes / 1024).toFixed(1);
console.log(`Prepared desktop web resources: ${kib} KiB`);
if (bytes > 1024 * 1024) {
  throw new Error(`Desktop web resources exceed the 1 MiB budget (${kib} KiB).`);
}
