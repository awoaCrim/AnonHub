import { createHash } from "node:crypto";
import { mkdir, cp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { packageWindowsNode } from "./package-windows-node.mjs";

const { values } = parseArgs({ options: { output: { type: "string" }, "windows-node": { type: "string", default: "v22.23.4" } } });
const output = resolve(values.output ?? ".release-local/local-runtime/dist");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("local_runtime_output_must_be_empty");
const root = JSON.parse(await readFile("package.json", "utf8"));
// A source/built-package allowlist, never operator state, chat data or credentials.
await writeFile(join(output, "package.json"), JSON.stringify({ ...root, scripts: {} }, null, 2));
for (const file of ["yarn.lock", "LICENSE", ".yarn/releases", ".yarn/patches"]) {
  try {
    await cp(file, join(output, file), { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT" || file !== ".yarn/patches") throw error;
  }
}
await writeFile(join(output, ".yarnrc.yml"), "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.12.0.cjs\nenableScripts: false\n");
for (const pattern of root.workspaces) {
  let directories;
  try {
    directories = pattern.endsWith("/*")
      ? (await readdir(pattern.slice(0, -2), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(pattern.slice(0, -2), entry.name))
      : [pattern];
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const directory of directories) {
    try {
      await stat(join(directory, "package.json"));
    } catch {
      continue;
    }
    await mkdir(join(output, directory), { recursive: true });
    for (const name of ["package.json", "dist", "lib"]) {
      try {
        await cp(join(directory, name), join(output, directory, name), { recursive: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}
for (const [source, target] of [
  ["scripts/local-runtime-host.mjs", "host.mjs"],
  ["scripts/local-runtime-entry.cjs", "entry.cjs"],
  ["plugins/console/src/shared/context-policy.json", "context-policy.json"],
  ["packages/device-client/windows/desktop-worker.ps1", "desktop-worker.ps1"],
  ["scripts/windows/install-local-runtime.ps1", "install.ps1"],
])
  await cp(source, join(output, target));
await packageWindowsNode(output, values["windows-node"], "x64");
const manifest = [];
async function scan(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error("runtime_package_symlink");
    if (entry.isDirectory()) await scan(join(directory, entry.name), name + "/");
    else
      manifest.push({
        path: name,
        sha256: createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex"),
      });
  }
}
await scan(output);
await writeFile(
  join(output, "release.json"),
  JSON.stringify(
    { version: 1, release: `local-${new Date().toISOString().replace(/[^0-9]/g, "")}`, files: manifest.sort((a, b) => a.path.localeCompare(b.path)) },
    null,
    2,
  ),
);
console.log(output);
