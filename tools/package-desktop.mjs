import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zipLib from "zip-lib";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(join(projectRoot, "neutralino.config.json"), "utf8"));
const packageRoot = join(projectRoot, "dist-desktop", config.cli.binaryName);
const stagingRoot = join(projectRoot, "dist-desktop", "package-staging");
const releaseRoot = join(projectRoot, "dist-desktop", "releases");
const sizeBudget = 8 * 1024 * 1024;
const version = config.version;

await rm(stagingRoot, { recursive: true, force: true });
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await mkdir(releaseRoot, { recursive: true });

async function copyExecutable(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}

async function addCommonFiles(directory, instructions) {
  await copyFile(join(projectRoot, "LICENSE"), join(directory, "LICENSE.txt"));
  await writeFile(join(directory, "README.txt"), `${instructions.trim()}\n\nSciDigitizer ${version}\nCopyright © 2026 Chongbing Qu (瞿崇兵)\nMIT License\n`);
}

async function zipRelease(stagingDirectory, fileName) {
  const output = join(releaseRoot, fileName);
  await zipLib.archiveFolder(stagingDirectory, output);
  const { size } = await stat(output);
  if (size > sizeBudget) {
    throw new Error(`${fileName} exceeds the 8 MiB compressed package budget (${(size / 1024 / 1024).toFixed(2)} MiB).`);
  }
  return { file: fileName, bytes: size };
}

async function packagePortable(platform, architecture, sourceName, outputName, instructions) {
  const directory = join(stagingRoot, `${platform}-${architecture}`);
  await mkdir(directory, { recursive: true });
  await copyExecutable(join(packageRoot, sourceName), join(directory, outputName));
  await addCommonFiles(directory, instructions);
  return zipRelease(directory, `SciDigitizer-${version}-${platform}-${architecture}.zip`);
}

async function packageMac(architecture, sourceName) {
  const directory = join(stagingRoot, `macos-${architecture}`);
  const appRoot = join(directory, "SciDigitizer.app", "Contents");
  const executable = join(appRoot, "MacOS", "SciDigitizer");
  await copyExecutable(join(packageRoot, sourceName), executable);
  await mkdir(join(appRoot, "Resources"), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>SciDigitizer</string>
  <key>CFBundleExecutable</key><string>SciDigitizer</string>
  <key>CFBundleIdentifier</key><string>${config.applicationId}</string>
  <key>CFBundleName</key><string>SciDigitizer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
  await writeFile(join(appRoot, "Info.plist"), plist);
  await addCommonFiles(directory, "Open SciDigitizer.app from Finder. This unsigned prototype may require Control-click → Open on first launch.");
  return zipRelease(directory, `SciDigitizer-${version}-macos-${architecture}.zip`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function packageDebianX64() {
  if (process.platform !== "linux") return null;
  const root = join(stagingRoot, "linux-x64-deb");
  const executable = join(root, "usr", "bin", "scidigitizer");
  await copyExecutable(join(packageRoot, "scidigitizer-linux_x64"), executable);
  await mkdir(join(root, "DEBIAN"), { recursive: true });
  await mkdir(join(root, "usr", "share", "applications"), { recursive: true });
  await mkdir(join(root, "usr", "share", "doc", "scidigitizer"), { recursive: true });
  await copyFile(join(projectRoot, "LICENSE"), join(root, "usr", "share", "doc", "scidigitizer", "copyright"));
  await writeFile(join(root, "DEBIAN", "control"), `Package: scidigitizer
Version: ${version}
Section: science
Priority: optional
Architecture: amd64
Depends: libgtk-3-0 | libgtk-3-0t64, libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37
Maintainer: Chongbing Qu (瞿崇兵)
Installed-Size: ${Math.ceil((await stat(executable)).size / 1024)}
Description: Local-first scientific curve digitizer
 Extract curve data from scientific plot images without uploading data.
`);
  await writeFile(join(root, "usr", "share", "applications", "scidigitizer.desktop"), `[Desktop Entry]
Type=Application
Name=SciDigitizer
Comment=Extract curve data from scientific plot images
Exec=/usr/bin/scidigitizer
Terminal=false
Categories=Science;Education;Graphics;
Keywords=plot;curve;digitizer;science;
`);
  const output = join(releaseRoot, `SciDigitizer-${version}-linux-x64.deb`);
  await run("dpkg-deb", ["--build", "--root-owner-group", root, output]);
  const { size } = await stat(output);
  if (size > sizeBudget) throw new Error(`Linux .deb exceeds the 8 MiB package budget (${(size / 1024 / 1024).toFixed(2)} MiB).`);
  return { file: output.split("/").pop(), bytes: size };
}

const releases = [];
releases.push(await packagePortable("windows", "x64", "scidigitizer-win_x64.exe", "SciDigitizer.exe", "Double-click SciDigitizer.exe. Windows 10/11 normally includes the required WebView2 runtime."));
releases.push(await packagePortable("linux", "x64", "scidigitizer-linux_x64", "SciDigitizer", "Double-click SciDigitizer in a file manager. WebKitGTK 4.1 or 4.0 is required."));
releases.push(await packagePortable("linux", "arm64", "scidigitizer-linux_arm64", "SciDigitizer", "Double-click SciDigitizer in a file manager. WebKitGTK 4.1 or 4.0 is required."));
releases.push(await packageMac("x64", "scidigitizer-mac_x64"));
releases.push(await packageMac("arm64", "scidigitizer-mac_arm64"));
const debian = await packageDebianX64();
if (debian) releases.push(debian);

const releaseManifest = [];
for (const release of releases) {
  const contents = await readFile(join(releaseRoot, release.file));
  releaseManifest.push({
    ...release,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
}

await writeFile(
  join(releaseRoot, "sizes.json"),
  `${JSON.stringify({ version, budgetBytes: sizeBudget, releases: releaseManifest }, null, 2)}\n`,
);
await writeFile(
  join(releaseRoot, "SHA256SUMS.txt"),
  `${releaseManifest.map((release) => `${release.sha256}  ${release.file}`).join("\n")}\n`,
);
for (const release of releaseManifest) {
  console.log(`${release.file}: ${(release.bytes / 1024 / 1024).toFixed(2)} MiB`);
}
console.log("SHA-256 checksums: SHA256SUMS.txt");
