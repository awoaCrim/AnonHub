import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileToolJournal, type ToolJournalCall } from "../src/tool-journal.js";

const io = vi.hoisted(() => ({
  root: "",
  opened: [] as string[],
  synced: [] as { path: string; directory: boolean }[],
  failDirectoryOpen: false,
  failDirectorySync: false,
  failFileSync: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const path = String(args[0]);
      io.opened.push(path);
      if (path === io.root && io.failDirectoryOpen) throw Object.assign(new Error("directory open unsupported"), { code: "EPERM" });
      const file = await original.open(...args);
      const directory = (await file.stat()).isDirectory();
      return new Proxy(file, {
        get(target, property) {
          if (property === "sync")
            return async () => {
              io.synced.push({ path, directory });
              if (directory && io.failDirectorySync) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
              if (!directory && io.failFileSync) throw Object.assign(new Error("file sync failed"), { code: "EIO" });
              // Policy tests also run on native Windows, where the simulated POSIX directory
              // handle cannot actually be flushed. Record the attempted sync without using it.
              if (directory && platform.value === "win32") return;
              return target.sync();
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const directories: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  Object.assign(io, { root: "", opened: [], synced: [], failDirectoryOpen: false, failDirectorySync: false, failFileSync: false });
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const call: ToolJournalCall = { turnId: "turn", toolCallId: "call", toolName: "effect", input: {} };
const key = createHash("sha256")
  .update(JSON.stringify([call.turnId, call.toolCallId]))
  .digest("hex");
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-journal-platform-"));
  directories.push(root);
  io.root = root;
  return root;
}

describe("journal platform durability policy (simulated platform, real temporary files)", () => {
  it("executes and recovers on Windows without opening directories while syncing both record files", async () => {
    const root = await directory(),
      execute = vi.fn(async () => "receipt");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    io.failDirectoryOpen = true;
    const journal = createFileToolJournal(root);
    expect(journal.durability).toBe("file-sync-only");
    expect(await journal.execute(call, execute)).toBe("receipt");
    expect(await createFileToolJournal(root).execute(call, execute)).toBe("receipt");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(io.opened).not.toContain(root);
    expect(io.synced).toEqual([
      { path: join(root, `${key}.intent.json`), directory: false },
      { path: join(root, `${key}.result.json`), directory: false },
    ]);
    for (const type of ["intent", "result"]) {
      expect(JSON.parse(await readFile(join(root, `${key}.${type}.json`), "utf8")).durability).toBe("file-sync-only");
    }
  });

  it("requires file fsync before any effect on Windows", async () => {
    const root = await directory(),
      execute = vi.fn(async () => "receipt");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    io.failFileSync = true;
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "journal_unavailable", executionStatus: "not_started" });
    expect(execute).not.toHaveBeenCalled();
    expect(io.synced).toEqual([{ path: join(root, `${key}.intent.json`), directory: false }]);
  });

  it.each(["linux", "darwin"])("syncs record files and their directory on %s", async (simulated) => {
    const root = await directory();
    Object.defineProperty(process, "platform", { ...platform, value: simulated });
    const journal = createFileToolJournal(root);
    expect(journal.durability).toBe("file-and-directory-sync");
    expect(await journal.execute(call, async () => "receipt")).toBe("receipt");
    expect(io.synced).toEqual([
      { path: join(root, `${key}.intent.json`), directory: false },
      { path: root, directory: true },
      { path: join(root, `${key}.result.json`), directory: false },
      { path: root, directory: true },
    ]);
    expect(JSON.parse(await readFile(join(root, `${key}.intent.json`), "utf8")).durability).toBe("file-and-directory-sync");
  });

  it.each(["open", "sync"])("does not suppress a Linux directory %s failure", async (failure) => {
    const root = await directory(),
      execute = vi.fn(async () => "receipt");
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    io.failDirectoryOpen = failure === "open";
    io.failDirectorySync = failure === "sync";
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "journal_unavailable", executionStatus: "not_started" });
    expect(execute).not.toHaveBeenCalled();
    expect(io.opened).toContain(root);
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(execute).not.toHaveBeenCalled();
  });
});
