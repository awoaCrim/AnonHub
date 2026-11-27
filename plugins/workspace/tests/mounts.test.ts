import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertValidMountConfig, normalizeMounts, normalizeVirtualMountPath } from "../src/mounts";

let temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A mount refusal is one registered code; the specific reason is in `detail`. */
function mountProblem(reason: RegExp | string) {
  return { code: "workspace_mount_invalid", detail: expect.stringMatching(reason) };
}

describe("workspace mount validation", () => {
  it("normalizes simple absolute virtual paths", () => {
    expect(normalizeVirtualMountPath("/knowledge/")).toBe("/knowledge");
  });

  it("rejects relative virtual paths", () => {
    expect(thrownBy(() => normalizeVirtualMountPath("knowledge"))).toMatchObject(mountProblem(/absolute virtual path/));
  });

  it("rejects dot and dot-dot segments", () => {
    expect(thrownBy(() => normalizeVirtualMountPath("/data/../secret"))).toMatchObject(mountProblem(/must not contain/));
    expect(thrownBy(() => normalizeVirtualMountPath("/data/./files"))).toMatchObject(mountProblem(/must not contain/));
  });

  it("rejects duplicate mount points across maps", () => {
    expect(thrownBy(() => assertValidMountConfig({ persistPaths: { "/data": "/host/a" }, readOnlyPaths: { "/data": "/host/b" } }))).toMatchObject(
      mountProblem(/Duplicate mount point/),
    );
  });

  it("rejects nested mount points", () => {
    expect(thrownBy(() => assertValidMountConfig({ persistPaths: { "/data": "/host/a" }, overlayPaths: { "/data/repo": "/host/b" } }))).toMatchObject(
      mountProblem(/Nested mount point/),
    );
  });

  it("rejects explicit mounts nested under the default workspace", () => {
    expect(thrownBy(() => assertValidMountConfig({ persistPaths: { "/home/workspace/repo": "/host/repo" } }))).toMatchObject(
      mountProblem(/reserved mount point/),
    );
  });

  it("rejects duplicate mount points created by normalization in the same map", () => {
    expect(thrownBy(() => assertValidMountConfig({ persistPaths: { "/data": "/host/a", "/data/": "/host/b" } }))).toMatchObject(
      mountProblem(/Duplicate mount point/),
    );
  });

  it("rejects explicit mounts over the default workspace", () => {
    expect(thrownBy(() => assertValidMountConfig({ persistPaths: { "/home/workspace": "/host/workspace" } }))).toMatchObject(
      mountProblem(/reserved mount point/),
    );
  });

  it("resolves relative sources against the base directory and creates rw directories", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "yesimbot-mounts-base-"));
    temporaryRoots.push(baseDir);

    const [mount] = await normalizeMounts([{ source: "created/data", target: "/data/", mode: "rw" }], baseDir);

    expect(mount).toEqual({ source: await realpath(join(baseDir, "created", "data")), target: "/data", mode: "rw" });
    await expect(stat(join(baseDir, "created", "data"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("requires existing directories for ro and overlay sources and canonicalizes them", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "yesimbot-mounts-base-"));
    temporaryRoots.push(baseDir);
    await mkdir(join(baseDir, "docs"));

    const mounts = await normalizeMounts(
      [
        { source: "docs", target: "/docs", mode: "ro" },
        { source: "docs", target: "/overlay", mode: "overlay" },
      ],
      baseDir,
    );

    expect(mounts).toEqual([
      { source: await realpath(join(baseDir, "docs")), target: "/docs", mode: "ro" },
      { source: await realpath(join(baseDir, "docs")), target: "/overlay", mode: "overlay" },
    ]);
    await expect(normalizeMounts([{ source: "missing", target: "/missing", mode: "ro" }], baseDir)).rejects.toMatchObject(mountProblem(/does not exist/));
  });

  it.each([
    { name: "root", mounts: [{ source: ".", target: "/", mode: "rw" }], message: /Mount point \/ is not allowed/ },
    { name: "reserved workspace", mounts: [{ source: ".", target: "/home/workspace/cache", mode: "rw" }], message: /reserved mount point/ },
    {
      name: "duplicate targets",
      mounts: [
        { source: ".", target: "/data", mode: "rw" },
        { source: ".", target: "/data/", mode: "ro" },
      ],
      message: /Duplicate mount point/,
    },
    {
      name: "parent child targets",
      mounts: [
        { source: ".", target: "/data", mode: "rw" },
        { source: ".", target: "/data/nested", mode: "ro" },
      ],
      message: /Nested mount point/,
    },
  ])("rejects $name before resolving sources", async ({ mounts, message }) => {
    const baseDir = await mkdtemp(join(tmpdir(), "yesimbot-mounts-conflict-"));
    temporaryRoots.push(baseDir);

    await expect(normalizeMounts(mounts, baseDir)).rejects.toMatchObject(mountProblem(message));
  });
});
