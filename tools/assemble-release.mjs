import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allPackageSuffixes, hostPackageSuffixes, packageBudget, run } from "./desktop-platform.mjs";
import { verifyRelease } from "./verify-release.mjs";

export async function assembleRelease(input, output, { runner = run } = {}) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expected = ["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"];
  const actual = await readdir(input);
  if (actual.length !== expected.length || actual.some((name) => !expected.includes(name))) {
    throw new Error("Expected exactly four native build directories: " + expected.join(", "));
  }
  const manifests = [];
  for (const target of expected) {
    const [platform, arch] = target.split("-");
    manifests.push(await verifyRelease(join(input, target), {
      suffixes: hostPackageSuffixes(platform, arch), version: metadata.version, runner,
    }));
  }
  const first = manifests[0];
  if (manifests.some((m) => m.baseVersion !== first.baseVersion || m.debianVersion !== first.debianVersion)) {
    throw new Error("Native build manifests disagree on platform versions.");
  }
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("Refusing to overwrite existing release files: " + output);
  const releases = [];
  for (let i = 0; i < manifests.length; i++) {
    for (const release of manifests[i].releases) {
      await copyFile(join(input, expected[i], release.file), join(output, release.file), constants.COPYFILE_EXCL);
      releases.push(release);
    }
  }
  await writeFile(join(output, "sizes.json"), JSON.stringify({
    version: metadata.version, baseVersion: first.baseVersion, debianVersion: first.debianVersion,
    budgetBytes: packageBudget, releases,
  }, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(output, "SHA256SUMS.txt"), releases.map((r) => `${r.sha256}  ${r.file}\n`).join(""), { flag: "wx" });
  await verifyRelease(output, { suffixes: allPackageSuffixes, version: metadata.version, runner });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: assemble-release.mjs <native-artifact-directory> <empty-output-directory>");
  await assembleRelease(process.argv[2], process.argv[3]);
}
