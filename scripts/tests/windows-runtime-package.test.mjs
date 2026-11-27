import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { packageWindowsNode } from "../package-windows-node.mjs";

test("Windows runtime packaging requires a pinned official version and verifies bytes before writing executable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "device-runtime-pack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("MZ simulated PE binary"),
    hash = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    if (url.endsWith("SHASUMS256.txt")) return new Response(`${hash}  win-x64/node.exe\n`);
    if (url.endsWith("LICENSE")) return new Response("Runtime license");
    return new Response(bytes);
  });
  await assert.rejects(packageWindowsNode(directory, "latest"), /invalid_windows_node_version/);
  assert.equal(calls.length, 0);
  await packageWindowsNode(directory, "v22.23.4");
  assert.deepEqual(await readFile(join(directory, "node.exe")), bytes);
  assert.equal(JSON.parse(await readFile(join(directory, "node-runtime.json"), "utf8")).sha256, hash);
  assert.deepEqual(calls, [
    "https://nodejs.org/dist/v22.23.4/SHASUMS256.txt",
    "https://nodejs.org/dist/v22.23.4/win-x64/node.exe",
    "https://raw.githubusercontent.com/nodejs/node/v22.23.4/LICENSE",
  ]);
});
test("Windows runtime packaging rejects a checksum mismatch without leaving an executable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "device-runtime-pack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => new Response(url.endsWith("SHASUMS256.txt") ? `${"a".repeat(64)}  win-x64/node.exe\n` : "MZ tampered"));
  await assert.rejects(packageWindowsNode(directory, "v22.23.4"), /node_checksum_mismatch/);
  await assert.rejects(readFile(join(directory, "node.exe")), { code: "ENOENT" });
});
