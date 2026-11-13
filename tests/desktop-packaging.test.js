import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import zipLib from "zip-lib";
import {
  allPackageSuffixes, extractArchive, hostPackageSuffixes, inspectMachO, inspectWindows,
  packageBudget, signMacBundle, verifyMachOSignature,
} from "../tools/desktop-platform.mjs";
import { verifyPackageContents, verifyRelease } from "../tools/verify-release.mjs";
import { assembleRelease } from "../tools/assemble-release.mjs";

// Minimal executable metadata fixtures, not runnable native programs.
function macho({ arch = "arm64", signed = true, os = 0x0e0000 } = {}) {
  const codeLimit = 4096;
  const bytes = Buffer.alloc(codeLimit + (signed ? 96 : 0));
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(signed ? 2 : 1, 16);
  bytes.writeUInt32LE(signed ? 40 : 24, 20);
  bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(os, 44);
  if (signed) {
    bytes.writeUInt32LE(0x1d, 56);
    bytes.writeUInt32LE(16, 60);
    bytes.writeUInt32LE(codeLimit, 64);
    bytes.writeUInt32LE(96, 68);
    [0xfade0cc0, 96, 1, 0, 20].forEach((value, i) => bytes.writeUInt32BE(value, codeLimit + i * 4));
    const cd = codeLimit + 20;
    [0xfade0c02, 76, 0x20001, 2, 44, 0, 0, 1, codeLimit].forEach((value, i) => bytes.writeUInt32BE(value, cd + i * 4));
    bytes[cd + 36] = 32;
    bytes[cd + 37] = 2;
    bytes[cd + 39] = 12;
    createHash("sha256").update(bytes.subarray(0, codeLimit)).digest().copy(bytes, cd + 44);
  }
  return bytes;
}

