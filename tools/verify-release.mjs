#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseRoot = process.argv[2] ?? join(projectRoot, "dist-desktop", "releases");
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(releaseRoot, "sizes.json"), "utf8"));
const checksumText = await readFile(join(releaseRoot, "SHA256SUMS.txt"), "utf8");
const expectedSuffixes = [
  "windows-x64.zip",
  "linux-x64.zip",
  "linux-arm64.zip",
  "macos-x64.zip",
  "macos-arm64.zip",
  "linux-x64.deb",
];

function fail(message) {
  throw new Error(`Release verification failed: ${message}`);
}

if (manifest.version !== packageMetadata.version) {
  fail(`sizes.json is for ${manifest.version ?? "an unknown version"}, source is ${packageMetadata.version}`);
}
if (!Array.isArray(manifest.releases)) fail("sizes.json has no release list");

const expectedNames = expectedSuffixes.map((suffix) => `SciDigitizer-${packageMetadata.version}-${suffix}`);
const manifestNames = manifest.releases.map((release) => release?.file);
if (new Set(manifestNames).size !== manifestNames.length) fail("sizes.json contains duplicate file names");
for (const name of expectedNames) {
  if (!manifestNames.includes(name)) fail(`missing expected package ${name}`);
}
for (const name of manifestNames) {
  if (!expectedNames.includes(name)) fail(`unexpected or stale package ${name}`);
}

const checksumEntries = new Map(checksumText.trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
  if (!match) fail(`invalid SHA256SUMS line: ${line}`);
  return [match[2], match[1].toLowerCase()];
}));
if (checksumEntries.size !== expectedNames.length) fail("SHA256SUMS.txt does not list each package exactly once");

for (const release of manifest.releases) {
  const path = join(releaseRoot, release.file);
  const contents = await readFile(path);
  const actualSize = (await stat(path)).size;
  const actualHash = createHash("sha256").update(contents).digest("hex");
  if (actualSize !== release.bytes) fail(`${release.file} size does not match sizes.json`);
  if (actualHash !== release.sha256) fail(`${release.file} hash does not match sizes.json`);
  if (actualHash !== checksumEntries.get(release.file)) fail(`${release.file} hash does not match SHA256SUMS.txt`);
  if (actualSize > manifest.budgetBytes) fail(`${release.file} exceeds the declared size budget`);
}

const diskPackages = (await readdir(releaseRoot)).filter((name) => /^SciDigitizer-.*\.(?:zip|deb)$/i.test(name));
for (const name of diskPackages) {
  if (!expectedNames.includes(name)) fail(`release directory also contains stale package ${name}`);
}

console.log(`Verified ${expectedNames.length} immutable release packages for ${packageMetadata.version}.`);
