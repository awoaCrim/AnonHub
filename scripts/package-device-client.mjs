#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, copyFile, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

import { build } from "esbuild";

import { packageWindowsNode } from "./package-windows-node.mjs";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "windows-node": { type: "string" },
    "windows-arch": { type: "string" },
    "client-version": { type: "string" },
    "agent-desktop": { type: "string" },
  },
});
// A release version makes the client update itself from the site's signed manifest; without one it never does.
const clientVersion = values["client-version"];
if (clientVersion !== undefined && !/^[0-9]{1,6}(\.[0-9]{1,6}){1,3}$/.test(clientVersion)) throw new Error("invalid --client-version, e.g. 2026.1107.1930");
const output = resolve(values.output ?? ".release-local/device-client/dist");
await mkdir(output, { recursive: true });
const dependencyRoots = new Set();
for (const [entry, name] of [
  ["packages/device-client/src/cli.ts", "client.cjs"],
  ["packages/device-gateway/src/cli.ts", "gateway.cjs"],
  ["scripts/migrate-device-state.mjs", "migrate-state.cjs"],
]) {
  const result = await build({
    metafile: true,
    entryPoints: [entry],
    outfile: join(output, name),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    // ws optional native accelerators are unnecessary; the portable JavaScript implementation is used.
    external: ["bufferutil", "utf-8-validate"],
    banner: { js: "const __yesimbot_module_url = require('node:url').pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__yesimbot_module_url", ...(clientVersion ? { __YESIMBOT_CLIENT_VERSION__: JSON.stringify(clientVersion) } : {}) },
    logLevel: "warning",
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) dependencyRoots.add(match[1]);
  }
}
const notices = [];
for (const root of [...dependencyRoots].sort()) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const licenseFiles = (await readdir(root)).filter((name) => /^(license|licence|copying|notice)(\.|$)/i.test(name));
  notices.push(`\n${manifest.name}@${manifest.version} (${manifest.license ?? "see package"})\n`);
  for (const file of licenseFiles) notices.push(await readFile(join(root, file), "utf8"));
}
await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
await copyFile("packages/device-client/windows/install.ps1", join(output, "install.ps1"));
await copyFile("packages/device-client/windows/Install.cmd", join(output, "Install.cmd"));
await copyFile("packages/device-client/README.md", join(output, "README.md"));
await copyFile("LICENSE", join(output, "LICENSE"));
if (values["windows-node"]) await packageWindowsNode(output, values["windows-node"], values["windows-arch"]);
if (values["agent-desktop"]) await packageAgentDesktop(output, values["agent-desktop"], values["windows-node"] ? "windows" : "portable");
else if (values["windows-node"]) {
  // A Windows client must actually contain its native desktop driver. Verify the pinned tarball below.
  const temporary = await mkdtemp(join(tmpdir(), "yesimbot-desktop-package-"));
  try {
    const response = await fetch("https://registry.npmjs.org/agent-desktop/-/agent-desktop-1.2.0.tgz", {
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error("desktop_driver_download_failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 256 * 1024 * 1024) throw new Error("desktop_driver_download_too_large");
    const tarball = join(temporary, "desktop.tgz");
    await writeFile(tarball, bytes);
    await packageAgentDesktop(output, tarball, "windows");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const entries = [];
for (const file of (await readdir(output)).filter((name) => name !== "SHA256SUMS").sort()) {
  const bytes = await readFile(join(output, file));
  entries.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
await writeFile(join(output, "SHA256SUMS"), entries.join("\n") + "\n");
process.stdout.write(output + "\n");

/**
 * agent-desktop, the desktop driver, ships beside client.cjs: the npm tarball (checked against the pinned
 * registry digest) carries every platform's binary with its own SHA-256. The portable package takes macOS and
 * Linux x64 (whose clipboard helper must sit beside it under its plain name); the Windows package takes Windows x64.
 */
async function packageAgentDesktop(output, tarball, kind) {
  const integrity = "sha512-sp8hHs8JfnuZe8ZQwiKZrqSOlu26SSeZXkjDog4KsU31L09G3uZJa8pITGN2vORif9uuh0iOSJHD146CEyTqag=="; // agent-desktop@1.2.0
  const bytes = await readFile(tarball);
  if ("sha512-" + createHash("sha512").update(bytes).digest("base64") !== integrity)
    throw new Error("agent-desktop tarball does not match agent-desktop@1.2.0");
  const work = await mkdtemp(join(tmpdir(), "agent-desktop-"));
  try {
    execFileSync("tar", ["-xzf", resolve(tarball), "-C", work]);
    const files =
      kind === "windows"
        ? [["agent-desktop-win32-x64.exe"]]
        : [
            ["agent-desktop-darwin-arm64"],
            ["agent-desktop-macos-helper-darwin-arm64"],
            ["agent-desktop-darwin-x64"],
            ["agent-desktop-macos-helper-darwin-x64"],
            ["agent-desktop-linux-x64"],
            ["agent-desktop-linux-clipboard-owner-linux-x64", "agent-desktop-linux-clipboard-owner"],
          ];
    for (const [name, target = name] of files) {
      const data = await readFile(join(work, "package/bin", name));
      const expected = (await readFile(join(work, "package/bin", name + ".sha256"), "utf8")).trim().split(/\s+/)[0];
      if (createHash("sha256").update(data).digest("hex") !== expected) throw new Error(`agent-desktop checksum mismatch: ${name}`);
      await writeFile(join(output, target), data, { mode: 0o755 });
    }
    notices.push("\nagent-desktop@1.2.0 (Apache-2.0) https://github.com/vercel-labs/agent-desktop\n");
    await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
