import { AppError, type Clock } from "@yesimbot/foundation";
import type { ChannelContext, ConversationReadOptions, FilePart, ImagePart, MessageRecord, Part } from "koishi-plugin-yesimbot/kernel";

import { attachmentUri } from "./attachment-uri.js";
import { refuse } from "./errors.js";
import { MAX_ATTACHMENTS, type EvidenceStore, type NewAttachment } from "./store/evidence.js";
import type { MemoryStore } from "./store/memory.js";
import type { Memory, MemoryCreateInput, MemoryScope, MemoryType, MemoryUpdateInput } from "./types.js";
import { containsCredential, messageInConversation, messageText } from "./visibility.js";

/** Most evidence messages one write may cite. */
export const MAX_WRITE_SOURCES = 50;

/** Shortest ID prefix accepted for an existing memory (what the pre-summary review shows). */
export const SHORT_ID_LENGTH = 8;
const DEFAULT_IMPORTANCE = 0.7;
const DEFAULT_CONFIDENCE = 0.85;
/** How the model sees a picture or file in a message: `[图片：asset://…]`, `[文件：name asset://…]`. */
const ASSET_URI = /^asset:\/\/([a-f0-9]{32})$/;
/** Text a credential check reads from an attached text file. */
const TEXT_CHECK_BYTES = 1024 * 1024;

export interface RememberInput {
  readonly content: string;
  readonly sources: string[];
  readonly type: MemoryType;
  readonly scope?: MemoryScope;
  readonly userId?: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly tags?: string[];
  /** `asset://` pictures or files of the source messages to keep with the memory. */
  readonly attachments?: string[];
}

export interface UpdateMemoryInput {
  readonly id: string;
  readonly content?: string;
  readonly sources?: string[];
  readonly type?: MemoryType;
  readonly importance?: number;
  readonly confidence?: number;
  readonly tags?: string[];
  /** Replaces the kept pictures and files; `[]` drops them. Non-empty needs the sources they are in. */
  readonly attachments?: string[];
  readonly forget?: boolean;
}

export interface OpenedResource {
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
  readonly filename?: string;
}

export interface MemoryWriter {
  readonly clock: Clock;
  readonly context: ChannelContext;
  readonly store: MemoryStore;
  readonly evidence: EvidenceStore;
  readonly readConversation: (context: ChannelContext, options: ConversationReadOptions) => Promise<MessageRecord[]>;
  /** This conversation's resources (Core's `openStrict`); without it a memory cannot take attachments. */
  readonly openResource?: (uri: string) => Promise<OpenedResource>;
  /** Whether this direct chat is the owner's, who may publish; without it only the transport's verified owner may. */
  readonly mayPublish?: () => Promise<boolean>;
}

/**
 * The main model's own write (user decision 2026-11-20: it decides what to remember; nothing reviews it afterwards).
 * Hard rules stay in code: persisted in-conversation evidence, no credentials, and a private chat becomes shared only
 * in the owner's own (`mayPublish`; user, 2026-11-24: 「只有主人私聊可以」). An identical fact in the same owned scope
 * is reused and only gains evidence (and attachments).
 */
