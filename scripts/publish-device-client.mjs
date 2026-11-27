#!/usr/bin/env node
// Turns packaged client folders into the files the site serves under /downloads: one flat ZIP per package
// and a signed client.json. Clients install an update only when its manifest entry carries a valid
// signature from the release key, which stays on the release machine (never on a server).
//
//   node scripts/package-device-client.mjs --output .release-local/client/windows-x64 --windows-node v22.23.4 --agent-desktop agent-desktop-1.2.0.tgz --client-version 2026.1107.1930
//   node scripts/package-device-client.mjs --output .release-local/client/portable --agent-desktop agent-desktop-1.2.0.tgz --client-version 2026.1107.1930
//   node scripts/publish-device-client.mjs --version 2026.1107.1930 --windows .release-local/client/windows-x64 \
//     --portable .release-local/client/portable --gateway https://site.example --out .release-local/client/downloads
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    windows: { type: "string" },
    portable: { type: "string" },
    gateway: { type: "string" },
    out: { type: "string" },
    key: { type: "string" },
  },
});
const version = values.version ?? "";
if (!/^[0-9]{1,6}(\.[0-9]{1,6}){1,3}$/.test(version)) throw new Error("--version is required, e.g. 2026.1107.1930");
if (!values.out) throw new Error("--out is required");
const keyPath = resolve(values.key ?? join(homedir(), ".config/yesimbot/client-release-ed25519.pem"));
const key = createPrivateKey(await readFile(keyPath));
if (key.asymmetricKeyType !== "ed25519") throw new Error("the release key must be Ed25519");
const gateway = values.gateway ? new URL(values.gateway) : undefined;
if (gateway && (gateway.protocol !== "https:" || gateway.pathname !== "/" || gateway.search || gateway.hash))
  throw new Error("--gateway must be an https origin");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Same message the client verifies (packages/device-client/src/updater.ts releaseMessage). */
const releaseMessage = (release) =>
  Buffer.from(["yesimbot-client-release:v1", release.platform, release.version, release.url, String(release.size), release.sha256].join("\n"));

/** Reads a packaged folder through its SHA256SUMS, checking every file and the client's stamped version. */
async function packaged(directory, platform) {
  const sums = await readFile(join(directory, "SHA256SUMS"));
  const files = [];
  for (const line of sums.toString("utf8").split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line in ${directory}`);
    const data = await readFile(join(directory, match[2]));
    if (sha256(data) !== match[1]) throw new Error(`checksum mismatch: ${directory}/${match[2]}`);
    files.push({ name: match[2], data });
  }
  files.push({ name: "SHA256SUMS", data: sums });
  const client = files.find((file) => file.name === "client.cjs");
  if (!client?.data.includes(JSON.stringify(version))) throw new Error(`${directory}/client.cjs was not packaged with --client-version ${version}`);
  if (platform === "windows-x64" && !files.some((file) => file.name === "node.exe")) throw new Error(`${directory} has no node.exe`);
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** A flat, deflated ZIP with fixed timestamps, so the same files give the same bytes. */
function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  const time = 0, // 00:00
    date = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8"),
      compressed = deflateRawSync(data, { level: 9 }),
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const out = resolve(values.out);
await mkdir(out, { recursive: true });
const releases = [];
for (const [platform, directory] of [
  ["windows-x64", values.windows],
  ["portable", values.portable],
]) {
  if (!directory) continue;
  const bytes = zip(await packaged(resolve(directory), platform));
  const digest = sha256(bytes);
  const name = `yesimbot-client-${platform}-${version}-${digest.slice(0, 12)}.zip`;
  const file = join(out, name);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  await writeFile(file, bytes, { flag: "wx" });
  const release = { platform, url: `/downloads/${name}`, size: bytes.length, sha256: digest, version };
  releases.push({ ...release, signature: sign(null, releaseMessage(release), key).toString("base64") });
}
if (!releases.length) throw new Error("pass --windows and/or --portable");
const manifest = { version: 1, ...(gateway ? { gateway: gateway.origin } : {}), releases };
await writeFile(join(out, "client.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
