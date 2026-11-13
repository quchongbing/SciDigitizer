import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zipLib from "zip-lib";
import { hostPackageSuffixes, inspectMachO, localPackageRoot, packageBudget, run, signMacBundle } from "./desktop-platform.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(join(projectRoot, "neutralino.config.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const packageRoot = join(projectRoot, "dist-desktop", config.cli.binaryName);
const targets = hostPackageSuffixes();
const releaseRoot = process.argv[2] ?? localPackageRoot(projectRoot);
const sizeBudget = packageBudget;
const version = packageMetadata.version;
const baseVersion = config.version;
const previewMatch = version.match(/^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)(?:\.(\d+))?$/);
if (version !== baseVersion && previewMatch?.slice(1, 4).join(".") !== baseVersion) {
  throw new Error(`Package version ${version} must use Neutralino base version ${baseVersion}.`);
}
const previewPatch = previewMatch?.[5] ? Number(previewMatch[5]) : null;
const debianVersion = previewMatch
  ? `${baseVersion}-0preview${previewMatch[4]}${previewPatch === null ? "" : `patch${previewPatch}`}`
  : `${version}-1`;
const macBundleVersion = previewMatch
  ? `${previewMatch[1]}.${previewMatch[2]}.${previewPatch === null
    ? previewMatch[4]
    : Number(previewMatch[4]) * 100 + previewPatch}`
  : baseVersion;

await mkdir(releaseRoot, { recursive: true });
if ((await readdir(releaseRoot)).length) throw new Error(`Output directory is not empty: ${releaseRoot}. Choose a new directory; existing packages will not be overwritten.`);
const stagingRoot = await mkdtemp(join(tmpdir(), "scidigitizer-package-"));

async function copyExecutable(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}

async function addCommonFiles(directory, instructions) {
  await copyFile(join(projectRoot, "LICENSE"), join(directory, "LICENSE.txt"));
  for (const name of ["neutralino-client.LICENSE.txt", "neutralino-runtime.LICENSE.txt"]) {
    await copyFile(join(projectRoot, "desktop", "vendor", name), join(directory, name));
  }
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
  const native = inspectMachO(await readFile(executable));
  if (native.arch !== architecture) throw new Error(`Wrong Mac architecture: expected ${architecture}, got ${native.arch}.`);
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
  <key>CFBundleShortVersionString</key><string>${baseVersion}</string>
  <key>CFBundleVersion</key><string>${macBundleVersion}</string>
  <key>LSMinimumSystemVersion</key><string>${native.minimumOS}</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
  await writeFile(join(appRoot, "Info.plist"), plist);
  await signMacBundle(join(directory, "SciDigitizer.app"));
  await addCommonFiles(directory, "Requires macOS " + native.minimumOS + " or later. Move SciDigitizer.app to Applications. This preview is ad-hoc signed, not Developer ID signed or notarized. After verifying the official download, try opening it, then use System Settings > Privacy & Security > Open Anyway if Gatekeeper blocks it. Do not disable Gatekeeper globally. See https://github.com/quchongbing/SciDigitizer/blob/main/docs/installation.md");
  return zipRelease(directory, `SciDigitizer-${version}-macos-${architecture}.zip`);
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
  for (const name of ["neutralino-client.LICENSE.txt", "neutralino-runtime.LICENSE.txt"]) {
    await copyFile(join(projectRoot, "desktop", "vendor", name), join(root, "usr", "share", "doc", "scidigitizer", name));
  }
  await writeFile(join(root, "DEBIAN", "control"), `Package: scidigitizer
Version: ${debianVersion}
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
try {
  if (targets.includes("windows-x64.zip")) {
    releases.push(await packagePortable("windows", "x64", "scidigitizer-win_x64.exe", "SciDigitizer.exe", "Extract the entire ZIP to a local folder, then open SciDigitizer.exe. Windows 10/11 x64 and Microsoft Edge WebView2 Runtime are required. If the runtime is missing, install the Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ . This preview has no Authenticode publisher signature; verify the official download before allowing a SmartScreen exception. Do not disable security software. See https://github.com/quchongbing/SciDigitizer/blob/main/docs/installation.md"));
  }
  if (targets.includes("linux-x64.zip")) {
    releases.push(await packagePortable("linux", "x64", "scidigitizer-linux_x64", "SciDigitizer", "Double-click SciDigitizer in a file manager. WebKitGTK 4.1 or 4.0 is required."));
    releases.push(await packagePortable("linux", "arm64", "scidigitizer-linux_arm64", "SciDigitizer", "Double-click SciDigitizer in a file manager. WebKitGTK 4.1 or 4.0 is required."));
    const debian = await packageDebianX64();
    if (debian) releases.push(debian);
  }
  for (const architecture of ["x64", "arm64"]) {
    if (targets.includes(`macos-${architecture}.zip`)) releases.push(await packageMac(architecture, `scidigitizer-mac_${architecture}`));
  }

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
    `${JSON.stringify({ version, baseVersion, debianVersion, budgetBytes: sizeBudget, releases: releaseManifest }, null, 2)}\n`,
  );
  await writeFile(
    join(releaseRoot, "SHA256SUMS.txt"),
    `${releaseManifest.map((release) => `${release.sha256}  ${release.file}`).join("\n")}\n`,
  );
  for (const release of releaseManifest) {
    console.log(`${release.file}: ${(release.bytes / 1024 / 1024).toFixed(2)} MiB`);
  }
  console.log("SHA-256 checksums: SHA256SUMS.txt");
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
