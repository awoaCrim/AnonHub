import { mkdir, stat } from "node:fs/promises";
import { posix, resolve } from "node:path";

import { AppError } from "@yesimbot/foundation";

import { WORKSPACE_ERRORS } from "./errors.js";
import { realPath } from "./real-path.js";
import type { MountSpec } from "./types.js";

export const DEFAULT_WORKSPACE_MOUNT = "/home/workspace";

export interface NormalizedMountSpec extends MountSpec {
  readonly source: string;
  readonly target: string;
}

export interface WorkspaceMountConfig {
  persistPaths?: Record<string, string>;
  readOnlyPaths?: Record<string, string>;
  overlayPaths?: Record<string, string>;
}

export interface NormalizedWorkspaceMountConfig {
  persistPaths: Record<string, string>;
  readOnlyPaths: Record<string, string>;
  overlayPaths: Record<string, string>;
}

/**
 * Resolve and validate the public Sandbox mount list before constructing a
 * virtual filesystem. Target conflicts are checked before touching any source
 * path so a bad declaration cannot partially create a writable directory.
 */
export async function normalizeMounts(mounts: readonly MountSpec[] | undefined, baseDir: string): Promise<NormalizedMountSpec[]> {
  const candidates = (mounts ?? []).map((mount, index) => {
    if (!mount || typeof mount !== "object") {
      throw mountError(`Mount ${index} must be an object`);
    }
    if (typeof mount.source !== "string" || mount.source.trim().length === 0) {
      throw mountError(`Mount ${index} source must not be empty`);
    }
    if (mount.mode !== "rw" && mount.mode !== "ro" && mount.mode !== "overlay") {
      throw mountError(`Mount ${index} mode must be rw, ro, or overlay`);
    }

    return { source: mount.source, target: normalizeVirtualMountPath(mount.target), mode: mount.mode } satisfies MountSpec;
  });

  assertMountTargetConflicts(candidates);

  const normalized: NormalizedMountSpec[] = [];
  for (const mount of candidates) {
    const source = resolve(baseDir, mount.source);
    if (mount.mode === "rw") {
      await mkdir(source, { recursive: true });
    }

    let metadata;
    try {
      metadata = await stat(source);
    } catch (error) {
      throw mountError(`Mount source does not exist for ${mount.target}: ${source}`, error);
    }
    if (!metadata.isDirectory()) {
      throw mountError(`Mount source is not a directory for ${mount.target}: ${source}`);
    }

    normalized.push({ source: await realPath(source), target: mount.target, mode: mount.mode });
  }

  return normalized;
}

export function normalizeVirtualMountPath(path: string): string {
  if (!path || path.trim().length === 0) {
    throw mountError("Mount point must not be empty");
  }
  if (!path.startsWith("/")) {
    throw mountError(`Mount point must be an absolute virtual path: ${path}`);
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw mountError(`Mount point must not contain . or .. segments: ${path}`);
  }

  const normalized = posix.normalize(path).replace(/\/+$/, "") || "/";
  if (normalized === "/") {
    throw mountError("Mount point / is not allowed");
  }

  return normalized;
}

export function assertValidMountConfig(config: WorkspaceMountConfig): NormalizedWorkspaceMountConfig {
  const normalized: NormalizedWorkspaceMountConfig = {
    persistPaths: normalizeMap(config.persistPaths),
    readOnlyPaths: normalizeMap(config.readOnlyPaths),
    overlayPaths: normalizeMap(config.overlayPaths),
  };

  const seen = new Map<string, string>();
  for (const [kind, paths] of Object.entries(normalized)) {
    for (const mountPoint of Object.keys(paths)) {
      const previous = seen.get(mountPoint);
      if (previous) {
        throw mountError(`Duplicate mount point ${mountPoint} in ${previous} and ${kind}`);
      }
      seen.set(mountPoint, kind);
    }
  }

  const mountPoints = [...seen.keys()].sort();
  for (let i = 0; i < mountPoints.length; i += 1) {
    for (let j = i + 1; j < mountPoints.length; j += 1) {
      const parent = mountPoints[i];
      const child = mountPoints[j];
      if (child.startsWith(`${parent}/`)) {
        throw mountError(`Nested mount point ${child} is not allowed under ${parent}`);
      }
    }
  }

  return normalized;
}

function normalizeMap(paths: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [mountPoint, hostPath] of Object.entries(paths ?? {})) {
    const normalizedMount = normalizeVirtualMountPath(mountPoint);
    if (normalizedMount === DEFAULT_WORKSPACE_MOUNT || normalizedMount.startsWith(`${DEFAULT_WORKSPACE_MOUNT}/`)) {
      throw mountError(`${normalizedMount} is a reserved mount point`);
    }
    if (Object.hasOwn(normalized, normalizedMount)) {
      throw mountError(`Duplicate mount point ${normalizedMount} in the same mount map`);
    }
    normalized[normalizedMount] = hostPath;
  }

  return normalized;
}

function assertMountTargetConflicts(mounts: readonly MountSpec[]): void {
  const seen = new Set<string>();
  for (const mount of mounts) {
    if (mount.target === DEFAULT_WORKSPACE_MOUNT || mount.target.startsWith(`${DEFAULT_WORKSPACE_MOUNT}/`)) {
      throw mountError(`${mount.target} is a reserved mount point`);
    }
    if (seen.has(mount.target)) {
      throw mountError(`Duplicate mount point ${mount.target}`);
    }
    seen.add(mount.target);
  }

  const targets = [...seen].sort();
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      const parent = targets[i]!;
      const child = targets[j]!;
      if (child.startsWith(`${parent}/`)) {
        throw mountError(`Nested mount point ${child} is not allowed under ${parent}`);
      }
    }
  }
}

function mountError(detail: string, cause?: unknown): AppError {
  return new AppError(WORKSPACE_ERRORS.workspace_mount_invalid, { effect: "none", detail, ...(cause === undefined ? {} : { cause }) });
}
