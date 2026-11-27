import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { workspaceOwnerKey, type DeviceInvocation, type ConversationIdentity, type OperationResult } from "@yesimbot/contracts";
import { AppError, contentHash, isInside, resolveInside, writeFileAtomic } from "@yesimbot/foundation";
import { z } from "zod/v4";

import type { DeviceDriver } from "../driver.js";

/** Names the conversation a hashed workspace directory belongs to, so a person can find it (IDs stay out of paths). */
export const CONVERSATION_LABEL = ".conversation.json";

const pathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "" ||
      value.split("/").every(
        (part) =>
          !!part &&
          part !== "." &&
          part !== ".." &&
          // Control characters are refused on purpose: Windows forbids them in names.
          // oxlint-disable-next-line no-control-regex
          !/[\\:\u0000-\u001f<>"|?*]/.test(part) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ),
  );
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const anyPath = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
const inputSchemas: Record<FileMethod, z.ZodTypeAny> = {
  read: z.object({ path: anyPath }).strict(),
  list: z.object({ path: anyPath }).strict(),
  mkdir: z.object({ path: anyPath }).strict(),
  write: z
    .object({
      path: anyPath,
      data: z.string().max(12 * 1024 * 1024),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .optional(),
    })
    .strict(),
};

type FileMethod = "read" | "write" | "list" | "mkdir";

/**
 * Files are namespaced from trusted invocation identity, never a model-supplied owner. A relative path is inside the
 * conversation's own directory. An absolute path must lie inside one of the project directories the device's owner
 * opened locally (`projectRoots`), following links only as far as they stay inside it.
 *
 * `write` may carry `expectedSha256`: the file is replaced only while its content still has that hash, and `null`
 * means it must not exist yet. An existing file keeps its permissions.
 */
export class LocalFilesDriver implements DeviceDriver {
  readonly capability = "workspace.files" as const;
  private readonly projectRoots: readonly string[];

  readonly methods: DeviceDriver["methods"] = Object.fromEntries(
    (["read", "write", "list", "mkdir"] as const).map((method) => [
      method,
      { contexts: ["direct", "group"] as const, execute: (invocation: DeviceInvocation, signal: AbortSignal) => this.execute(method, invocation, signal) },
    ]),
  );

  constructor(
    private readonly root: string,
    projectRoots: readonly string[] = [],
  ) {
    this.projectRoots = projectRoots.map((directory) => resolve(directory));
  }

  private async execute(method: FileMethod, invocation: DeviceInvocation, signal: AbortSignal): Promise<OperationResult> {
    const parsed = inputSchemas[method].safeParse(invocation.input);
    if (!parsed.success || signal.aborted) return { status: "rejected", code: "invalid_file_input" };
    const input = parsed.data as { path: string; data?: string; expectedSha256?: string | null };
    try {
      if (isAbsolute(input.path)) return await this.project(method, input, signal);
      return await this.conversation(method, input, invocation, signal);
    } catch (error) {
      // A missing file or parent is a known outcome: nothing was read or written.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof AppError && error.code === "path_missing"))
        return { status: "failed", code: method === "read" || method === "list" ? "file_not_found" : "parent_not_found" };
      throw error;
    }
  }

  private async conversation(
    method: FileMethod,
    input: { path: string; data?: string; expectedSha256?: string | null },
    invocation: DeviceInvocation,
    signal: AbortSignal,
  ): Promise<OperationResult> {
    if (isAbsolute(input.path) || !pathSchema.safeParse(input.path).success) return { status: "rejected", code: "invalid_file_input" };
    const root = conversationWorkspace(this.root, invocation.conversation);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) return { status: "rejected", code: "unsafe_workspace_root" };
    await prepareConversationWorkspace(this.root, invocation.conversation);
    const target = await insideConversation(root, input.path, method === "write" || method === "mkdir");
    if (method === "list") return listDirectory(target, false);
    if (method === "read") return readTarget(target, signal);
    if (!input.path) return { status: "rejected", code: "workspace_root_immutable" };
    if (method === "mkdir") {
      await mkdir(target, { mode: 0o700 });
      return { status: "succeeded", output: {} };
    }
    return writeTarget(target, input, 0o600, signal);
  }

  private async project(
    method: FileMethod,
    input: { path: string; data?: string; expectedSha256?: string | null },
    signal: AbortSignal,
  ): Promise<OperationResult> {
    const located = await this.locate(input.path, method === "write" || method === "mkdir");
    if (typeof located === "string") return { status: "rejected", code: located };
    if (method === "list") return listDirectory(located.target, true);
    if (method === "read") return readTarget(located.target, signal);
    if (located.target === located.root) return { status: "rejected", code: "workspace_root_immutable" };
    if (method === "mkdir") {
      await mkdir(located.target, { recursive: true });
      return { status: "succeeded", output: {} };
    }
    await mkdir(dirname(located.target), { recursive: true });
    return writeTarget(located.target, input, 0o644, signal);
  }

  /**
   * The real path of an absolute path inside a project root. Links are followed and must end inside the same root;
   * a path that does not exist yet is placed under the real path of its nearest existing ancestor.
   */
  private async locate(path: string, allowMissing: boolean): Promise<{ target: string; root: string } | string> {
    const target = resolve(path);
    const root = this.projectRoots.find((candidate) => isInside(candidate, target));
    if (!root) return "path_outside_roots";
    let realRoot: string;
    try {
      realRoot = await resolveInside(root, "", { links: "within" });
    } catch {
      return "project_root_unavailable";
    }
    try {
      return { target: await resolveInside(root, target, { links: "within", allowMissing }), root: realRoot };
    } catch (error) {
      if (error instanceof AppError && error.code === "path_outside_root") return "path_outside_roots";
      throw error;
    }
  }
}

