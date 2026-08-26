import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zipLib from "zip-lib";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(await readFile(join(projectRoot, "neutralino.config.json"), "utf8"));
const version = config.cli?.binaryVersion;
if (!version) throw new Error("neutralino.config.json does not define cli.binaryVersion.");

const tag = version === "nightly" ? version : `v${version}`;
const url = `https://github.com/neutralinojs/neutralinojs/releases/download/${tag}/neutralinojs-${tag}.zip`;
const downloadRoot = join(projectRoot, "build", "neutralino-update");
const archivePath = join(downloadRoot, "binaries.zip");
const extractRoot = join(downloadRoot, "extracted");
const binaryRoot = join(projectRoot, "bin");
const binaryNames = [
  "neutralino-linux_x64",
  "neutralino-linux_armhf",
  "neutralino-linux_arm64",
  "neutralino-mac_x64",
  "neutralino-mac_arm64",
  "neutralino-mac_universal",
  "neutralino-win_x64.exe",
];

await rm(downloadRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });

const localArchive = process.argv[2];
if (localArchive) {
  console.log(`Using local Neutralinojs ${version} runtime archive...`);
  await copyFile(resolve(localArchive), archivePath);
} else {
  console.log(`Downloading Neutralinojs ${version} runtimes...`);
  const response = await fetch(url, { headers: { "User-Agent": "SciDigitizer desktop builder" } });
  if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 1024) throw new Error("Downloaded Neutralinojs runtime archive is unexpectedly small.");
  await writeFile(archivePath, archive);
}
await zipLib.extract(archivePath, extractRoot);

await mkdir(binaryRoot, { recursive: true });
for (const binaryName of binaryNames) {
  const source = join(extractRoot, binaryName);
  const destination = join(binaryRoot, binaryName);
  await copyFile(source, destination);
  if (!binaryName.endsWith(".exe")) await chmod(destination, 0o755);
}

await rm(downloadRoot, { recursive: true, force: true });
console.log(`Installed ${binaryNames.length} verified runtime binaries in bin/.`);
