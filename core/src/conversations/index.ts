import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { createEntry, createJsonlStorage, type AgentEntry, type AgentStorage } from "@yesimbot/agent-runtime";

import { type MessageRecord } from "../messages/index.js";
import { requestUnits } from "../runtimes/context-budget.js";
import {
  contextRegionLineage,
  contextRegionSource,
  normalizedSessionId,
  resolveContextRegionSource,
  validatedContextRegions,
  type ContextSourceSnapshot,
} from "./context-blocks.js";
import { CONVERSATION_ERRORS, conversationError } from "./errors.js";
import {
  CONTEXT_REGION_PROMPT_VERSION,
  validateContextRegionData,
  validateContextRegionDraft,
  type ContextRegionDraft,
  type ContextRegionEntry,
  type FrozenContextRegion,
} from "./historian.js";
import {
  limitNewestMessages,
  limitSourceMessages,
  matchesReadFilter,
  selectSourceWindows,
  validateReadOptions,
  type ConversationReadOptions,
  type ReadMessage,
  type ReadSession,
} from "./read-query.js";
import type { ReplyJournalSink } from "./reply-journal.js";
import { replyHistoryContent, replySourceEntryIds, resolveReplyHistory } from "./reply-receipt.js";

export type ConversationInfo = { filename: string; isActive: boolean; size: number; createdAt: string };

export type ConversationStatus = { active: ConversationInfo | null };

export class Conversation {
  private readonly root: string;
  private storagePathValue: string | undefined;
  private fileStorageValue: AgentStorage<AgentEntry> | undefined;
  private storageTail: Promise<void> = Promise.resolve();
  private initializing: Promise<void> | undefined;
  private storageGenerationValue = 0;
  private readonly frozenRegions = new WeakSet<FrozenContextRegion>();
  private readonly regionIndex = new Map<string, { stamp: string; regions: readonly ContextRegionEntry[] }>();

  public constructor(root: string) {
    this.root = root;
  }

  public get storage(): AgentStorage<AgentEntry> {
    if (!this.storagePathValue) throw conversationError(CONVERSATION_ERRORS.conversation_not_initialized);
    return {
      append: (...entries) => this.mutateStorage(async () => this.currentStorage().append(...entries)),
      read: () => this.readStorage(),
      clear: () =>
        this.mutateStorage(async () => {
          this.storageGenerationValue += 1;
          await this.currentStorage().clear();
        }),
    };
  }

