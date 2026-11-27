import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serveDownloads } from "../src/downloads.js";
import { HttpServer } from "../src/http.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function site(): Promise<{ base: string; downloads: string }> {
  const state = await mkdtemp(join(tmpdir(), "yesimbot-downloads-"));
  const server = new HttpServer();
  serveDownloads(server, state);
  await server.listen("127.0.0.1", 0);
  cleanup.push(async () => {
    await server.close();
    await rm(state, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.port}`, downloads: join(state, "downloads") };
}

describe("the site's downloads", () => {
  it("serves the manifest uncached and the packages as cached attachments", async () => {
    const { base, downloads } = await site();
    await mkdir(downloads);
    await writeFile(join(downloads, "client.json"), '{"version":1,"releases":[]}');
    await writeFile(join(downloads, "yesimbot-client-portable-2026.1120.1730-e35b21271059.zip"), Buffer.alloc(1234, 7));

    const manifest = await fetch(`${base}/downloads/client.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(manifest.headers.get("cache-control")).toBe("no-store");
    expect(await manifest.json()).toEqual({ version: 1, releases: [] });

    const zip = await fetch(`${base}/downloads/yesimbot-client-portable-2026.1120.1730-e35b21271059.zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toBe("attachment");
    expect(zip.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(zip.headers.get("content-length")).toBe("1234");
    expect(Buffer.from(await zip.arrayBuffer()).equals(Buffer.alloc(1234, 7))).toBe(true);

    const head = await fetch(`${base}/downloads/client.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  // User, 2026-11-26: 「左下角图标再加个安装app，app需要一个增量更新」 — the phone app's manifest and package.
  it("serves the Android manifest uncached and the APK as a cached attachment of its own type", async () => {
    const { base, downloads } = await site();
    await mkdir(downloads);
    await writeFile(join(downloads, "android.json"), '{"version":1}');
    await writeFile(join(downloads, "anonhub-android-1.3-0123456789ab.apk"), Buffer.alloc(64, 3));

    const manifest = await fetch(`${base}/downloads/android.json`);
    expect(manifest.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(manifest.headers.get("cache-control")).toBe("no-store");
    expect(await manifest.json()).toEqual({ version: 1 });

    const apk = await fetch(`${base}/downloads/anonhub-android-1.3-0123456789ab.apk`);
    expect(apk.status).toBe(200);
    expect(apk.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(apk.headers.get("content-disposition")).toBe("attachment");
    expect(apk.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(apk.headers.get("content-length")).toBe("64");
  });

  it("answers 404 for a missing directory or file, other names, links and paths outside it", async () => {
    const { base, downloads } = await site();
    expect((await fetch(`${base}/downloads/client.json`)).status).toBe(404);
    await mkdir(downloads);
    await writeFile(join(downloads, "notes.txt"), "x");
    await writeFile(join(downloads, "..hidden.zip"), "x");
    await writeFile(join(downloads, "..", "secret.zip"), "x");
    await symlink(join(downloads, "notes.txt"), join(downloads, "linked.zip"));
    await mkdir(join(downloads, "folder.zip"));
    const paths = [
      "missing.zip",
      "missing.apk",
      "other.json",
      "notes.txt",
      "..hidden.zip",
      "..%2Fsecret.zip",
      "%2E%2E%2Fsecret.zip",
      "linked.zip",
      "folder.zip",
      "sub/client.json",
    ];
    const statuses = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, (await fetch(`${base}/downloads/${path}`)).status] as const)));
    expect(statuses).toEqual(Object.fromEntries(paths.map((path) => [path, 404])));
  });
});