export async function rememberMemory(writer: MemoryWriter, input: RememberInput) {
  const content = input.content.trim();
  if (!content) throw refuse("memory_content_empty");
  if (containsCredential(content)) throw refuse("memory_credential");
  const sources = await readSources(writer, input.sources);
  const files = await readAttachments(writer, input.attachments, sources);
  const scope = input.scope ?? "channel";
  const speakers = new Set(sources.map((message) => message.user.id));
  const values = {
    type: input.type,
    content,
    importance: input.importance ?? DEFAULT_IMPORTANCE,
    confidence: input.confidence ?? DEFAULT_CONFIDENCE,
    tags: input.tags ?? [],
  };
  assertDurable(values);
  let create: MemoryCreateInput;
  if (scope === "shared") {
    await assertShareable(writer, content, sources);
    create = { ...values, scope, platform: writer.context.platform };
  } else if (scope === "user") {
    const others = [...speakers].filter((id) => id !== writer.context.selfId);
    const userId = input.userId ?? (others.length === 1 ? others[0] : undefined);
    if (!userId) throw refuse("memory_user_required");
    if (!speakers.has(userId)) throw refuse("memory_user_not_speaker");
    create = { ...values, scope, context: writer.context, platform: writer.context.platform, userId };
  } else {
    create = { ...values, scope, context: writer.context };
  }
  const startedAt = writer.clock.now();
  const memory = await writer.store.create(create);
  await writer.evidence.append(memory.id, sources);
  const attachments = files.length ? await writer.evidence.attach(memory.id, files) : [];
  return {
    saved: true as const,
    id: memory.id,
    content: memory.content,
    type: memory.type,
    scope: memory.scope,
    reusedExisting: memory.createdAt < startedAt,
    ...(attachments.length ? { attachments: attachments.map((item) => attachmentUri(memory.id, item)) } : {}),
  };
}

/** Changes or forgets one memory visible here; a changed fact must cite the messages that support it. */
export async function updateMemory(writer: MemoryWriter, userIds: readonly string[], input: UpdateMemoryInput) {
  const sources = input.sources?.length ? await readSources(writer, input.sources) : [];
  const visibleTo = [...new Set([...userIds, ...sources.map((message) => message.user.id)])];
  const memory = await resolveVisible(writer, visibleTo, input.id);
  if (input.forget) {
    await writer.store.forget(memory.id, "main-model");
    return { forgotten: true as const, id: memory.id };
  }
  const shared = memory.visibility === "shared";
  if (shared && writer.context.type === "direct" && !(await mayPublish(writer))) throw refuse("memory_edit_shared_owner_only");
  if (input.attachments?.length && !sources.length) throw refuse("memory_attachment_source_required");
  const files = await readAttachments(writer, input.attachments, sources);
  const patch: { -readonly [Key in keyof MemoryUpdateInput]: MemoryUpdateInput[Key] } = {};
  if (input.type !== undefined) patch.type = input.type;
  if (input.importance !== undefined) patch.importance = input.importance;
  if (input.confidence !== undefined) patch.confidence = input.confidence;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.content !== undefined) {
    const content = input.content.trim();
    if (!content) throw refuse("memory_content_empty");
    if (containsCredential(content)) throw refuse("memory_credential");
    if (!sources.length) throw refuse("memory_content_sources_required");
    if (shared) await assertShareable(writer, content, sources);
    patch.content = content;
  }
  if (!Object.keys(patch).length && input.attachments === undefined) throw refuse("memory_update_empty");
  assertDurable({ ...memory, ...patch });
  const updated = Object.keys(patch).length ? await writer.store.update(memory.id, patch, memory.revision ?? 0) : memory;
  if (sources.length) await writer.evidence.append(memory.id, sources);
  const attachments = input.attachments === undefined ? undefined : await writer.evidence.attach(memory.id, files, true);
  return {
    updated: true as const,
    id: updated.id,
    content: updated.content,
    type: updated.type,
    ...(attachments ? { attachments: attachments.map((item) => attachmentUri(memory.id, item)) } : {}),
  };
}

/** A full ID or a unique prefix of at least eight characters, among memories visible in this conversation. */
async function resolveVisible(writer: MemoryWriter, userIds: readonly string[], id: string): Promise<Memory> {
  const key = id.trim();
  if (key.length < SHORT_ID_LENGTH) throw refuse("memory_id_too_short");
  const visible = await writer.store.queryVisible(writer.context, userIds);
  const matches = visible.filter((memory) => memory.id === key || memory.id.startsWith(key));
  const exact = matches.find((memory) => memory.id === key);
  if (exact) return exact;
  if (matches.length === 1) return matches[0]!;
  throw refuse(matches.length ? "memory_id_ambiguous" : "memory_not_visible");
}

