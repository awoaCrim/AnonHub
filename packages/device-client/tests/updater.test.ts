import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { afterEach, expect, it, vi } from "vitest";

import {
  checkPackage,
  ClientUpdater,
  newerRuntime,
  pickRelease,
  readInstalledRuntime,
  releaseMessage,
  verifyRelease,
  type ClientRelease,
  type InstalledRuntime,
} from "../src/updater.js";
import { compareVersions, isReleaseVersion } from "../src/version.js";
import { readFlatZip } from "../src/zip.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const other = generateKeyPairSync("ed25519");

/** The same flat ZIP layout scripts/publish-device-client.mjs writes. */
function zip(files: { name: string; data: Buffer; stored?: boolean }[]) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data, stored } of files) {
    const nameBytes = Buffer.from(name),
      body = stored ? data : deflateRawSync(data),
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
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

/** A package as the packaging script lays it out: files plus SHA256SUMS. */
function bundle(files: Record<string, string>) {
  const entries = Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) }));
  const sums = entries.map((entry) => `${sha256(entry.data)}  ${entry.name}`).join("\n") + "\n";
  return [...entries, { name: "SHA256SUMS", data: Buffer.from(sums) }];
}

function release(bytes: Buffer, version: string, platform: ClientRelease["platform"] = "portable", key = keys.privateKey): ClientRelease {
  const entry = { platform, url: `/downloads/yesimbot-client-${platform}-${version}.zip`, size: bytes.length, sha256: sha256(bytes), version };
  return { ...entry, signature: sign(null, releaseMessage(entry), key).toString("base64") };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});
