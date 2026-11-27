import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const output = path.join(root, "runtime");
fs.mkdirSync(output, { recursive: true });
for (const name of ["node_modules", "package.json", "yarn.lock", ".yarnrc.yml", ".yarn/releases"])
  fs.cpSync(path.join(root, name), path.join(output, name), { recursive: true, verbatimSymlinks: true });
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const pattern of pkg.workspaces) {
  if (pattern.endsWith("/*") && !fs.existsSync(pattern.slice(0, -2))) continue;
  const directories = pattern.endsWith("/*")
    ? fs
        .readdirSync(pattern.slice(0, -2), { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => `${pattern.slice(0, -2)}/${item.name}`)
    : [pattern];
  for (const directory of directories) {
    if (!fs.existsSync(`${directory}/package.json`)) continue;
    fs.mkdirSync(path.join(output, directory), { recursive: true });
    for (const entry of ["package.json", "dist", "lib", "node_modules"]) {
      if (fs.existsSync(`${directory}/${entry}`))
        fs.cpSync(`${directory}/${entry}`, path.join(output, directory, entry), { recursive: true, verbatimSymlinks: true });
    }
  }
}
