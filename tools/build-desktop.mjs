import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPackageSuffixes, localPackageRoot, run } from "./desktop-platform.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
hostPackageSuffixes();
const output = process.argv[2] ?? localPackageRoot(root);
await access(output).then(async () => {
  if ((await readdir(output)).length) throw new Error(`Output directory is not empty: ${output}. Choose a new output directory.`);
}, (error) => { if (error.code !== "ENOENT") throw error; });
for (const script of ["build-file-bundle.mjs", "prepare-desktop.mjs"]) {
  await run(process.execPath, [join(root, "tools", script)], { cwd: root });
}
// neu --clean deletes the entire distribution tree, including old releases.
// The bundler already replaces its input binaries and embedded resources.
await run(process.execPath, [join(root, "node_modules", "@neutralinojs", "neu", "bin", "neu.js"), "build", "--embed-resources"], { cwd: root });
await run(process.execPath, [join(root, "tools", "package-desktop.mjs"), output], { cwd: root });
await run(process.execPath, [join(root, "tools", "verify-release.mjs"), output, "--host"], { cwd: root });
