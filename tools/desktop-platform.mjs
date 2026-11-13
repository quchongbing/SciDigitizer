import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import zipLib from "zip-lib";

export async function extractArchive(archive, directory) {
  await mkdir(directory, { recursive: true });
  // macOS aliases /var to /private/var. zip-lib compares paths when checking
  // archive containment, so supply a canonical root without weakening checks.
  const canonical = await realpath(directory);
  // Every caller uses fresh staging. Refuse existing entries, including Windows
  // directory junctions that an unzip library may otherwise follow or replace.
  if ((await readdir(canonical)).length) throw new Error(`Extraction directory is not empty: ${directory}`);
  return zipLib.extract(archive, canonical, { safeSymlinksOnly: true });
}

export const packageBudget = 8 * 1024 * 1024;
export const allPackageSuffixes = [
  "windows-x64.zip", "linux-x64.zip", "linux-arm64.zip",
  "macos-x64.zip", "macos-arm64.zip", "linux-x64.deb",
];

export function hostPackageSuffixes(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && arch === "x64") return ["linux-x64.zip", "linux-arm64.zip", "linux-x64.deb"];
  if (platform === "win32" && arch === "x64") return ["windows-x64.zip"];
  if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return [`macos-${arch}.zip`];
  throw new Error(`Desktop packaging is not supported on ${platform}/${arch}.`);
}

export function localPackageRoot(root) {
  return join(root, "dist-desktop", "packages", `${process.platform}-${process.arch}`);
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${command} failed (${signal ?? code}).`)));
  });
}

function requireBytes(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error("Truncated or invalid native executable.");
  }
}

export function inspectMachO(bytes) {
  requireBytes(bytes, 0, 32);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected a thin 64-bit Mach-O executable.");
  const arch = new Map([[0x01000007, "x64"], [0x0100000c, "arm64"]]).get(bytes.readUInt32LE(4));
  if (!arch) throw new Error("Unsupported Mach-O CPU architecture.");
  const commands = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  requireBytes(bytes, 32, end - 32);
  let position = 32;
  let minimumOS;
  let signature;
  for (let i = 0; i < commands; i++) {
    requireBytes(bytes, position, 8);
    const command = bytes.readUInt32LE(position);
    const length = bytes.readUInt32LE(position + 4);
    if (length < 8 || position + length > end) throw new Error("Invalid Mach-O load command.");
    if (command === 0x32 || command === 0x24) {
      if (length < (command === 0x32 ? 24 : 16)) throw new Error("Invalid Mach-O OS version command.");
      if (command === 0x32 && bytes.readUInt32LE(position + 8) !== 1) throw new Error("Expected a macOS executable.");
      const value = bytes.readUInt32LE(position + (command === 0x32 ? 12 : 8));
      minimumOS = `${value >>> 16}.${(value >>> 8) & 255}.${value & 255}`;
    }
    if (command === 0x1d) {
      if (length !== 16 || signature) throw new Error("Invalid Mach-O signature command.");
      signature = { offset: bytes.readUInt32LE(position + 8), size: bytes.readUInt32LE(position + 12) };
      requireBytes(bytes, signature.offset, signature.size);
    }
    position += length;
  }
  if (position !== end || !minimumOS) throw new Error("Missing or invalid Mach-O load commands / minimum OS.");
  return { arch, minimumOS, signature };
}

// Check executable page hashes on any OS; codesign on macOS additionally checks
// the app bundle seal. This is not a Developer ID or notarization trust check.
export function verifyMachOSignature(bytes, info = inspectMachO(bytes)) {
  if (!info.signature) throw new Error("Mac executable is unsigned; sign the completed app on macOS after resource embedding.");
  const { offset, size } = info.signature;
  if (size < 12 || bytes.readUInt32BE(offset) !== 0xfade0cc0) throw new Error("Invalid Mac code signature blob.");
  const blobLength = bytes.readUInt32BE(offset + 4);
  const count = bytes.readUInt32BE(offset + 8);
  if (blobLength > size || blobLength < 12 + count * 8) throw new Error("Invalid Mac code signature index.");
  let verified = false;
  for (let i = 0; i < count; i++) {
    const type = bytes.readUInt32BE(offset + 12 + i * 8);
    if (type !== 0 && (type < 0x1000 || type > 0x1005)) continue;
    const relative = bytes.readUInt32BE(offset + 16 + i * 8);
    if (relative + 44 > blobLength) throw new Error("Invalid CodeDirectory offset.");
    const cd = offset + relative;
    const length = bytes.readUInt32BE(cd + 4);
    if (bytes.readUInt32BE(cd) !== 0xfade0c02 || length < 44 || relative + length > blobLength) {
      throw new Error("Invalid Mac CodeDirectory.");
    }
    const hashOffset = bytes.readUInt32BE(cd + 16);
    const slots = bytes.readUInt32BE(cd + 28);
    const codeLimit = bytes.readUInt32BE(cd + 32);
    const hashSize = bytes[cd + 36];
    const hashType = bytes[cd + 37];
    const exponent = bytes[cd + 39];
    const algorithm = { 1: ["sha1", 20], 2: ["sha256", 32], 3: ["sha256", 20] }[hashType];
    const pageSize = exponent === 0 ? codeLimit : 2 ** exponent;
    if (!algorithm || algorithm[1] !== hashSize || exponent > 20 || !codeLimit || codeLimit > offset
      || slots !== Math.ceil(codeLimit / pageSize) || hashOffset < 44 || hashOffset + slots * hashSize > length) {
      throw new Error("Unsupported or invalid Mac signature hash layout.");
    }
    for (let slot = 0; slot < slots; slot++) {
      const hash = createHash(algorithm[0]).update(bytes.subarray(slot * pageSize, Math.min((slot + 1) * pageSize, codeLimit)))
        .digest().subarray(0, hashSize);
      if (!hash.equals(bytes.subarray(cd + hashOffset + slot * hashSize, cd + hashOffset + (slot + 1) * hashSize))) {
        throw new Error(`Mac executable code signature mismatch at page ${slot}.`);
      }
    }
    verified = true;
  }
  if (!verified) throw new Error("Mac signature contains no supported CodeDirectory.");
}

export function inspectWindows(bytes) {
  requireBytes(bytes, 0, 64);
  if (bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Expected a Windows PE executable.");
  const pe = bytes.readUInt32LE(60);
  requireBytes(bytes, pe, 24 + 152);
  if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664
    || bytes.readUInt16LE(pe + 24) !== 0x20b) throw new Error("Expected a Windows x64 PE32+ executable.");
  return { arch: "x64", signed: bytes.readUInt32LE(pe + 24 + 112 + 4 * 8) !== 0 };
}

export async function signMacBundle(appDirectory, runner = run, platform = process.platform) {
  if (platform !== "darwin") throw new Error("Mac packages must be signed and verified on macOS, not cross-packaged on Linux/Windows.");
  // Ad-hoc signing fixes arm64 execution, but does not bypass Gatekeeper or
  // provide a verified publisher identity. Never sign before embedding resources.
  await runner("codesign", ["--force", "--sign", "-", appDirectory]);
  await runner("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appDirectory]);
}