  public async init(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (this.storagePathValue) return;
    this.initializing = (async () => {
      this.setStorage(await this.createOrResolve());
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  public get storageGeneration(): number {
    return this.storageGenerationValue;
  }

  /**
   * Generation-bound append-only writer for the Core actual-delivery journal. It is deliberately
   * independent of the SDK execution signal: effects that already happened locally stay readable
   * after an abort discards the normal tool receipt. A session/generation change rejects late writes
   * instead of repopulating a replacement history.
   */
  public replyProofSink(durable = false): ReplyJournalSink {
    return {
      append: (entry, expected) => this.mutateStorage(() => this.appendReplyProof(entry, expected, durable)),
    };
  }

  private async appendReplyProof(
    entry: AgentEntry,
    expected: { sessionId: string; generation: number; signal?: AbortSignal },
    durable: boolean,
  ): Promise<void> {
    expected.signal?.throwIfAborted();
    if (this.storageGenerationValue !== expected.generation || this.currentSessionId() !== expected.sessionId)
      throw conversationError(CONVERSATION_ERRORS.reply_proof_generation_changed);
    await this.currentStorage().append(entry);
    if (durable) await this.syncStorage();
  }

  private async syncStorage(): Promise<void> {
    const file = await open(this.storagePathValue!, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }

  /** A short canonical read; no auxiliary generation runs while this mutation queue is held. */
  public async freezeContextRegion(sourceEntryIds: readonly string[]): Promise<FrozenContextRegion> {
    const sourceIds = [...sourceEntryIds];
    await this.init();
    return this.mutateStorage(async () => {
      const entries = await this.currentStorage().read();
      const sessionId = this.currentSessionId();
      const source = contextRegionSource(entries, sourceIds);
      const frozen: FrozenContextRegion = Object.freeze({
        ...source,
        sessionId,
        sourceSession: sessionId,
        storageGeneration: this.storageGenerationValue,
        lineageId: contextRegionLineage(entries, sessionId),
        promptVersion: CONTEXT_REGION_PROMPT_VERSION,
        sourceEntryIds: Object.freeze(source.sourceEntryIds),
        records: Object.freeze(source.records.map((record) => Object.freeze(record))),
      });
      this.frozenRegions.add(frozen);
      return frozen;
    });
  }

  /** A complete, validated region is appended in one JSONL entry, never as partial tier records. */
  public async commitContextRegion(frozen: FrozenContextRegion, draft: ContextRegionDraft, signal?: AbortSignal): Promise<ContextRegionEntry> {
    const semantic = validateContextRegionDraft(draft);
    return this.mutateStorage(async () => {
      signal?.throwIfAborted();
      if (!this.frozenRegions.has(frozen) || frozen.sessionId !== this.currentSessionId() || frozen.storageGeneration !== this.storageGenerationValue)
        throw conversationError(CONVERSATION_ERRORS.context_region_stale);
      const entries = await this.currentStorage().read();
      const source = contextRegionSource(entries, frozen.sourceEntryIds);
      if (
        contextRegionLineage(entries, frozen.sessionId) !== frozen.lineageId ||
        source.sourceFingerprint !== frozen.sourceFingerprint ||
        source.sourceProjectionFingerprint !== frozen.sourceProjectionFingerprint ||
        source.sourceStartAt !== frozen.sourceStartAt ||
        source.sourceEndAt !== frozen.sourceEndAt
      )
        throw conversationError(CONVERSATION_ERRORS.context_region_source_conflict);
      const snapshot = await this.regionSourceSnapshot(entries);
      let reused: ContextRegionEntry | undefined;
      for (const existing of entries) {
        if (existing.type !== "context-region") continue;
        let data;
        try {
          data = validateContextRegionData(existing.data);
        } catch {
          continue;
        }
        if (!data.sourceEntryIds.some((id) => frozen.sourceEntryIds.includes(id))) continue;
        if (
          data.sourceSession !== frozen.sourceSession ||
          data.lineageId !== frozen.lineageId ||
          data.sourceFingerprint !== frozen.sourceFingerprint ||
          JSON.stringify(data.sourceEntryIds) !== JSON.stringify(frozen.sourceEntryIds)
        )
          throw conversationError(CONVERSATION_ERRORS.context_region_source_conflict);
        await resolveContextRegionSource(snapshot, existing);
        if (reused && JSON.stringify(reused.data) !== JSON.stringify(existing.data))
          throw conversationError(CONVERSATION_ERRORS.context_region_source_conflict);
        reused = existing;
      }
      signal?.throwIfAborted();
      if (reused) return reused;
      const data = validateContextRegionData({
        version: 1,
        lineageId: frozen.lineageId,
        sourceSession: frozen.sourceSession,
        sourceEntryIds: [...frozen.sourceEntryIds],
        sourceFingerprint: frozen.sourceFingerprint,
        sourceStartAt: frozen.sourceStartAt,
        sourceEndAt: frozen.sourceEndAt,
        promptVersion: frozen.promptVersion,
        ...semantic,
      });
      const entry = createEntry("context-region", data);
      signal?.throwIfAborted();
      await this.currentStorage().append(entry);
      return entry;
    });
  }

  /** Only current reachable roots are recovered; archived originals are verified, not re-summarized. */
  public async contextRegions(): Promise<readonly ContextRegionEntry[]> {
    await this.init();
    return this.mutateStorage(async () => validatedContextRegions(await this.regionSourceSnapshot(await this.currentStorage().read())));
  }

  public currentSessionId(): string {
    if (!this.storagePathValue) throw conversationError(CONVERSATION_ERRORS.conversation_not_initialized);
    return basename(this.storagePathValue, ".jsonl");
  }

  public async list(): Promise<ConversationInfo[]> {
    const active = this.storagePathValue;
    return Promise.all(
      (await this.files()).reverse().map(async (filename) => ({
        filename,
        isActive: join(this.sessionsPath(), filename) === active,
        size: (await stat(join(this.sessionsPath(), filename))).size,
        createdAt: basename(filename, ".jsonl"),
      })),
    );
  }

  public async status(): Promise<ConversationStatus> {
    return { active: (await this.list()).find((item) => item.isActive) ?? null };
  }

  public async switch(id: string): Promise<void> {
    await this.init();
    const filename = id.endsWith(".jsonl") ? id : `${id}.jsonl`;
    if (!/^[0-9A-Za-zTZ_-]+\.jsonl$/.test(filename)) throw conversationError(CONVERSATION_ERRORS.conversation_session_invalid, { detail: filename });
    await this.mutateStorage(async () => {
      const path = join(this.sessionsPath(), filename);
      await stat(path);
      this.setStorage(path);
    });
  }

  /** Starts a new session file; unless `noSummary`, it carries the verified regions and every uncovered record. */
  public async archive(noSummary = false): Promise<void> {
    await this.init();
    await this.mutateStorage(() => this.rotate(noSummary));
  }

  public async archiveIfOversize(maxBytes: number): Promise<boolean> {
    await this.init();
    if (maxBytes <= 0) return false;
    return this.mutateStorage(async () => {
      if ((await stat(this.storagePathValue!)).size <= maxBytes) return false;
      return this.rotate(false, true);
    });
  }

  public async read(options: ConversationReadOptions = {}): Promise<MessageRecord[]> {
    validateReadOptions(options);
    const sessions: ReadSession[] = [];
    const sourceMatches = new Map<string, ReadMessage[]>();

    for (const filename of await this.files()) {
      const messages: ReadMessage[] = [];
      for (const entry of await createJsonlStorage(join(this.sessionsPath(), filename)).read()) {
        if (entry.type !== "message" || !isPlatformMessage(entry.data)) continue;
        messages.push({ record: { ...entry.data.data, timestamp: entry.data.timestamp }, session: filename, index: messages.length });
      }
      sessions.push({ filename, messages });
      for (const message of messages) {
        if (!options.messageIds?.includes(message.record.messageId)) continue;
        const matches = sourceMatches.get(message.record.messageId) ?? [];
        matches.push(message);
        sourceMatches.set(message.record.messageId, matches);
      }
    }

    const sourceIds = options.messageIds ?? [];
    for (const sourceId of sourceIds) {
      const matches = sourceMatches.get(sourceId) ?? [];
      if (matches.length !== 1)
        throw conversationError(CONVERSATION_ERRORS.conversation_source_message_invalid, {
          detail: `${sourceId} ${matches.length ? "duplicated" : "missing"}`,
        });
    }

    const selected = sourceIds.length ? selectSourceWindows(sessions, sourceMatches, options) : sessions.flatMap(({ messages }) => messages);
    const filtered = selected.filter((message) => matchesReadFilter(message.record, options));
    const limited = sourceIds.length ? limitSourceMessages(filtered, sourceMatches, options.limit) : limitNewestMessages(filtered, options.limit);
    return limited.sort((left, right) => left.record.timestamp - right.record.timestamp).map(({ record }) => record);
  }

  /** Rebuildable archive metadata index; never caches a second copy of archived raw bodies. */
  public async contextSources(): Promise<ContextSourceSnapshot> {
    if (!this.storagePathValue) throw conversationError(CONVERSATION_ERRORS.conversation_not_initialized);
    return this.mutateStorage(() => this.contextSourcesNow());
  }

  private async contextSourcesNow(): Promise<ContextSourceSnapshot> {
    const sessionId = this.currentSessionId();
    const entries = await this.currentStorage().read();
    const filenames = (await this.files()).filter((name) => /^[0-9A-Za-zTZ_-]+\.jsonl$/.test(name));
    const sessionIds = filenames.map(normalizedSessionId);
    const regions: ContextRegionEntry[] = [];
    for (const filename of filenames) {
      const id = normalizedSessionId(filename);
      if (id === sessionId) {
        regions.push(...entries.filter((entry): entry is ContextRegionEntry => entry.type === "context-region"));
        continue;
      }
      const info = await stat(join(this.sessionsPath(), filename));
      const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = this.regionIndex.get(id);
      if (cached?.stamp === stamp) {
        regions.push(...cached.regions);
        continue;
      }
      const historical = await createJsonlStorage(join(this.sessionsPath(), filename)).read();
      const indexed = historical.filter((entry): entry is ContextRegionEntry => entry.type === "context-region");
      this.regionIndex.set(id, { stamp, regions: indexed });
      regions.push(...indexed);
    }
    for (const id of this.regionIndex.keys()) if (!sessionIds.includes(id)) this.regionIndex.delete(id);
    return {
      sessionId,
      lineageId: contextRegionLineage(entries, sessionId),
      entries,
      regions,
      sessionIds,
      readSession: async (input) => {
        const id = normalizedSessionId(input);
        if (!sessionIds.includes(id)) throw conversationError(CONVERSATION_ERRORS.context_region_source_unavailable, { detail: "source session" });
        return id === sessionId ? entries : createJsonlStorage(join(this.sessionsPath(), `${id}.jsonl`)).read();
      },
    };
  }

  private setStorage(path: string): void {
    this.storageGenerationValue += 1;
    this.storagePathValue = path;
    this.fileStorageValue = createJsonlStorage(path);
  }

  private currentStorage(): AgentStorage<AgentEntry> {
    if (!this.fileStorageValue) throw conversationError(CONVERSATION_ERRORS.conversation_not_initialized);
    return this.fileStorageValue;
  }

  private mutateStorage<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.storageTail.then(operation, operation);
    this.storageTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private readStorage(): Promise<Readonly<AgentEntry[]>> {
    return this.storageTail.then(() => this.currentStorage().read());
  }

  /** Minimal source snapshot for short freeze/commit/recovery operations; no archive-corpus scan. */
  private async regionSourceSnapshot(entries: readonly AgentEntry[]): Promise<ContextSourceSnapshot> {
    const sessionId = this.currentSessionId();
    const sessionIds = (await this.files()).map(normalizedSessionId);
    const reads = new Map<string, Promise<readonly AgentEntry[]>>();
    return {
      sessionId,
      lineageId: contextRegionLineage(entries, sessionId),
      entries,
      regions: entries.filter((entry): entry is ContextRegionEntry => entry.type === "context-region"),
      sessionIds,
      readSession: async (input) => {
        const id = normalizedSessionId(input);
        if (!sessionIds.includes(id)) throw conversationError(CONVERSATION_ERRORS.context_region_source_unavailable);
        if (id === sessionId) return entries;
        let read = reads.get(id);
        if (!read) {
          read = Promise.resolve(createJsonlStorage(join(this.sessionsPath(), `${id}.jsonl`)).read());
          reads.set(id, read);
        }
        return read;
      },
    };
  }

  /** Rotation never invokes a model and carries every uncovered record, even without summaries. */
  private async rotate(noSummary: boolean, onlyIfSmaller = false): Promise<boolean> {
    const entries = await this.currentStorage().read();
    if (!entries.length) throw conversationError(CONVERSATION_ERRORS.conversation_empty);
    let seed: readonly AgentEntry[] = [];
    if (!noSummary) {
      const snapshot = await this.regionSourceSnapshot(entries);
      const regions = await validatedContextRegions(snapshot);
      const regionIds = new Set(regions.map((entry) => entry.id));
      const covered = new Set(regions.flatMap((entry) => entry.data.sourceEntryIds));
      const messages = entries.filter((entry) => entry.type === "message");
      const modern = resolveReplyHistory(entries);
      const units = requestUnits(
        messages.map((entry) => ({ content: replyHistoryContent(entry, modern.maskedCalls) })),
        messages.map((entry) => ({ kind: "history" as const, sourceEntryIds: modern.groups.get(entry.id) ?? [entry.id] })),
      );
      const removable = new Set<string>();
      const canonicalCovered = new Set(replySourceEntryIds(entries, covered, modern));
      for (const unit of units) {
        if (!unit.mandatory && [...unit.sourceEntryIds].every((id) => canonicalCovered.has(id))) for (const id of unit.sourceEntryIds) removable.add(id);
      }
      // Original files remain untouched. Carry only verified semantic regions and uncovered protocol units.
      seed = entries.filter((entry) => (entry.type === "context-region" ? regionIds.has(entry.id) : !removable.has(entry.id)));
    }
    // An automatic archive with an identical seed would make another oversized file on every
    // inbound message. Wait for useful committed coverage instead; manual archive still rotates.
    if (onlyIfSmaller && seed.length >= entries.length) return false;
    this.setStorage(await this.createSession(seed));
    return true;
  }

  private async createOrResolve(): Promise<string> {
    await mkdir(this.sessionsPath(), { recursive: true });
    const files = await this.files();
    return files.at(-1) ? join(this.sessionsPath(), files.at(-1)!) : this.createSession();
  }

  private async createSession(entries: readonly AgentEntry[] = []): Promise<string> {
    await mkdir(this.sessionsPath(), { recursive: true });
    const payload = entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
    for (;;) {
      const path = join(this.sessionsPath(), `${formatTimestamp(new Date())}.jsonl`);
      try {
        await writeFile(path, payload, { flag: "wx" });
        return path;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    }
  }

  private async files(): Promise<string[]> {
    try {
      return (await readdir(this.sessionsPath())).filter((name) => name.endsWith(".jsonl") && name !== "messages.jsonl").sort();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  private sessionsPath(): string {
    return join(this.root, "sessions");
  }
}

function isPlatformMessage(value: AgentEntry["data"]): value is {
  readonly role: "custom";
  readonly id: string;
  readonly type: "yesimbot.message";
  readonly timestamp: number;
  readonly data: Omit<MessageRecord, "timestamp">;
} {
  return typeof value === "object" && value !== null && "role" in value && value.role === "custom" && "type" in value && value.type === "yesimbot.message";
}

function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export type { ContextRegionDraft, ContextRegionEntry, FrozenContextRegion } from "./historian.js";

export type { ConversationReadOptions } from "./read-query.js";