function windows() {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "scidigitizer-packaging-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function macApp(directory, { arch = "arm64", signed = true, minimumOS = "14.0.0" } = {}) {
  const contents = join(directory, "SciDigitizer.app", "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  const executable = join(contents, "MacOS", "SciDigitizer");
  await writeFile(executable, macho({ arch, signed }));
  await chmod(executable, 0o755);
  await writeFile(join(contents, "Info.plist"), `<plist><dict><key>LSMinimumSystemVersion</key><string>${minimumOS}</string></dict></plist>`);
}

async function manifest(directory, releases, version = "test") {
  const entries = [];
  for (const file of releases) {
    const bytes = await readFile(join(directory, file));
    entries.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(join(directory, "sizes.json"), JSON.stringify({ version, baseVersion: "0.20.0", debianVersion: "0.20.0-test", budgetBytes: packageBudget, releases: entries }));
  await writeFile(join(directory, "SHA256SUMS.txt"), entries.map((e) => `${e.sha256}  ${e.file}\n`).join(""));
}

test("host builds select only native platforms; Linux cannot emit unsigned Mac packages", () => {
  assert.deepEqual(hostPackageSuffixes("linux", "x64"), ["linux-x64.zip", "linux-arm64.zip", "linux-x64.deb"]);
  assert.deepEqual(hostPackageSuffixes("win32", "x64"), ["windows-x64.zip"]);
  assert.deepEqual(hostPackageSuffixes("darwin", "arm64"), ["macos-arm64.zip"]);
  assert.deepEqual(hostPackageSuffixes("darwin", "x64"), ["macos-x64.zip"]);
  assert.throws(() => hostPackageSuffixes("win32", "arm64"), /not supported/);
});

test("Mach-O inspection reads actual runtime deployment target and architecture", () => {
  assert.equal(inspectMachO(macho()).minimumOS, "14.0.0");
  assert.equal(inspectMachO(macho({ arch: "x64", os: 0x0f0201 })).arch, "x64");
  assert.equal(inspectMachO(macho({ os: 0x0f0201 })).minimumOS, "15.2.1");
});

test("Mach-O inspection rejects truncated or corrupt load commands", () => {
  assert.throws(() => inspectMachO(Buffer.alloc(8)), /Truncated/);
  const bytes = macho();
  bytes.writeUInt32LE(4, 36);
  assert.throws(() => inspectMachO(bytes), /load command/);
});

test("Mac executable must have a signature with matching code-page hashes", () => {
  verifyMachOSignature(macho());
  assert.throws(() => verifyMachOSignature(macho({ signed: false })), /unsigned/);
  const bytes = macho();
  bytes[100] ^= 1;
  assert.throws(() => verifyMachOSignature(bytes), /signature mismatch/);
});

test("Mac signature blob is validated rather than trusting a signature command", () => {
  const bytes = macho();
  bytes.writeUInt32BE(0, 4096);
  assert.throws(() => verifyMachOSignature(bytes), /signature blob/);
});

test("final Mac bundle is signed and verified, and cannot be signed on Linux", async () => {
  const calls = [];
  const runner = async (...args) => { calls.push(args); };
  await signMacBundle("completed.app", runner, "darwin");
  assert.deepEqual(calls, [
    ["codesign", ["--force", "--sign", "-", "completed.app"]],
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", "completed.app"]],
  ]);
  await assert.rejects(signMacBundle("completed.app", runner, "linux"), /must be signed/);
  await assert.rejects(signMacBundle("completed.app", async () => { throw new Error("signing failed"); }, "darwin"), /signing failed/);
});

test("Mac package rejects the old 10.13 declaration, wrong CPU and missing signature", async (t) => {
  const root = await scratch(t);
  await macApp(root);
  // Synthetic fixtures are checked statically, never passed to system codesign.
  const options = { platform: process.platform === "win32" ? "win32" : "linux" };
  await verifyPackageContents(root, "macos-arm64.zip", options);
  await assert.rejects(verifyPackageContents(root, "macos-x64.zip", options), /architecture/);
  await macApp(root, { minimumOS: "10.13" });
  await assert.rejects(verifyPackageContents(root, "macos-arm64.zip", options), /minimum OS mismatch/);
  await macApp(root, { signed: false });
  await assert.rejects(verifyPackageContents(root, "macos-arm64.zip", options), /unsigned/);
});

test("Windows package must contain an x64 PE executable", () => {
  assert.deepEqual(inspectWindows(windows()), { arch: "x64", signed: false });
  const bytes = windows();
  bytes.writeUInt16LE(0x14c, 68);
  assert.throws(() => inspectWindows(bytes), /Windows x64/);
});

test("framework data uses the user profile, not the application install folder", async () => {
  const config = JSON.parse(await readFile(new URL("../neutralino.config.json", import.meta.url), "utf8"));
  assert.equal(config.dataLocation, "system");
  assert.equal(config.storageLocation, "system");
  assert.equal(config.tokenSecurity, "one-time");
  assert.deepEqual(config.nativeAllowList, ["os.showSaveDialog", "filesystem.writeBinaryFile"]);
});

test("native client is present, pinned and configured for injection", async () => {
  const config = JSON.parse(await readFile(new URL("../neutralino.config.json", import.meta.url), "utf8"));
  const client = await readFile(new URL("../desktop/vendor/neutralino.js", import.meta.url));
  assert.equal(config.cli.clientVersion, "6.9.0");
  assert.equal(config.cli.clientLibrary, "/build/desktop-web/neutralino.js");
  assert.equal(config.modes.window.injectClientLibrary, true);
  assert.equal(createHash("sha256").update(client).digest("hex"), "7e9d355ee2e0a0284e4f726b09ed5d7e602b657eacd488b011a6eb390f2a7923");
  const attributes = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  assert.match(attributes, /^desktop\/vendor\/neutralino\.js -text$/m);
  for (const name of ["neutralino-client.LICENSE.txt", "neutralino-runtime.LICENSE.txt"]) {
    assert.match(await readFile(new URL("../desktop/vendor/" + name, import.meta.url), "utf8"), /Copyright/);
  }
});

test("ZIP extraction accepts a symlinked temporary directory without disabling containment checks", async (t) => {
  const root = await scratch(t);
  const source = join(root, "source"), actual = join(root, "actual"), alias = join(root, "alias");
  await mkdir(source); await mkdir(actual);
  // Junctions work on Windows CI without symlink privileges.
  await symlink(actual, alias, "junction");
  await writeFile(join(source, "proof.txt"), "valid archive");
  const archive = join(root, "proof.zip");
  await zipLib.archiveFolder(source, archive);
  await extractArchive(archive, join(alias, "unpacked"));
  assert.equal(await readFile(join(actual, "unpacked", "proof.txt"), "utf8"), "valid archive");
  // Canonicalizing the parent must not allow a nested link to escape the root.
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "proof.txt"), "keep");
  await mkdir(join(source, "escape"));
  await writeFile(join(source, "escape", "proof.txt"), "must not escape");
  await symlink(outside, join(actual, "unpacked", "escape"), "junction");
  const unsafeArchive = join(root, "escape.zip");
  await zipLib.archiveFolder(source, unsafeArchive);
  await assert.rejects(extractArchive(unsafeArchive, join(alias, "unpacked")), /outside|Dangerous/);
  assert.equal(await readFile(join(outside, "proof.txt"), "utf8"), "keep");
});