/** Evidence comes from the persisted conversation log, never the live request or a summary. */
async function readSources(writer: MemoryWriter, ids: readonly string[]): Promise<MessageRecord[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw refuse("memory_sources_required");
  if (unique.length > MAX_WRITE_SOURCES) throw refuse("memory_sources_too_many");
  let messages: MessageRecord[];
  try {
    messages = await writer.readConversation(writer.context, { messageIds: unique, before: 0, after: 0, limit: unique.length });
  } catch (cause) {
    throw new AppError("memory_source_missing", { effect: "none", cause });
  }
  const sources = unique.map((id) => messages.filter((message) => message.messageId === id));
  if (sources.some((matches) => matches.length !== 1 || !messageInConversation(matches[0]!, writer.context))) throw refuse("memory_source_foreign");
  const records = sources.map((matches) => matches[0]!);
  if (records.some((message) => containsCredential(messageText(message)))) throw refuse("memory_source_credential");
  return records;
}

function mayPublish(writer: MemoryWriter): Promise<boolean> {
  return writer.mayPublish ? writer.mayPublish() : writer.store.isOwnerConversation(writer.context);
}

function assertDurable(value: { importance: number; confidence: number }): void {
  if (!Number.isFinite(value.importance) || value.importance < 0.6 || value.importance > 1) throw refuse("memory_importance_range");
  if (!Number.isFinite(value.confidence) || value.confidence < 0.7 || value.confidence > 1) throw refuse("memory_confidence_range");
}

/**
 * The pictures or files named by `asset://` URIs, each found in a source message (or the message it quotes). Text files
 * carrying credentials are refused like credential-bearing content.
 */
async function readAttachments(writer: MemoryWriter, uris: readonly string[] | undefined, sources: readonly MessageRecord[]): Promise<NewAttachment[]> {
  const unique = [...new Set((uris ?? []).map((uri) => uri.trim()))];
  if (!unique.length) return [];
  if (unique.length > MAX_ATTACHMENTS) throw refuse("memory_attachments_too_many");
  if (!writer.openResource) throw refuse("memory_attachments_unavailable");
  const files: NewAttachment[] = [];
  for (const uri of unique) {
    const assetId = ASSET_URI.exec(uri)?.[1];
    const found = assetId ? findAsset(sources, assetId) : undefined;
    if (!found) throw refuse("memory_attachment_not_in_sources", uri);
    let opened: OpenedResource;
    try {
      opened = await writer.openResource(uri);
    } catch (cause) {
      throw new AppError("memory_attachment_unreadable", { effect: "none", detail: uri, cause });
    }
    const mediaType = opened.mediaType?.trim() || "application/octet-stream";
    if (/^text\/|json|xml|yaml|toml/.test(mediaType) && containsCredential(new TextDecoder().decode(opened.bytes.subarray(0, TEXT_CHECK_BYTES))))
      throw refuse("memory_attachment_credential");
    const name = found.name ?? opened.filename;
    files.push({ bytes: opened.bytes, mediaType, messageId: found.messageId, ...(name ? { name } : {}) });
  }
  return files;
}

function findAsset(sources: readonly MessageRecord[], assetId: string): { messageId: string; name?: string } | undefined {
  const search = (parts: readonly Part[] | undefined): ImagePart | FilePart | undefined => {
    for (const part of parts ?? []) {
      if ((part.type === "image" || part.type === "file") && part.asset === assetId) return part;
      const nested = part.type === "quote" || part.type === "platform" ? search(part.parts) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };
  for (const message of sources) {
    const part = search(message.parts) ?? search(message.quote?.parts);
    if (!part) continue;
    const name = part.title?.trim();
    return { messageId: message.messageId, ...(name ? { name: name.slice(0, 200) } : {}) };
  }
  return undefined;
}

/** Public knowledge comes from a group, or from the owner's own direct chat; it never names its sources' people. */
async function assertShareable(writer: MemoryWriter, content: string, sources: readonly MessageRecord[]): Promise<void> {
  if (writer.context.type === "direct" && !(await mayPublish(writer))) throw refuse("memory_publish_owner_only");
  if (sources.some((message) => content.includes(message.user.id) || (!!message.user.name && content.includes(message.user.name))))
    throw refuse("memory_shared_names_person");
}
