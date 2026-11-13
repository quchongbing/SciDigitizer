#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allPackageSuffixes, extractArchive, hostPackageSuffixes, inspectMachO, inspectWindows,
  packageBudget, run, verifyMachOSignature,
} from "./desktop-platform.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function verifyPackageContents(directory, suffix, { platform = process.platform, runner = run } = {}) {
  if (suffix === "windows-x64.zip") {
    inspectWindows(await readFile(join(directory, "SciDigitizer.exe")));
  } else if (suffix.startsWith("macos-")) {
    const app = join(directory, "SciDigitizer.app");
    const executable = join(app, "Contents", "MacOS", "SciDigitizer");
    const bytes = await readFile(executable);
    const info = inspectMachO(bytes);
    if (suffix !== `macos-${info.arch}.zip`) throw new Error(`Mac architecture does not match ${suffix}.`);
    verifyMachOSignature(bytes, info);
    const plist = await readFile(join(app, "Contents", "Info.plist"), "utf8");
    const declaredOS = plist.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (declaredOS !== info.minimumOS) throw new Error(`Mac minimum OS mismatch: binary ${info.minimumOS}, Info.plist ${declaredOS ?? "missing"}.`);
    if (platform !== "win32" && !((await stat(executable)).mode & 0o111)) throw new Error("Mac executable has no execute permission.");
    if (platform === "darwin") await runner("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  }
}

export async function verifyRelease(releaseRoot, { suffixes = allPackageSuffixes, version, runner = run } = {}) {
  version ??= JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")).version;
  const manifest = JSON.parse(await readFile(join(releaseRoot, "sizes.json"), "utf8"));
  const checksumText = await readFile(join(releaseRoot, "SHA256SUMS.txt"), "utf8");
  const fail = (message) => { throw new Error(`Release verification failed: ${message}`); };
  if (manifest.version !== version) fail(`sizes.json is for ${manifest.version ?? "an unknown version"}, source is ${version}`);
  if (!Array.isArray(manifest.releases)) fail("sizes.json has no release list");
  if (!Number.isSafeInteger(manifest.budgetBytes) || manifest.budgetBytes <= 0 || manifest.budgetBytes > packageBudget) {
    fail("invalid or inflated size budget");
  }
  const expectedNames = suffixes.map((suffix) => `SciDigitizer-${version}-${suffix}`);
  const manifestNames = manifest.releases.map((release) => release?.file);
  if (new Set(manifestNames).size !== manifestNames.length) fail("sizes.json contains duplicate file names");
  for (const name of expectedNames) if (!manifestNames.includes(name)) fail(`missing expected package ${name}`);
  for (const name of manifestNames) if (!expectedNames.includes(name)) fail(`unexpected or stale package ${name}`);
  const checksumEntries = new Map();
  for (const line of checksumText.trim().split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
    if (!match) fail(`invalid SHA256SUMS line: ${line}`);
    if (checksumEntries.has(match[2])) fail(`duplicate SHA256SUMS entry: ${match[2]}`);
    checksumEntries.set(match[2], match[1].toLowerCase());
  }
  if (checksumEntries.size !== expectedNames.length) fail("SHA256SUMS.txt does not list each package exactly once");
  const scratch = await mkdtemp(join(tmpdir(), "scidigitizer-verify-"));
  try {
    for (const release of manifest.releases) {
      const path = join(releaseRoot, release.file);
      const actualSize = (await stat(path)).size;
      if (actualSize > manifest.budgetBytes) fail(`${release.file} exceeds the declared size budget`);
      const contents = await readFile(path);
      const actualHash = createHash("sha256").update(contents).digest("hex");
      if (actualSize !== release.bytes) fail(`${release.file} size does not match sizes.json`);
      if (actualHash !== release.sha256) fail(`${release.file} hash does not match SHA256SUMS.txt`);
      if (actualHash !== checksumEntries.get(release.file)) fail(`${release.file} hash does not match SHA256SUMS.txt`);
      if (release.file.endsWith(".zip")) {
        const directory = join(scratch, release.file);
        await extractArchive(path, directory);
        await verifyPackageContents(directory, release.file.slice(`SciDigitizer-${version}-`.length), { runner });
      }
    }
    const diskPackages = (await readdir(releaseRoot)).filter((name) => /^SciDigitizer-.*\.(?:zip|deb)$/i.test(name));
    for (const name of diskPackages) if (!expectedNames.includes(name)) fail(`release directory also contains stale package ${name}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`Verified ${expectedNames.length} release packages for ${version} (SHA-256, sizes and applicable native checks).`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((arg) => arg.startsWith("--") && arg !== "--host")) throw new Error("Usage: verify-release.mjs [directory] [--host]");
  const paths = arguments_.filter((arg) => arg !== "--host");
  if (paths.length > 1) throw new Error("Expected one release directory.");
  await verifyRelease(paths[0] ?? join(projectRoot, "dist-desktop", "releases"), {
    suffixes: arguments_.includes("--host") ? hostPackageSuffixes() : allPackageSuffixes,
  });
}