test("release verifier checks archive contents, hashes, duplicate checksums and size budgets", async (t) => {
  const root = await scratch(t);
  const input = join(root, "input");
  const output = join(root, "output");
  await mkdir(input); await mkdir(output);
  const file = "SciDigitizer-test-windows-x64.zip";
  await writeFile(join(input, "SciDigitizer.exe"), windows());
  await zipLib.archiveFolder(input, join(output, file));
  await manifest(output, [file]);
  const options = { suffixes: ["windows-x64.zip"], version: "test" };
  await verifyRelease(output, options);
  const sums = await readFile(join(output, "SHA256SUMS.txt"), "utf8");
  await writeFile(join(output, "SHA256SUMS.txt"), sums + sums);
  await assert.rejects(verifyRelease(output, options), /duplicate SHA256SUMS/);
  await manifest(output, [file]);
  const metadata = JSON.parse(await readFile(join(output, "sizes.json"), "utf8"));
  metadata.budgetBytes = packageBudget + 1;
  await writeFile(join(output, "sizes.json"), JSON.stringify(metadata));
  await assert.rejects(verifyRelease(output, options), /size budget/);
  await manifest(output, [file]);
  await writeFile(join(output, file), "tampered");
  await assert.rejects(verifyRelease(output, options), /size does not match/);
});

test("all six packages are assembled only from four matching native builds", async (t) => {
  const root = await scratch(t);
  const input = join(root, "input");
  const output = join(root, "output");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await mkdir(input);
  for (const target of ["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"]) {
    const [platform, arch] = target.split("-");
    const directory = join(input, target);
    await mkdir(directory);
    const files = [];
    for (const suffix of hostPackageSuffixes(platform, arch)) {
      const file = `SciDigitizer-${pkg.version}-${suffix}`;
      const source = join(root, "fixture-" + suffix);
      await mkdir(source);
      if (platform === "darwin") await macApp(source, { arch });
      else if (platform === "win32") await writeFile(join(source, "SciDigitizer.exe"), windows());
      else await writeFile(join(source, "SciDigitizer"), "fixture");
      if (suffix.endsWith(".zip")) await zipLib.archiveFolder(source, join(directory, file));
      else await writeFile(join(directory, file), "deb fixture");
      files.push(file);
    }
    await manifest(directory, files, pkg.version);
  }
  const options = { runner: async () => {} }; // Synthetic fixtures have no real bundle seal.
  await assembleRelease(input, output, options);
  const combined = JSON.parse(await readFile(join(output, "sizes.json"), "utf8"));
  assert.equal(combined.releases.length, allPackageSuffixes.length);
  await assert.rejects(assembleRelease(input, output, options), /Refusing to overwrite/);
});

test("packaging refuses to overwrite an existing output directory", async (t) => {
  const directory = await scratch(t);
  const marker = join(directory, "existing-release.txt");
  await writeFile(marker, "keep");
  const script = fileURLToPath(new URL("../tools/package-desktop.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not empty/);
  assert.equal(await readFile(marker, "utf8"), "keep");
});
