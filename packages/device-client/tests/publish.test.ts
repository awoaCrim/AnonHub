import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { checkPackage, pickRelease, verifyRelease } from "../src/updater.js";
import { readFlatZip } from "../src/zip.js";

const script = resolve(import.meta.dirname, "../../../scripts/publish-device-client.mjs");
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("publishes a signed manifest and a package the client accepts", async () => {
  const root = await mkdtemp(join(tmpdir(), "publish-client-"));
  roots.push(root);
  const version = "2026.1126.1200";
  const keys = generateKeyPairSync("ed25519");
  const key = join(root, "release.pem");
  await writeFile(key, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  const packaged = join(root, "portable");
  await mkdir(packaged);
  const files = { "client.cjs": `const CLIENT_VERSION = ${JSON.stringify(version)};\n`, "LICENSE.txt": "MIT\n" };
  for (const [name, data] of Object.entries(files)) await writeFile(join(packaged, name), data);
  await writeFile(
    join(packaged, "SHA256SUMS"),
    Object.entries(files)
      .map(([name, data]) => `${sha256(data)}  ${name}\n`)
      .join(""),
  );
  const out = join(root, "downloads");

  execFileSync(process.execPath, [script, "--version", version, "--portable", packaged, "--gateway", "https://site.example", "--out", out, "--key", key], {
    stdio: "pipe",
  });

  const manifest = JSON.parse(await readFile(join(out, "client.json"), "utf8"));
  expect(manifest.gateway).toBe("https://site.example");
  const release = pickRelease(manifest, "portable")!;
  expect(release.version).toBe(version);
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  expect(verifyRelease(release, publicKey)).toBe(true);
  expect(verifyRelease({ ...release, sha256: "0".repeat(64) }, publicKey)).toBe(false);
  const bytes = await readFile(join(out, release.url.slice("/downloads/".length)));
  expect(bytes.length).toBe(release.size);
  expect(sha256(bytes)).toBe(release.sha256);
  expect([...checkPackage(readFlatZip(bytes, { maxEntries: 16, maxTotalBytes: 1 << 20 }), "portable").keys()].sort()).toEqual([
    "LICENSE.txt",
    "SHA256SUMS",
    "client.cjs",
  ]);
});

it("refuses a folder that was not packaged with the release version", async () => {
  const root = await mkdtemp(join(tmpdir(), "publish-client-"));
  roots.push(root);
  const key = join(root, "release.pem");
  await writeFile(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  const packaged = join(root, "portable");
  await mkdir(packaged);
  await writeFile(join(packaged, "client.cjs"), 'const CLIENT_VERSION = "0.0.0-dev";\n');
  await writeFile(join(packaged, "SHA256SUMS"), `${sha256('const CLIENT_VERSION = "0.0.0-dev";\n')}  client.cjs\n`);
  expect(() =>
    execFileSync(process.execPath, [script, "--version", "2026.1126.1200", "--portable", packaged, "--out", join(root, "out"), "--key", key], {
      stdio: "pipe",
    }),
  ).toThrow(/not packaged with --client-version/);
});
