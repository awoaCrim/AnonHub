import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AppError, contentHash, readJson, serialize, writeFileAtomic } from "@yesimbot/foundation";
import type { MessageRecord } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { refuse } from "../errors.js";
import type { MemoryAttachment, MemoryEvidence } from "../types.js";

/** Most pictures and files one memory keeps. */
export const MAX_ATTACHMENTS = 4;
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

const EVIDENCE_SCHEMA = z.object({ memoryId: z.string(), messages: z.array(z.custom<MessageRecord>((value) => typeof value === "object" && value !== null)) });
const ATTACHMENTS_SCHEMA = z.array(
  z.object({
    index: z.number(),
    name: z.string().optional(),
    mediaType: z.string(),
    byteLength: z.number(),
    sha256: z.string(),
    messageId: z.string(),
  }),
);

export interface NewAttachment {
  readonly bytes: Uint8Array;
  readonly name?: string;
  readonly mediaType: string;
  readonly messageId: string;
}

/**
 * A memory's source messages, and the pictures and files it keeps (`attachments/<memoryId>/`). Both share one life:
 * deleting, sweeping or merging a memory does the same to its attachments.
 */
export class EvidenceStore {
  public constructor(private readonly root: string) {}

  public read(memoryId: string): Promise<MessageRecord[]> {
    return serialize(this.root, async () => (await this.readEvidence(memoryId)).messages);
  }

  public append(memoryId: string, messages: readonly MessageRecord[]): Promise<void> {
    return serialize(this.root, async () => {
      const existing = await this.readEvidence(memoryId);
      const byId = new Map(existing.messages.map((message) => [messageKey(message), message]));
      for (const message of messages) byId.set(messageKey(message), message);
      await this.writeEvidence({ memoryId, messages: [...byId.values()] });
    });
  }

  public merge(canonicalId: string, mergedIds: readonly string[]): Promise<void> {
    return serialize(this.root, async () => {
      const canonical = await this.readEvidence(canonicalId);
      const byId = new Map(canonical.messages.map((message) => [messageKey(message), message]));
      for (const id of mergedIds) {
        for (const message of (await this.readEvidence(id)).messages) byId.set(messageKey(message), message);
      }
      await this.writeEvidence({ memoryId: canonicalId, messages: [...byId.values()] });
      for (const id of mergedIds) {
        const moved = await Promise.all(
          (await this.readAttachments(id)).map(async (item) => ({ ...item, bytes: await readFile(this.attachmentPath(id, item.index)) })),
        );
        if (moved.length) await this.writeAttachments(canonicalId, moved, false, Number.POSITIVE_INFINITY);
        await rm(this.pathFor(id), { force: true });
        await rm(this.attachmentDir(id), { recursive: true, force: true });
      }
    });
  }

  public remove(memoryId: string): Promise<void> {
    return serialize(this.root, async () => {
      await rm(this.pathFor(memoryId), { force: true });
      if (SAFE_ID.test(memoryId)) await rm(this.attachmentDir(memoryId), { recursive: true, force: true });
    });
  }

  public attachments(memoryId: string): Promise<MemoryAttachment[]> {
    return serialize(this.root, () => this.readAttachments(memoryId));
  }

  /**
   * Adds pictures or files (the same bytes are kept once), or with `replace` keeps only these. Indexes are never
   * reused, so an old `memory://` URI cannot come to mean another picture.
   */
  public attach(memoryId: string, files: readonly NewAttachment[], replace = false): Promise<MemoryAttachment[]> {
    return serialize(this.root, () => this.writeAttachments(memoryId, files, replace, MAX_ATTACHMENTS));
  }

  /** One attachment's bytes, or undefined when it does not exist or exceeds `maxBytes`. */
  public openAttachment(memoryId: string, index: number, maxBytes: number): Promise<{ bytes: Uint8Array; mediaType: string; filename?: string } | undefined> {
    return serialize(this.root, async () => {
      const item = (await this.readAttachments(memoryId)).find((candidate) => candidate.index === index);
      if (!item) return undefined;
      const path = this.attachmentPath(memoryId, index);
      if ((await stat(path)).size > maxBytes) return undefined;
      return { bytes: new Uint8Array(await readFile(path)), mediaType: item.mediaType, ...(item.name ? { filename: item.name } : {}) };
    });
  }

  public async count(memoryId: string): Promise<number> {
    return (await this.read(memoryId)).length;
  }

  private async readEvidence(memoryId: string): Promise<MemoryEvidence> {
    const evidence = await readJson(this.pathFor(memoryId), EVIDENCE_SCHEMA);
    if (!evidence) return { memoryId, messages: [] };
    if (evidence.memoryId !== memoryId)
      throw new AppError("data_invalid", { effect: "none", detail: `evidence file of ${memoryId} names ${evidence.memoryId}` });
    return evidence;
  }

  private async writeEvidence(evidence: MemoryEvidence): Promise<void> {
    const path = this.pathFor(evidence.memoryId);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(evidence)}\n`);
  }

  private pathFor(memoryId: string): string {
    return join(this.root, "evidence", `${memoryId}.json`);
  }

  private async writeAttachments(memoryId: string, files: readonly NewAttachment[], replace: boolean, limit: number): Promise<MemoryAttachment[]> {
    const existing = await this.readAttachments(memoryId);
    const kept = replace ? [] : [...existing];
    const added: { item: MemoryAttachment; bytes: Uint8Array }[] = [];
    let next = existing.reduce((max, item) => Math.max(max, item.index), 0) + 1;
    for (const file of files) {
      const sha256 = contentHash(file.bytes);
      if ([...kept, ...added.map((entry) => entry.item)].some((item) => item.sha256 === sha256)) continue;
      const item = {
        index: next++,
        ...(file.name ? { name: file.name } : {}),
        mediaType: file.mediaType,
        byteLength: file.bytes.byteLength,
        sha256,
        messageId: file.messageId,
      };
      added.push({ item, bytes: file.bytes });
    }
    const result = [...kept, ...added.map((entry) => entry.item)];
    if (result.length > limit) throw refuse("memory_attachments_too_many", `limit ${limit}`);
    await mkdir(this.attachmentDir(memoryId), { recursive: true });
    for (const entry of added) await writeFileAtomic(this.attachmentPath(memoryId, entry.item.index), entry.bytes);
    await writeFileAtomic(join(this.attachmentDir(memoryId), "index.json"), `${JSON.stringify(result)}\n`);
    for (const item of existing)
      if (!result.some((current) => current.index === item.index)) await rm(this.attachmentPath(memoryId, item.index), { force: true });
    return result;
  }

  private async readAttachments(memoryId: string): Promise<MemoryAttachment[]> {
    return (await readJson(join(this.attachmentDir(memoryId), "index.json"), ATTACHMENTS_SCHEMA)) ?? [];
  }

  private attachmentDir(memoryId: string): string {
    if (!SAFE_ID.test(memoryId)) throw refuse("memory_id_invalid");
    return join(this.root, "attachments", memoryId);
  }

  private attachmentPath(memoryId: string, index: number): string {
    if (!Number.isSafeInteger(index) || index < 1) throw refuse("memory_attachment_index_invalid");
    return join(this.attachmentDir(memoryId), String(index));
  }
}

function messageKey(message: MessageRecord): string {
  return `${message.platform}\u0000${message.selfId}\u0000${message.channel.id}\u0000${message.messageId}`;
}
