import { copyFile, lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const destination = resolve(process.argv[2] || resolve(projectRoot, "..", "SciDigitizer-public"));
const expectedRemotes = new Set([
  "git@github.com:quchongbing/SciDigitizer.git",
  "ssh://git@github.com/quchongbing/SciDigitizer.git",
  "https://github.com/quchongbing/SciDigitizer.git",
  "https://github.com/quchongbing/SciDigitizer",
]);
const forbiddenText = [
  { label: "private author email", value: ["quchongbing", "gmail.com"].join("@") },
  { label: "absolute home-directory path", value: ["/ho", "me/"].join("") },
  { label: "local Gitea address", value: ["localhost", ":3000"].join("") },
];
const maxPublicFileBytes = 10 * 1024 * 1024;

function git(args, cwd, allowFailure = false) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function trackedFiles(cwd) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd, encoding: "buffer" });
  if (result.status !== 0) throw new Error(result.stderr.toString().trim() || "Unable to list tracked files");
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

async function copyTrackedFile(relativePath) {
  const sourcePath = resolve(projectRoot, relativePath);
  const destinationPath = resolve(destination, relativePath);
  const sourceStat = await lstat(sourcePath);

  await mkdir(dirname(destinationPath), { recursive: true });
  await rm(destinationPath, { force: true, recursive: sourceStat.isDirectory() });

  if (sourceStat.isSymbolicLink()) {
    await symlink(await readlink(sourcePath), destinationPath);
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`Unsupported tracked entry: ${relativePath}`);

  await copyFile(sourcePath, destinationPath);
}

async function auditFile(relativePath, root = projectRoot) {
  const path = resolve(root, relativePath);
  const stat = await lstat(path);
  if (!stat.isFile()) return;
  if (stat.size > maxPublicFileBytes) {
    throw new Error(`${relativePath} is ${(stat.size / 1024 / 1024).toFixed(1)} MiB; public files must stay under 10 MiB`);
  }

  const bytes = await readFile(path);
  if (bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  for (const forbidden of forbiddenText) {
    if (text.includes(forbidden.value)) {
      throw new Error(`${relativePath} contains ${forbidden.label}`);
    }
  }
}

async function main() {
  const sourceOrigin = git(["remote", "get-url", "origin"], projectRoot);
  if (expectedRemotes.has(sourceOrigin)) {
    throw new Error("Run this command from the Gitea development repository, not the public repository");
  }
  if (git(["status", "--porcelain=v1"], projectRoot)) {
    throw new Error("The Gitea development worktree must be clean and committed before synchronization");
  }

  if (git(["rev-parse", "--is-inside-work-tree"], destination, true) !== "true") {
    throw new Error(`Public repository not found at ${destination}`);
  }
  if (git(["branch", "--show-current"], destination) !== "main") {
    throw new Error("The public repository must be on its main branch");
  }
  const publicOrigin = git(["remote", "get-url", "origin"], destination);
  if (!expectedRemotes.has(publicOrigin)) {
    throw new Error(`Refusing unexpected public origin: ${publicOrigin}`);
  }
  if (git(["status", "--porcelain=v1"], destination)) {
    throw new Error("The public worktree must be clean before synchronization");
  }

  const sourceFiles = trackedFiles(projectRoot);
  const sourceSet = new Set(sourceFiles);
  for (const relativePath of sourceFiles) await auditFile(relativePath);

  for (const relativePath of trackedFiles(destination)) {
    if (!sourceSet.has(relativePath)) await rm(resolve(destination, relativePath), { force: true });
  }
  for (const relativePath of sourceFiles) await copyTrackedFile(relativePath);
  for (const relativePath of sourceFiles) await auditFile(relativePath, destination);

  const status = git(["status", "--short"], destination);
  console.log(`Synchronized ${sourceFiles.length} tracked files to ${destination}`);
  console.log("No Git history, commit, or push operation was performed.");
  console.log(status || "Public worktree already matches the development snapshot.");
}

main().catch((error) => {
  console.error(`Public synchronization stopped: ${error.message}`);
  process.exitCode = 1;
});
