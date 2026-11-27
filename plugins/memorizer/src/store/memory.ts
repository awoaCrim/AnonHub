import { uuid } from "@yesimbot/contracts";
import { newId, type Clock } from "@yesimbot/foundation";
import type { ChannelContext, MessageRecord } from "koishi-plugin-yesimbot/kernel";

import { refuse } from "../errors.js";
import { cosineSimilarity, memoryEmbeddingText, usableEmbedding, type EmbeddingIndexer } from "../semantic.js";
import {
  retentionScore,
  type ManagedMemory,
  type Memory,
  type MemoryCreateInput,
  type MemoryDeleteInput,
  type MemoryEditInput,
  type MemoryListOptions,
  type MemoryListResult,
  type MemoryQuery,
  type MemoryRow,
  type MemoryType,
  type MemoryUpdateInput,
} from "../types.js";
import { containsCredential, messageInConversation, normalizedContent } from "../visibility.js";
import type { MemoryTable } from "./table.js";

/** Ranking and pruning half-life, in days. */
const HALF_LIFE_DAYS = 90;
/** Days a forgotten memory is kept before it and its evidence are removed. */
const FORGOTTEN_GRACE_DAYS = 30;
/** Active memories kept per ownership scope; lower-ranked ones are soft-forgotten. */
const MAX_ACTIVE_PER_SCOPE = 1_000;
/** Minimum cosine similarity for a vector-only match to be recalled. */
const SEMANTIC_MIN_SIMILARITY = 0.35;
/** Ranking multiplier strength: score = retention x confidence x (1 + weight x similarity). */
const SEMANTIC_BOOST_WEIGHT = 1;
/** Cosine similarity at which two memories in the same owned scope are offered to consolidation as likely duplicates. */
const DUPLICATE_SIMILARITY = 0.85;
/** Members one duplicate group may hold (the new memory plus its closest neighbours). */
const DUPLICATE_GROUP_SIZE = 5;
/** Active memories re-vectorised per maintenance sweep. */
const REINDEX_BATCH = 64;

export interface MemoryStoreOptions {
  readonly clock: Clock;
  readonly tenantId: string | (() => Promise<string>);
  /** Trusted ingress capability, never a model-owned argument or a display-name comparison. */
  readonly isOwner?: (context: ChannelContext) => boolean | Promise<boolean>;
  readonly indexer?: EmbeddingIndexer;
}

export interface PrunePlan {
  readonly forgetIds: string[];
  readonly removeIds: string[];
}

export class MemoryStore {
  private readonly table: MemoryTable;
  private readonly indexer: EmbeddingIndexer | undefined;
  private readonly options: MemoryStoreOptions;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(table: MemoryTable, options: MemoryStoreOptions) {
    this.table = table;
    this.options = options;
    this.indexer = options.indexer;
  }

  public create(input: MemoryCreateInput, id = newId()): Promise<Memory> {
    return this.mutate(async () => {
      validateMemory(input);
      if (input.scope !== "shared" && !input.context?.selfId) throw refuse("memory_context_required");
      if (input.scope === "user" && input.platform !== input.context?.platform) throw refuse("memory_platform_mismatch");
      if (input.scope === "user" && input.context?.type === "direct" && input.userId !== input.context.userId) throw refuse("memory_user_mismatch");
      if (!input.platform?.trim() && input.scope === "shared") throw refuse("memory_platform_required");
      const tenantId = await this.tenantId();
      const now = this.options.clock.now();
      const visibility = input.scope === "shared" ? "shared" : input.context && (await this.ownerContext(input.context)) ? "owner" : "conversation";
      // First build ownership without a model call. Idempotent retries reuse a fact's canonical ID.
      const owned = { tenantId, visibility } as const;
      const candidate = toRow({ id, ...input, ...owned, status: "active", createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0 });
      const rows = await this.table.all();
      const duplicate = rows
        .map(fromRow)
        .find(
          (memory) =>
            memory.status === "active" &&
            memory.type === input.type &&
            mergeOwnershipKey(memory) === mergeOwnershipKey(fromRow(candidate)) &&
            normalizedContent(memory.content) === normalizedContent(input.content),
        );
      if (duplicate) return duplicate;
      const vector = await this.embedDocument(input.content, input.tags ?? []);
      const row = toRow({
        id,
        ...input,
        ...owned,
        ...vector,
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      });
      await this.table.create(row);
      return fromRow(row);
    });
  }