async function state() {
  const directory = await mkdtemp(join(tmpdir(), "yesimbot-update-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function site(files: Record<string, Buffer>) {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const body = files[request.url ?? ""];
    response.statusCode = body ? 200 : 404;
    response.end(body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

it("compares release versions and tells releases from source builds", () => {
  expect(compareVersions("2026.1107.1930", "2026.1107.930")).toBe(1);
  expect(compareVersions("2026.1107", "2026.1107.0")).toBe(0);
  expect(compareVersions("2026.1106.2359", "2026.1107.1")).toBe(-1);
  expect(isReleaseVersion("2026.1107.1930")).toBe(true);
  expect(isReleaseVersion("0.0.0-dev")).toBe(false);
});

it("reads only flat, intact ZIP files", () => {
  const files = [
    { name: "client.cjs", data: Buffer.from("console.log(1)") },
    { name: "README.md", data: Buffer.from("readme"), stored: true },
  ];
  expect(readFlatZip(zip(files), { maxEntries: 8, maxTotalBytes: 1024 }).map((entry) => [entry.name, entry.data.toString()])).toEqual([
    ["client.cjs", "console.log(1)"],
    ["README.md", "readme"],
  ]);
  for (const name of ["../client.cjs", "dir/client.cjs", ".hidden", "a\\b"])
    expect(() => readFlatZip(zip([{ name, data: Buffer.from("x") }]), { maxEntries: 8, maxTotalBytes: 1024 })).toThrow("zip_unsafe_name");
  expect(() => readFlatZip(zip(files), { maxEntries: 1, maxTotalBytes: 1024 })).toThrow("zip_too_many_entries");
  expect(() => readFlatZip(zip(files), { maxEntries: 8, maxTotalBytes: 4 })).toThrow("zip_too_large");
  const corrupt = zip([{ name: "client.cjs", data: Buffer.from("abcdef"), stored: true }]);
  corrupt[41] ^= 0xff; // a byte of the stored data (30-byte header + 10-byte name)
  expect(() => readFlatZip(corrupt, { maxEntries: 8, maxTotalBytes: 1024 })).toThrow("zip_corrupt_entry");
});

it("accepts only signed, well-formed releases of its own package", () => {
  const bytes = Buffer.from("zip");
  const good = release(bytes, "2026.1107.1930");
  expect(verifyRelease(good, publicKey)).toBe(true);
  expect(verifyRelease({ ...good, version: "2026.1107.1931" }, publicKey)).toBe(false);
  expect(verifyRelease(release(bytes, "2026.1107.1930", "portable", other.privateKey), publicKey)).toBe(false);
  const windows = release(bytes, "2026.1107.1930", "windows-x64");
  expect(pickRelease({ version: 1, releases: [windows, good] }, "portable")).toEqual(good);
  expect(pickRelease({ version: 1, releases: [{ ...good, url: "https://elsewhere.example/x.zip" }] }, "portable")).toBeUndefined();
  expect(pickRelease({ version: 1, releases: [{ ...good, version: "latest" }] }, "portable")).toBeUndefined();
  expect(() => pickRelease({ version: 2, releases: [] }, "portable")).toThrow("invalid_release_manifest");
});

it("checks every packaged file against SHA256SUMS", () => {
  const files = bundle({ "client.cjs": "x", LICENSE: "l" });
  expect([...checkPackage(files, "portable").keys()].sort()).toEqual(["LICENSE", "SHA256SUMS", "client.cjs"]);
  expect(() => checkPackage([...files, { name: "extra.js", data: Buffer.from("x") }], "portable")).toThrow("package_checksum_mismatch");
  expect(() =>
    checkPackage(
      files.filter((file) => file.name !== "LICENSE"),
      "portable",
    ),
  ).toThrow("package_file_missing");
  expect(() => checkPackage(files, "windows-x64")).toThrow("package_file_missing");
  const tampered = files.map((file) => (file.name === "client.cjs" ? { ...file, data: Buffer.from("y") } : file));
  expect(() => checkPackage(tampered, "portable")).toThrow("package_checksum_mismatch");
});

it("installs a newer signed release beside the current one and restarts into it when idle", async () => {
  const root = await state();
  const bytes = zip(bundle({ "client.cjs": "new client", LICENSE: "l" }));
  const entry = release(bytes, "2026.1108.1");
  const server = await site({ "/downloads/client.json": Buffer.from(JSON.stringify({ version: 1, releases: [entry] })), [entry.url]: bytes });
  let busy = true;
  const restarted: InstalledRuntime[] = [],
    tested: string[] = [];
  const updater = await ClientUpdater.open({
    state: root,
    gateway: async () => ({ url: server.url, allowLoopback: true }),
    restart: async (runtime) => void restarted.push(runtime),
    idle: () => !busy,
    idlePoll: 5,
    version: "2026.1107.1",
    platform: "portable",
    publicKey,
    smokeTest: async (_state, runtime) => void tested.push(runtime.directory),
  });
  const checking = updater.check();
  // Downloaded and installed, but something is still running: it waits. Install time varies (a loaded CI runner took
  // longer than a fixed 50 ms), so wait for the state rather than a delay.
  await vi.waitFor(() => expect(updater.snapshot()).toMatchObject({ status: "waiting", latest: "2026.1108.1" }), { timeout: 5000, interval: 10 });
  expect(restarted).toEqual([]);
  busy = false;
  await checking;
  expect(restarted).toHaveLength(1);
  const runtime = restarted[0]!;
  expect(runtime).toMatchObject({ version: "2026.1108.1", client: "client.cjs", sha256: sha256(Buffer.from("new client")) });
  expect(tested).toEqual([expect.stringMatching(new RegExp(`^\\.${runtime.directory.replaceAll(".", "\\.")}\\.[0-9a-f-]{36}\\.staging$`))]);
  expect(await readFile(join(root, runtime.directory, "client.cjs"), "utf8")).toBe("new client");
  expect(await readInstalledRuntime(root)).toEqual(runtime);
  // An older client started from an old shortcut hands over to it; the new one and newer ones do not.
  expect(await newerRuntime(root, "2026.1107.1")).toBe(join(root, runtime.directory, "client.cjs"));
  expect(await newerRuntime(root, "2026.1108.1")).toBeUndefined();
  expect(await newerRuntime(root, "0.0.0-dev")).toBeUndefined();
  await writeFile(join(root, runtime.directory, "client.cjs"), "tampered");
  expect(await newerRuntime(root, "2026.1107.1")).toBeUndefined();
});

it("never installs an unsigned release, a release for a source build, or without consent", async () => {
  const root = await state();
  const bytes = zip(bundle({ "client.cjs": "new" }));
  const forged = release(bytes, "2026.1108.1", "portable", other.privateKey);
  const server = await site({ "/downloads/client.json": Buffer.from(JSON.stringify({ version: 1, releases: [forged] })), [forged.url]: bytes });
  const options = {
    state: root,
    gateway: async () => ({ url: server.url, allowLoopback: true }),
    restart: async () => {
      throw new Error("must_not_restart");
    },
    version: "2026.1107.1",
    platform: "portable" as const,
    publicKey,
    smokeTest: async () => {},
  };
  const updater = await ClientUpdater.open(options);
  await updater.check();
  expect(updater.snapshot()).toMatchObject({ status: "error", error: "release_signature_invalid" });
  expect(server.requests).toEqual(["/downloads/client.json"]);

  const source = await ClientUpdater.open({ ...options, version: "0.0.0-dev" });
  await source.check(true);
  expect(source.snapshot()).toMatchObject({ supported: false, status: "idle" });
  expect(server.requests).toHaveLength(1);

  // Automatic updates off: a check reports the new version and downloads nothing.
  const signed = release(bytes, "2026.1108.1");
  const manual = await site({ "/downloads/client.json": Buffer.from(JSON.stringify({ version: 1, releases: [signed] })), [signed.url]: bytes });
  const off = await ClientUpdater.open({ ...options, gateway: async () => ({ url: manual.url, allowLoopback: true }) });
  await off.setAuto(false);
  expect((await ClientUpdater.open(options)).snapshot().auto).toBe(false);
  await off.check();
  expect(off.snapshot()).toMatchObject({ status: "idle", latest: "2026.1108.1", auto: false });
  expect(manual.requests).toEqual(["/downloads/client.json"]);
  expect((await readdir(root)).filter((name) => name.startsWith("runtime"))).toEqual([]);

  // Cleartext sites are refused unless they are this computer.
  const plain = await ClientUpdater.open({ ...options, gateway: async () => ({ url: "http://downloads.example" }) });
  await plain.check();
  expect(plain.snapshot()).toMatchObject({ status: "error", error: "gateway_not_https" });
});

it("removes unfinished unpacks and old runtimes, keeping the installed one and the newest other", async () => {
  const root = await state();
  for (const name of [
    "runtime-v2026.1105.1-aaaaaaaa",
    "runtime-v2026.1106.1-bbbbbbbb",
    "runtime-v2026.1107.1-cccccccc",
    "runtime-v2026.1108.1-dddddddd.partial",
    ".runtime-v2026.1108.1-eeeeeeee.11111111-1111-4111-8111-111111111111.staging",
    "runtime-0123abcd",
  ])
    await mkdir(join(root, name));
  await writeFile(join(root, "runtime-v2026.1107.1-cccccccc", "client.cjs"), "c");
  const { writePrivateJson } = await import("../src/config.js");
  await writePrivateJson(join(root, "runtime.json"), {
    version: 1,
    runtime: { version: "2026.1107.1", directory: "runtime-v2026.1107.1-cccccccc", client: "client.cjs", sha256: sha256(Buffer.from("c")) },
  });
  const updater = await ClientUpdater.open({
    state: root,
    gateway: async () => undefined,
    restart: async () => {},
    version: "2026.1107.1",
    platform: "portable",
  });
  await updater.cleanup();
  expect((await readdir(root)).filter((name) => name.startsWith("runtime-")).sort()).toEqual([
    "runtime-0123abcd", // installed by install.ps1: never touched
    "runtime-v2026.1106.1-bbbbbbbb",
    "runtime-v2026.1107.1-cccccccc",
  ]);
  expect(existsSync(join(root, "runtime-v2026.1108.1-dddddddd.partial"))).toBe(false);
  expect(existsSync(join(root, ".runtime-v2026.1108.1-eeeeeeee.11111111-1111-4111-8111-111111111111.staging"))).toBe(false);
});

it("points the Windows shortcuts at the new runtime in the encoding install.ps1 writes", async () => {
  const root = await state();
  for (const name of ["settings.vbs", "run-hidden.vbs"]) await writeFile(join(root, name), "old");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const { rewriteLaunchers } = await import("../src/updater.js");
    await rewriteLaunchers(root, {
      version: "2026.1108.1",
      directory: "runtime-v2026.1108.1-abcdef12",
      client: "client.cjs",
      node: "node.exe",
      sha256: "0".repeat(64),
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  const bytes = await readFile(join(root, "run-hidden.vbs"));
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  const node = join(root, "runtime-v2026.1108.1-abcdef12", "node.exe"),
    client = join(root, "runtime-v2026.1108.1-abcdef12", "client.cjs");
  expect(bytes.subarray(2).toString("utf16le")).toBe(
    `WScript.Quit CreateObject("WScript.Shell").Run("""${node}"" ""${client}"" ui --auto-start --state ""${root}""", 0, True)`,
  );
  expect((await readFile(join(root, "settings.vbs"))).subarray(2).toString("utf16le")).toContain("ui --open");
  // Only launchers that exist are rewritten.
  expect(existsSync(join(root, "exit.vbs"))).toBe(false);
});