export function conversationWorkspace(root: string, conversation: ConversationIdentity): string {
  return join(resolve(root), contentHash(workspaceOwnerKey({ kind: "conversation", conversation })));
}

/**
 * Creates the conversation's directory and, once, its label. The label is written only when absent and never
 * through a symlink; a label the bot later edits or removes is left as it is.
 */
export async function prepareConversationWorkspace(root: string, conversation: ConversationIdentity): Promise<string> {
  const directory = conversationWorkspace(root, conversation);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A planted symlink in place of the directory gets no label; the callers' own checks reject it.
  if ((await lstat(directory)).isSymbolicLink()) return directory;
  const label = {
    platform: conversation.platform,
    kind: conversation.kind,
    conversationId: conversation.conversationId,
    ...(conversation.parentId ? { parentId: conversation.parentId } : {}),
    botId: conversation.botId,
  };
  try {
    await writeFile(join(directory, CONVERSATION_LABEL), JSON.stringify(label, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return directory;
}

/**
 * The real path of a conversation-relative path. No component may be a link and the file may have no other name;
 * with `allowMissingLeaf` the path may not exist yet.
 */
async function insideConversation(root: string, path: string, allowMissingLeaf: boolean): Promise<string> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error("unsafe_workspace_root");
  try {
    return await resolveInside(root, path ? join(...path.split("/")) : "", { links: "reject", allowMissing: allowMissingLeaf, rejectHardlinks: true });
  } catch (error) {
    if (error instanceof AppError && (error.code === "path_is_link" || error.code === "path_hardlinked"))
      throw new Error("workspace_link_denied", { cause: error });
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new Error("workspace_parent_not_directory", { cause: error });
    throw error;
  }
}

async function listDirectory(target: string, showLinks: boolean): Promise<OperationResult> {
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.length > 2000) return { status: "failed", code: "directory_too_large" };
  return {
    status: "succeeded",
    output: entries
      .filter((item) => showLinks || !item.isSymbolicLink())
      .map((item) => ({ name: item.name, directory: item.isDirectory(), ...(item.isSymbolicLink() ? { link: true } : {}) })),
  };
}

async function readTarget(target: string, signal: AbortSignal): Promise<OperationResult> {
  const metadata = await stat(target);
  if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return { status: "failed", code: "file_unavailable" };
  const bytes = await readFile(target, { signal });
  if (bytes.length > MAX_FILE_BYTES) return { status: "failed", code: "file_too_large" };
  return { status: "succeeded", output: { data: bytes.toString("base64"), bytes: bytes.length } };
}

/** Atomic replace through a temporary sibling, after the optional content check; an existing file keeps its mode. */
async function writeTarget(
  target: string,
  input: { data?: string; expectedSha256?: string | null },
  newMode: number,
  signal: AbortSignal,
): Promise<OperationResult> {
  if (typeof input.data !== "string") return { status: "rejected", code: "invalid_file_data" };
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.toString("base64") !== input.data) return { status: "rejected", code: "invalid_file_data" };
  if (bytes.length > MAX_FILE_BYTES) return { status: "rejected", code: "file_too_large" };
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isFile()) return { status: "rejected", code: "not_a_file" };
  // Replacing one name of a hard-linked file would split it from its other names.
  if (existing && existing.nlink > 1) return { status: "rejected", code: "file_hardlinked" };
  if (input.expectedSha256 === null && existing) return { status: "rejected", code: "file_exists" };
  if (typeof input.expectedSha256 === "string" && !existing) return { status: "rejected", code: "file_changed" };
  const expect = input.expectedSha256 === null ? "absent" : input.expectedSha256 === undefined ? undefined : { sha256: input.expectedSha256 };
  try {
    await writeFileAtomic(target, bytes, { mode: existing ? existing.mode & 0o7777 : newMode, signal, ...(expect ? { expect } : {}) });
  } catch (error) {
    if (error instanceof AppError && error.code === "file_changed") return { status: "rejected", code: expect === "absent" ? "file_exists" : "file_changed" };
    throw error;
  }
  return { status: "succeeded", output: { bytes: bytes.length } };
}