  public get(id: string): Promise<Memory | undefined> {
    return this.mutate(async () => {
      const row = await this.table.byId(id);
      return row && fromRow(row);
    });
  }

  /** Trusted instance administration only: callers must authenticate the owner first. */
  public listManaged(options: MemoryListOptions = {}): Promise<MemoryListResult> {
    return this.mutate(async () => {
      const limit = options.limit ?? 200;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        (options.cursor !== undefined && (typeof options.cursor !== "string" || options.cursor.length > 512))
      )
        throw refuse("invalid_memory_page");
      const tenantId = await this.tenantId();
      const rows = await this.table.all();
      const eligible = rows
        .map(fromRow)
        .filter((memory) => memory.status === "active" && memory.tenantId === tenantId)
        .sort((left, right) => left.id.localeCompare(right.id));
      const page = eligible.filter((memory) => !options.cursor || memory.id.localeCompare(options.cursor) > 0).slice(0, limit + 1);
      return { memories: page.slice(0, limit).map(toManaged), ...(page.length > limit ? { nextCursor: page[limit - 1]!.id } : {}) };
    });
  }

  public readManaged(id: string): Promise<ManagedMemory> {
    return this.mutate(async () => toManaged(await this.requireManagedMemory(id)));
  }

  /** Compare and commit under the same mutation queue as extraction, merge and deletion. */
  public editManaged(input: MemoryEditInput, authorize?: () => void): Promise<ManagedMemory> {
    return this.mutate(async () => {
      authorize?.();
      const memory = await this.requireManaged(input.id, input.revision);
      if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 16_000 || containsCredential(input.content))
        throw refuse("invalid_memory_content");
      if (input.visibility !== undefined && !["owner", "conversation", "shared"].includes(input.visibility)) throw refuse("invalid_memory_visibility");
      if (input.visibility === "conversation" && (!memory.selfId || !memory.channelId || !memory.channelType || !memory.platform))
        throw refuse("invalid_memory_visibility");
      const next = {
        ...memory,
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        content: input.content.trim(),
        revision: (memory.revision ?? 0) + 1,
        updatedAt: this.options.clock.now(),
      };
      const vector = await this.reindexIfNeeded(memory, next);
      const row = toRow({ ...next, ...vector });
      authorize?.();
      await this.table.set(memory.id, toUpdate(row));
      return toManaged(fromRow(row));
    });
  }

  public deleteManaged(input: MemoryDeleteInput, removeEvidence: (id: string) => Promise<void>, authorize?: () => void): Promise<{ deleted: true }> {
    return this.mutate(async () => {
      authorize?.();
      const memory = await this.requireManaged(input.id, input.revision);
      authorize?.();
      await removeEvidence(memory.id);
      await this.table.remove(memory.id);
      return { deleted: true };
    });
  }

  private async requireManaged(id: string, revision: number): Promise<Memory> {
    const memory = await this.requireManagedMemory(id);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== (memory.revision ?? 0)) throw refuse("memory_revision_conflict");
    return memory;
  }

  private async requireManagedMemory(id: string): Promise<Memory> {
    const row = await this.table.byId(id);
    const tenantId = await this.tenantId();
    if (!row || row.status !== "active" || row.tenantId !== tenantId) throw refuse("memory_not_found");
    return fromRow(row);
  }

  public update(id: string, input: MemoryUpdateInput, expectedRevision?: number): Promise<Memory> {
    return this.mutate(async () => {
      const existing = await this.require(id);
      if (expectedRevision !== undefined && expectedRevision !== (existing.revision ?? 0)) throw refuse("memory_revision_conflict");
      assertOwnershipPatch(existing, input);
      const merged = { ...existing, ...input, id };
      const vector = await this.reindexIfNeeded(existing, merged);
      const row = toRow({
        ...merged,
        ...vector,
        id,
        revision: (existing.revision ?? 0) + 1,
        status: existing.status,
        createdAt: existing.createdAt,
        updatedAt: this.options.clock.now(),
        lastAccessedAt: existing.lastAccessedAt,
        accessCount: existing.accessCount,
      });
      await this.table.set(id, toUpdate(row));
      return fromRow(row);
    });
  }

  public merge(
    canonicalId: string,
    mergedId: string,
    input: MemoryUpdateInput,
    beforeCommit?: () => Promise<void>,
    expectedRevisions?: readonly [number, number],
  ): Promise<Memory> {
    return this.mutate(async () => {
      const source = await this.require(mergedId);
      const canonical = await this.require(canonicalId);
      if (expectedRevisions && (expectedRevisions[0] !== (canonical.revision ?? 0) || expectedRevisions[1] !== (source.revision ?? 0)))
        throw refuse("memory_revision_conflict");
      if (canonicalId === mergedId || !canonical.platform?.trim() || !source.platform?.trim() || mergeOwnershipKey(canonical) !== mergeOwnershipKey(source))
        throw refuse("memory_merge_scope_mismatch");
      assertOwnershipPatch(canonical, input);
      const merged = { ...canonical, ...input, id: canonicalId };
      const vector = await this.reindexIfNeeded(canonical, merged);
      const row = toRow({
        ...merged,
        ...vector,
        id: canonicalId,
        revision: (canonical.revision ?? 0) + 1,
        status: canonical.status,
        createdAt: canonical.createdAt,
        updatedAt: this.options.clock.now(),
        lastAccessedAt: canonical.lastAccessedAt,
        accessCount: canonical.accessCount,
      });
      await beforeCommit?.();
      await this.table.set(canonicalId, toUpdate(row));
      await this.table.remove(mergedId);
      return fromRow(row);
    });
  }

  public forget(id: string, _reason: string, now = this.options.clock.now()): Promise<Memory> {
    return this.mutate(async () => {
      const memory = await this.require(id);
      const next = { ...memory, status: "forgotten" as const, forgottenAt: now, updatedAt: now, revision: (memory.revision ?? 0) + 1 };
      await this.table.set(id, toUpdate(toRow(next)));
      return next;
    });
  }

  public restore(id: string, now = this.options.clock.now()): Promise<Memory> {
    return this.mutate(async () => {
      const memory = await this.require(id);
      const next = { ...memory, status: "active" as const, forgottenAt: undefined, updatedAt: now, revision: (memory.revision ?? 0) + 1 };
      await this.table.set(id, toUpdate(toRow(next)));
      return next;
    });
  }

  public queryVisible(context: ChannelContext, userIds: readonly string[], query: MemoryQuery = {}): Promise<Memory[]> {
    return this.searchVisible(context, userIds, query).then((result) => result.memories);
  }

  /**
   * Visibility-filtered retrieval. Without `semantic` this is the historical
   * keyword/tag filter ranked by retention. With `semantic` and a configured
   * embedding model, the keyword filter becomes a signal instead of a hard
   * gate: a memory is recalled when it matches the keywords or is similar
   * enough to the query, and ranking blends similarity into retention.
   */
  public searchVisible(context: ChannelContext, userIds: readonly string[], query: MemoryQuery = {}): Promise<{ memories: Memory[]; semanticUsed: boolean }> {
    return this.mutate(async () => {
      const now = this.options.clock.now();
      const tenantId = await this.tenantId();
      const owner = await this.ownerContext(context, userIds);
      const scopes = query.scopes ?? ["channel", "user", "shared"];
      const terms = query.query?.toLocaleLowerCase().trim();
      const requiredTags = query.tags ?? [];
      const rows = await this.table.all();
      const pool = rows.map(fromRow).filter((memory) => {
        if (memory.status !== "active" || !scopes.includes(memory.scope) || !isVisible(memory, context, userIds, tenantId, owner)) return false;
        if (query.types && !query.types.includes(memory.type)) return false;
        return requiredTags.every((tag) => memory.tags.includes(tag));
      });
      const matchesKeywords = (memory: Memory) => !terms || `${memory.content}\n${memory.tags.join("\n")}`.toLocaleLowerCase().includes(terms);
      const byRetention = (left: Memory, right: Memory) =>
        retentionScore(right, now, HALF_LIFE_DAYS) * right.confidence - retentionScore(left, now, HALF_LIFE_DAYS) * left.confidence;
      const limit = (values: Memory[]) => (query.limit === undefined ? values : values.slice(0, query.limit));

      const indexer = this.indexer;
      if (!query.semantic || !indexer || !terms) return { memories: limit(pool.filter(matchesKeywords).sort(byRetention)), semanticUsed: false };

      const queryVector = await indexer.embed(`${indexer.queryPrefix}${query.query!.trim()}`);
      if (!queryVector) return { memories: limit(pool.filter(matchesKeywords).sort(byRetention)), semanticUsed: false };

      let semanticUsed = false;
      const scored: Array<{ memory: Memory; score: number }> = [];
      for (const memory of pool) {
        const stored = usableEmbedding(memory, indexer.modelId);
        const similarity = stored ? Math.max(0, cosineSimilarity(queryVector, stored)) : undefined;
        if (similarity !== undefined) semanticUsed = true;
        if (!matchesKeywords(memory) && (similarity === undefined || similarity < SEMANTIC_MIN_SIMILARITY)) continue;
        scored.push({
          memory,
          score: retentionScore(memory, now, HALF_LIFE_DAYS) * memory.confidence * (1 + SEMANTIC_BOOST_WEIGHT * (similarity ?? 0)),
        });
      }
      scored.sort((left, right) => right.score - left.score);
      return { memories: limit(scored.map((entry) => entry.memory)), semanticUsed };
    });
  }

  /** The memory when it is active and visible in this conversation to these people; what may read its attachments. */
  public async visibleMemory(id: string, context: ChannelContext, userIds: readonly string[]): Promise<Memory | undefined> {
    const current = await this.get(id);
    if (!current || current.status !== "active") return undefined;
    const tenantId = await this.tenantId();
    const owner = await this.ownerContext(context, userIds);
    return isVisible(current, context, userIds, tenantId, owner) ? current : undefined;
  }

  /** True only in the verified owner's own direct conversation (the transport authenticates it, not a name or ID). */
  public isOwnerConversation(context: ChannelContext): Promise<boolean> {
    return this.ownerContext(context);
  }

  /** Raw evidence has its own source ACL; a shared summary never publishes the source conversation. */
  public async visibleEvidence(
    memory: Memory,
    context: ChannelContext,
    userIds: readonly string[],
    messages: readonly MessageRecord[],
  ): Promise<MessageRecord[]> {
    const current = await this.get(memory.id);
    if (!current || current.status !== "active") return [];
    const tenantId = await this.tenantId();
    const owner = await this.ownerContext(context, userIds);
    if (!isVisible(current, context, userIds, tenantId, owner)) return [];
    return messages.filter(
      (message) => !message.whisper && ((current.tenantId === tenantId && current.visibility === "owner" && owner) || messageInConversation(message, context)),
    );
  }

  private async tenantId(): Promise<string> {
    const configured = this.options.tenantId;
    return uuid.parse(typeof configured === "function" ? await configured() : configured);
  }

  private async ownerContext(context: ChannelContext, userIds?: readonly string[]): Promise<boolean> {
    if (context.type !== "direct" || !context.selfId || !this.options.isOwner) return false;
    if (userIds && (!userIds.includes(context.userId) || userIds.some((id) => id !== context.userId && id !== context.selfId))) return false;
    return await this.options.isOwner(context);
  }

  /**
   * Backfill vectors for memories written before an embedding model existed, or
   * produced by a different model. Vector calls run outside the mutation tail so
   * a bulk reindex cannot stall recall.
   */
  public async reindex(limit = REINDEX_BATCH): Promise<number> {
    const indexer = this.indexer;
    if (!indexer) return 0;
    const stale = await this.mutate(async () => {
      const tenantId = await this.tenantId();
      const rows = await this.table.all();
      return rows
        .map(fromRow)
        .filter((memory) => memory.tenantId === tenantId && memory.status === "active" && !usableEmbedding(memory, indexer.modelId))
        .slice(0, limit);
    });
    let indexed = 0;
    for (const memory of stale) {
      const vector = await this.embedDocument(memory.content, memory.tags);
      if (!vector.embedding) continue;
      await this.mutate(async () => {
        await this.table.set(memory.id, { embedding: vector.embedding, embeddingModel: vector.embeddingModel });
      });
      indexed += 1;
    }
    return indexed;
  }

  public missingEmbeddings(): Promise<number> {
    return this.mutate(async () => {
      const indexer = this.indexer;
      if (!indexer) return 0;
      const tenantId = await this.tenantId();
      const rows = await this.table.all();
      return rows.map(fromRow).filter((memory) => memory.tenantId === tenantId && memory.status === "active" && !usableEmbedding(memory, indexer.modelId))
        .length;
    });
  }

  /**
   * Groups each active memory created since `since` with near-identical memories of the same owned scope. Needs the
   * embedding model; without it only exact duplicates exist, and `create` already reuses those.
   */
  public nearDuplicates(since: number, maxGroups = 20): Promise<Memory[][]> {
    return this.mutate(async () => {
      const indexer = this.indexer;
      const tenantId = await this.tenantId();
      if (!indexer) return [];
      const memories = (await this.table.all())
        .map(fromRow)
        .filter(
          (memory) => memory.status === "active" && memory.tenantId === tenantId && !!memory.platform?.trim() && !!usableEmbedding(memory, indexer.modelId),
        );
      const used = new Set<string>();
      const groups: Memory[][] = [];
      for (const fresh of memories.filter((memory) => memory.createdAt >= since).sort((left, right) => left.createdAt - right.createdAt)) {
        if (used.has(fresh.id)) continue;
        const vector = usableEmbedding(fresh, indexer.modelId)!;
        const near = memories
          .filter((other) => other.id !== fresh.id && !used.has(other.id) && mergeOwnershipKey(other) === mergeOwnershipKey(fresh))
          .map((other) => ({ other, similarity: cosineSimilarity(vector, usableEmbedding(other, indexer.modelId)!) }))
          .filter((candidate) => candidate.similarity >= DUPLICATE_SIMILARITY)
          .sort((left, right) => right.similarity - left.similarity)
          .slice(0, DUPLICATE_GROUP_SIZE - 1)
          .map((candidate) => candidate.other);
        if (!near.length) continue;
        const group = [fresh, ...near];
        for (const memory of group) used.add(memory.id);
        groups.push(group);
        if (groups.length >= maxGroups) break;
      }
      return groups;
    });
  }

  public touch(ids: readonly string[], now = this.options.clock.now()): Promise<void> {
    return this.mutate(async () => {
      for (const id of ids) {
        const memory = await this.require(id);
        await this.table.set(id, { lastAccessedAt: now, accessCount: memory.accessCount + 1, updatedAt: now });
      }
    });
  }

  public sweep(now: number, removeEvidence: (memoryId: string) => Promise<void>): Promise<void> {
    return this.mutate(async () => {
      const tenantId = await this.tenantId();
      const memories = (await this.table.all()).map(fromRow).filter((memory) => memory.tenantId === tenantId);
      const plan = planPrune(memories, now);
      for (const id of plan.forgetIds) {
        const memory = memories.find((item) => item.id === id)!;
        await this.table.set(id, { status: "forgotten", forgottenAt: now, updatedAt: now, revision: (memory.revision ?? 0) + 1 });
      }
      for (const id of plan.removeIds) {
        await removeEvidence(id);
        await this.table.remove(id);
      }
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async require(id: string): Promise<Memory> {
    const row = await this.table.byId(id);
    if (!row) throw refuse("memory_not_found", `memory ${id} not found`);
    return fromRow(row);
  }

  /** Build a document vector, or an explicit clear when indexing is unavailable. */
  private async embedDocument(content: string, tags: readonly string[]): Promise<{ embedding?: number[]; embeddingModel?: string }> {
    const indexer = this.indexer;
    if (!indexer) return {};
    const vector = await indexer.embed(memoryEmbeddingText({ content, tags }));
    return vector ? { embedding: vector, embeddingModel: indexer.modelId } : { embedding: undefined, embeddingModel: undefined };
  }

  /**
   * Recompute the vector after a content or tag edit. A stale vector is always
   * cleared when it cannot be refreshed, because otherwise it would keep
   * describing text that no longer exists.
   */
  private async reindexIfNeeded(before: Memory, after: Memory): Promise<{ embedding?: number[]; embeddingModel?: string }> {
    if (before.content === after.content && before.tags.join("\u0000") === after.tags.join("\u0000")) return {};
    const indexer = this.indexer;
    if (!indexer) return { embedding: undefined, embeddingModel: undefined };
    const vector = await indexer.embed(memoryEmbeddingText(after));
    return vector ? { embedding: vector, embeddingModel: indexer.modelId } : { embedding: undefined, embeddingModel: undefined };
  }
}

export function planPrune(memories: readonly Memory[], now: number): PrunePlan {
  const forgetIds = new Set<string>();
  const removeIds: string[] = [];
  const grace = FORGOTTEN_GRACE_DAYS * 24 * 60 * 60 * 1_000;
  const activeByScope = new Map<string, Memory[]>();
  for (const memory of memories) {
    if (memory.status === "forgotten") {
      if (memory.forgottenAt !== undefined && memory.forgottenAt + grace <= now) removeIds.push(memory.id);
      continue;
    }
    const score = retentionScore(memory, now, HALF_LIFE_DAYS) * memory.confidence;
    if (score < 0.05) forgetIds.add(memory.id);
    const key = mergeOwnershipKey(memory);
    const group = activeByScope.get(key) ?? [];
    group.push(memory);
    activeByScope.set(key, group);
  }
  for (const group of activeByScope.values()) {
    group.sort((left, right) => retentionScore(right, now, HALF_LIFE_DAYS) * right.confidence - retentionScore(left, now, HALF_LIFE_DAYS) * left.confidence);
    for (const memory of group.slice(MAX_ACTIVE_PER_SCOPE)) forgetIds.add(memory.id);
  }
  return { forgetIds: [...forgetIds], removeIds };
}

function toRow(
  input:
    | (MemoryCreateInput & Pick<Memory, "id" | "tenantId" | "visibility" | "status" | "createdAt" | "updatedAt" | "lastAccessedAt" | "accessCount">)
    | Memory,
): MemoryRow {
  validateMemory(input);
  const context = "context" in input ? input.context : undefined;
  const existing = "channelType" in input ? input : undefined;
  const channel = input.scope !== "shared" ? context : undefined;
  return {
    id: input.id,
    type: input.type,
    content: input.content,
    scope: input.scope,
    tenantId: input.tenantId,
    visibility: input.visibility,
    revision: "revision" in input ? (input.revision ?? 0) : 1,
    channelType: channel?.type ?? existing?.channelType ?? null,
    platform: input.scope !== "channel" ? (input.platform ?? null) : (channel?.platform ?? existing?.platform ?? null),
    guildId: channel?.type === "channel" || channel?.type === "guild" ? channel.guildId : (existing?.guildId ?? null),
    channelId: channel?.channelId ?? existing?.channelId ?? null,
    selfId: channel?.selfId ?? existing?.selfId ?? null,
    userId: input.scope === "user" ? (input.userId ?? null) : null,
    importance: input.importance,
    confidence: input.confidence,
    tags: [...input.tags],
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastAccessedAt: input.lastAccessedAt,
    accessCount: input.accessCount,
    forgottenAt: "forgottenAt" in input ? (input.forgottenAt ?? null) : null,
    embedding: input.embedding ?? null,
    embeddingModel: input.embeddingModel ?? null,
  };
}

/** Minato rejects primary keys in set payloads, even when their value is unchanged. */
function toUpdate(row: MemoryRow): Omit<MemoryRow, "id"> {
  const { id: _id, ...patch } = row;
  return patch;
}

function fromRow(row: MemoryRow): Memory {
  return {
    ...row,
    type: (row.type ?? "fact") as MemoryType,
    channelType: row.channelType ?? undefined,
    platform: row.platform ?? undefined,
    guildId: row.guildId ?? undefined,
    channelId: row.channelId ?? undefined,
    selfId: row.selfId ?? undefined,
    userId: row.userId ?? undefined,
    forgottenAt: row.forgottenAt ?? undefined,
    embedding: row.embedding ?? undefined,
    embeddingModel: row.embeddingModel ?? undefined,
  };
}

function validateMemory(input: MemoryCreateInput | Memory): void {
  if (!input.content.trim()) throw refuse("memory_content_empty");
  if (input.importance < 0 || input.importance > 1 || input.confidence < 0 || input.confidence > 1) throw refuse("memory_score_range");
  if (input.scope === "channel" && !("context" in input ? input.context : "channelId" in input && input.channelId && input.platform))
    throw refuse("memory_channel_context_required");
  if (input.scope === "user" && !(input.platform && input.userId)) throw refuse("memory_user_scope_incomplete");
  if (
    input.scope === "shared" &&
    (("context" in input && input.context) || input.userId || ("channelId" in input && (input.channelId || input.channelType || input.guildId || input.selfId)))
  )
    throw refuse("memory_scope_targets_invalid");
}

function isVisible(memory: Memory, context: ChannelContext, userIds: readonly string[], tenantId: string, owner = false): boolean {
  if (memory.tenantId !== tenantId || !context.platform?.trim()) return false;
  if (memory.visibility === "owner") return context.type === "direct" && owner;
  if (memory.visibility === "shared") return true;
  if (memory.visibility !== "conversation") return false;
  if (!memory.platform?.trim() || memory.platform !== context.platform) return false;
  if (!memory.selfId || !context.selfId || memory.selfId !== context.selfId) return false;
  if (memory.scope === "user" && (!memory.userId || !userIds.includes(memory.userId))) return false;
  return (
    memory.platform === context.platform &&
    memory.channelId === context.channelId &&
    memory.channelType === context.type &&
    memory.guildId === (context.type === "direct" ? undefined : context.guildId)
  );
}

function toManaged(memory: Memory): ManagedMemory {
  return {
    id: memory.id,
    content: memory.content,
    type: memory.type,
    visibility: memory.visibility,
    revision: memory.revision ?? 0,
    updatedAt: memory.updatedAt,
    source: { platform: memory.platform, channelId: memory.channelId },
  };
}

/** Ownership is immutable even when callers pass fields outside the tool schema. */
function ownershipKey(memory: Memory): string {
  return JSON.stringify([
    memory.scope,
    memory.tenantId,
    memory.visibility,
    memory.platform,
    memory.channelType,
    memory.guildId,
    memory.channelId,
    memory.selfId,
    memory.userId,
  ]);
}

/** Modern owner/shared facts can consolidate across source platforms, inside exactly one tenant. */
function mergeOwnershipKey(memory: Memory): string {
  return memory.visibility === "owner" || memory.visibility === "shared"
    ? JSON.stringify([memory.tenantId, memory.visibility, memory.scope])
    : ownershipKey(memory);
}

function assertOwnershipPatch(memory: Memory, patch: MemoryUpdateInput): void {
  if (ownershipKey({ ...memory, ...patch }) !== ownershipKey(memory)) throw refuse("memory_ownership_immutable");
  if (patch.context !== undefined) {
    const context = patch.context;
    if (
      memory.scope === "shared" ||
      context.selfId !== memory.selfId ||
      context.platform !== memory.platform ||
      context.type !== memory.channelType ||
      context.channelId !== memory.channelId ||
      (context.type === "direct" ? context.selfId !== memory.selfId : context.guildId !== memory.guildId)
    )
      throw refuse("memory_ownership_immutable");
  }
}
