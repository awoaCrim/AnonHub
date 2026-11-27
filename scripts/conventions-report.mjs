#!/usr/bin/env node
// Counts the convention warnings (`.trellis/spec/conventions/index.md`, 「lint 分两步打开」) per module.
//   yarn conventions            table of every module that still has warnings
//   yarn conventions --check    fails when a module listed in tools/conventions-migrated.json has any
//   yarn conventions <module>   every warning of one module, e.g. core/src/tasks or plugins/memorizer
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../..");
const MIGRATED = join(REPO, "tools/conventions-migrated.json");
/** Short column names for the rules the conventions turned on. */
const COLUMNS = [
  ["koishi", (code, message) => code === "eslint(no-restricted-imports)" && /Koishi|SQLite/.test(message)],
  ["fetch", (code) => code === "eslint(no-restricted-globals)"],
  ["time", (code, message) => code === "eslint(no-restricted-properties)" && /规范 06/.test(message)],
  [
    "fs/ids",
    (code, message) =>
      (code === "eslint(no-restricted-imports)" && !/Koishi|SQLite/.test(message)) || (code === "eslint(no-restricted-properties)" && !/规范 06/.test(message)),
  ],
  ["console", (code) => code === "eslint(no-console)"],
  ["errors", (code) => code === "eslint(preserve-caught-error)" || code === "eslint(no-throw-literal)"],
  ["cycle", (code) => code === "import(no-cycle)"],
  ["platform", (code) => code === "conventions(no-platform-literal)"],
];

function main() {
  const args = process.argv.slice(2);
  const modules = collect();
  if (args.includes("--check")) {
    const migrated = JSON.parse(readFileSync(MIGRATED, "utf8")).modules;
    const missing = migrated.filter((key) => !existsSync(join(REPO, key)));
    for (const key of missing) console.error(`${key}: no such module (tools/conventions-migrated.json)`);
    const failing = migrated.filter((key) => modules.has(key));
    for (const key of failing) console.error(`${key}: ${modules.get(key).total} convention warning(s)\n  ${modules.get(key).items.join("\n  ")}`);
    if (failing.length || missing.length) process.exit(1);
    console.log(`conventions: ${migrated.length} migrated module(s) clean`);
  } else if (args[0]) {
    const entry = modules.get(args[0].replace(/\/+$/, ""));
    console.log(entry ? entry.items.join("\n") : `${args[0]}: no convention warnings`);
  } else {
    console.log(table(modules));
  }
}

function sourceRoots() {
  const roots = ["core/src"];
  for (const parent of ["apps", "packages", "platforms", "plugins", "providers"])
    for (const name of readdirSync(join(REPO, parent)).sort()) if (existsSync(join(REPO, parent, name, "src"))) roots.push(`${parent}/${name}/src`);
  return roots;
}

/** core/src/<dir> for Core (its top-level files are `core/src`), the package directory for everything else. */
function moduleOf(file) {
  const parts = relative(REPO, resolve(REPO, file)).split(sep);
  if (parts[0] === "core") return parts.length > 3 ? `core/src/${parts[2]}` : "core/src";
  return `${parts[0]}/${parts[1]}`;
}

function collect() {
  let output;
  try {
    output = execFileSync(join(REPO, "node_modules/.bin/oxlint"), ["-f", "json", ...sourceRoots()], { cwd: REPO, encoding: "utf8", maxBuffer: 256 << 20 });
  } catch (error) {
    // oxlint exits non-zero when other rules report errors; its JSON is still complete.
    output = error.stdout;
    if (!output) throw error;
  }
  const modules = new Map();
  for (const diagnostic of JSON.parse(output).diagnostics) {
    const column = COLUMNS.find(([, matches]) => matches(diagnostic.code, diagnostic.message + (diagnostic.help ?? "")));
    if (!column) continue;
    const key = moduleOf(diagnostic.filename);
    const entry = modules.get(key) ?? { total: 0, columns: Object.fromEntries(COLUMNS.map(([name]) => [name, 0])), items: [] };
    entry.total++;
    entry.columns[column[0]]++;
    const line = diagnostic.labels?.[0]?.span?.line;
    entry.items.push(`${relative(REPO, resolve(REPO, diagnostic.filename))}${line ? `:${line}` : ""}  ${column[0]}  ${diagnostic.help ?? diagnostic.message}`);
    modules.set(key, entry);
  }
  return modules;
}

function table(modules) {
  const rows = [...modules].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
  const width = Math.max(6, ...rows.map(([key]) => key.length));
  const head = ["module".padEnd(width), "total".padStart(6), ...COLUMNS.map(([name]) => name.padStart(8))].join(" ");
  const lines = [head, "-".repeat(head.length)];
  for (const [key, entry] of rows)
    lines.push([key.padEnd(width), String(entry.total).padStart(6), ...COLUMNS.map(([name]) => String(entry.columns[name] || "").padStart(8))].join(" "));
  const sum = (name) => rows.reduce((total, [, entry]) => total + (name ? entry.columns[name] : entry.total), 0);
  lines.push("-".repeat(head.length), ["all".padEnd(width), String(sum()).padStart(6), ...COLUMNS.map(([name]) => String(sum(name)).padStart(8))].join(" "));
  return lines.join("\n");
}

main();
