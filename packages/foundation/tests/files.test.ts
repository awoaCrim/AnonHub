import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppError,
  contentHash,
  isInside,
  pendingPathLocks,
  createDirectory,
  publishDirectory,
  readPrivateFile,
  resolveInside,
  withPathLock,
  writeFileAtomic,
  writeJsonAtomic,
} from "../src/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "foundation-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof AppError ? error.code : String(error)),
  );

describe("writeFileAtomic", () => {
  it("writes a private file and leaves no temporary file", async () => {
    const path = join(root, "a.json");
    await writeJsonAtomic(path, { b: 1 });
    expect(await readFile(path, "utf8")).toBe('{\n  "b": 1\n}\n');
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["a.json"]);
  });

  it("writes exactly the given mode whatever the umask", async () => {
    if (process.platform === "win32") return;
    const path = join(root, "script.sh");
    const previous = process.umask(0o077);
    try {
      await writeFileAtomic(path, "#!/bin/sh\n", { mode: 0o755 });
    } finally {
      process.umask(previous);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o755);
  });

  it("checks the expected content under the lock", async () => {
    const path = join(root, "card.txt");
    expect(await code(writeFileAtomic(path, "one", { expect: "absent" }))).toBe("ok");
    expect(await code(writeFileAtomic(path, "two", { expect: "absent" }))).toBe("file_changed");
    expect(await code(writeFileAtomic(path, "two", { expect: new TextEncoder().encode("one") }))).toBe("ok");
    expect(await code(writeFileAtomic(path, "three", { expect: { sha256: contentHash("one") } }))).toBe("file_changed");
    expect(await code(writeFileAtomic(path, "three", { expect: { sha256: contentHash("two").toUpperCase() } }))).toBe("ok");
    expect(await readFile(path, "utf8")).toBe("three");
    expect(await readdir(root)).toEqual(["card.txt"]);
  });

  it("lets only one of two concurrent conditional writers win", async () => {
    const path = join(root, "race.txt");
    await writeFileAtomic(path, "base");
    const base = { sha256: contentHash("base") };
    const results = await Promise.all([code(writeFileAtomic(path, "left", { expect: base })), code(writeFileAtomic(path, "right", { expect: base }))]);
    expect(results.sort()).toEqual(["file_changed", "ok"]);
  });

  it("does not write after an abort", async () => {
    const path = join(root, "aborted.txt");
    const controller = new AbortController();
    controller.abort();
    await expect(writeFileAtomic(path, "x", { signal: controller.signal })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});

describe("withPathLock", () => {
  it("serializes one file across spellings, is re-entrant, and cleans up", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = withPathLock(join(root, "x"), async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    // The lock promises mutual exclusion, not call order: each call resolves its key asynchronously, so the second
    // call is made once the first one holds the lock.
    await vi.waitFor(() => expect(order).toContain("first:start"), { timeout: 10_000 });
    const second = withPathLock(join(root, "sub", "..", "x"), async () => {
      order.push("second");
      return withPathLock(join(root, "x"), async () => "nested");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first:start"]);
    release();
    await first;
    expect(await second).toBe("nested");
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(pendingPathLocks()).toBe(0);
  }, 20_000);

  it("releases the lock when the function throws", async () => {
    await expect(withPathLock(join(root, "y"), async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withPathLock(join(root, "y"), async () => "next")).toBe("next");
    expect(pendingPathLocks()).toBe(0);
  });
});

describe("createDirectory", () => {
  it("moves a filled directory into place once and never replaces one with content", async () => {
    const target = join(root, "channel");
    await createDirectory(target, async (staging) => writeFile(join(staging, "channel.json"), "{}"));
    expect(await readFile(join(target, "channel.json"), "utf8")).toBe("{}");
    await expect(createDirectory(target, async (staging) => writeFile(join(staging, "channel.json"), "[]"))).rejects.toThrow();
    expect(await readFile(join(target, "channel.json"), "utf8")).toBe("{}");
    await expect(
      createDirectory(join(root, "other"), async () => {
        throw new Error("fill failed");
      }),
    ).rejects.toThrow("fill failed");
    expect((await readdir(root)).sort()).toEqual(["channel"]);
  });
});

describe("publishDirectory", () => {
  it("swaps a filled directory in and keeps the old one when filling fails", async () => {
    const target = join(root, "site");
    await publishDirectory(target, async (staging) => writeFile(join(staging, "v"), "1"));
    expect(await readFile(join(target, "v"), "utf8")).toBe("1");
    await expect(
      publishDirectory(target, async (staging) => {
        await writeFile(join(staging, "v"), "2");
        throw new Error("fill failed");
      }),
    ).rejects.toThrow("fill failed");
    expect(await readFile(join(target, "v"), "utf8")).toBe("1");
    await publishDirectory(target, async (staging) => writeFile(join(staging, "v"), "3"));
    expect(await readFile(join(target, "v"), "utf8")).toBe("3");
    expect(await readdir(root)).toEqual(["site"]);
  });
});

describe("resolveInside", () => {
  beforeEach(async () => {
    await mkdir(join(root, "data", "inner"), { recursive: true });
    await writeFile(join(root, "data", "inner", "file.txt"), "x");
    await writeFile(join(root, "outside.txt"), "secret");
    await symlink(join(root, "data", "inner"), join(root, "data", "link-in"));
    await symlink(join(root, "outside.txt"), join(root, "data", "link-out"));
  });

  it("accepts paths inside, relative or absolute", async () => {
    const data = join(root, "data");
    expect(await resolveInside(data, "inner/file.txt", { links: "reject" })).toMatch(/inner[/\\]file\.txt$/);
    expect(await resolveInside(data, join(data, "inner", "file.txt"), { links: "reject" })).toMatch(/inner[/\\]file\.txt$/);
    expect(await resolveInside(data, "inner/new/deeper.txt", { links: "reject", allowMissing: true })).toMatch(/inner[/\\]new[/\\]deeper\.txt$/);
  });

  it("refuses escapes, links, missing paths and hard links as asked", async () => {
    const data = join(root, "data");
    expect(await code(resolveInside(data, "../outside.txt", { links: "within" }))).toBe("path_outside_root");
    expect(await code(resolveInside(data, "/etc/passwd", { links: "within" }))).toBe("path_outside_root");
    expect(await code(resolveInside(data, "inner/\0x", { links: "within" }))).toBe("path_outside_root");
    expect(await code(resolveInside(data, "link-in/file.txt", { links: "reject" }))).toBe("path_is_link");
    expect(await code(resolveInside(data, "link-in/file.txt", { links: "within" }))).toBe("ok");
    expect(await code(resolveInside(data, "link-out", { links: "within" }))).toBe("path_outside_root");
    expect(await code(resolveInside(data, "inner/missing.txt", { links: "reject" }))).toBe("path_missing");
    await link(join(data, "inner", "file.txt"), join(data, "inner", "hard.txt"));
    expect(await code(resolveInside(data, "inner/hard.txt", { links: "reject", rejectHardlinks: true }))).toBe("path_hardlinked");
  });

  it("isInside is lexical", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
  });
});

describe("readPrivateFile", () => {
  it("reads within the limit, refuses links, large and open files", async () => {
    const path = join(root, "secret");
    await writeFile(path, "token", { mode: 0o600 });
    expect((await readPrivateFile(path, { maxBytes: 5, mode0600: true })).toString()).toBe("token");
    expect(await code(readPrivateFile(path, { maxBytes: 4 }))).toBe("file_too_large");
    await symlink(path, join(root, "link"));
    expect(await code(readPrivateFile(join(root, "link"), { maxBytes: 10 }))).toBe("path_is_link");
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      expect(await code(readPrivateFile(path, { maxBytes: 10, mode0600: true }))).toBe("file_not_private");
    }
  });
});
