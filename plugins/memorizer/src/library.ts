import { RESOURCE_MAX_BYTES } from "koishi-plugin-yesimbot/kernel";

import { refuse } from "./errors.js";
import type { EvidenceStore } from "./store/evidence.js";
import type { MemoryStore } from "./store/memory.js";
import type { ManagedMemory, MemoryDeleteInput, MemoryEditInput, MemoryListOptions } from "./types.js";

/** Server-side instance owner API. Mutations recheck the caller's live grant inside the store queue. */
export class MemoryLibrary {
  private readonly store: MemoryStore;
  private readonly evidence: EvidenceStore;

  public constructor(options: { store: MemoryStore; evidence: EvidenceStore }) {
    this.store = options.store;
    this.evidence = options.evidence;
  }
  public async list(options: MemoryListOptions = {}) {
    const result = await this.store.listManaged(options);
    return { ...result, memories: await Promise.all(result.memories.map((memory) => this.withAttachments(memory))) };
  }
  public async read(id: string) {
    return this.withAttachments(await this.store.readManaged(id));
  }
  public async update(input: MemoryEditInput, authorize: () => void) {
    return this.withAttachments(await this.store.editManaged(input, authorize));
  }
  /** One kept picture or file of a memory in this instance; `memory_not_found` otherwise. */
  public async attachment(id: string, index: number) {
    await this.store.readManaged(id);
    const file = Number.isSafeInteger(index) && index > 0 ? await this.evidence.openAttachment(id, index, RESOURCE_MAX_BYTES) : undefined;
    if (!file) throw refuse("memory_not_found");
    return file;
  }
  public delete(input: MemoryDeleteInput, authorize: () => void) {
    return this.store.deleteManaged(input, (id) => this.evidence.remove(id), authorize);
  }

  private async withAttachments(memory: ManagedMemory): Promise<ManagedMemory> {
    const kept = await this.evidence.attachments(memory.id);
    if (!kept.length) return memory;
    return { ...memory, attachments: kept.map(({ index, name, mediaType, byteLength }) => ({ index, ...(name ? { name } : {}), mediaType, byteLength })) };
  }
}
