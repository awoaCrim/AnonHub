import { AppError } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";
import type { z } from "zod/v4";

import type { StickerConfig } from "./config.js";
import { STICKER_ERRORS } from "./errors.js";

export type StickerSourceKind = "steal" | "import";

export type SaveStickerResult = { status: "created"; sticker: StickerProjection } | { status: "duplicate"; sticker: StickerProjection };

export interface StickerSource {
  kind: StickerSourceKind;
  platform?: string;
  channelId?: string;
  userId?: string;
  messageId?: string;
}

export interface StickerRow {
  id: string;
  contentId: string;
  scopeKey: string;
  category: string;
  tags: string[];
  mime: string;
  size: number;
  source: StickerSource;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StickerProjection {
  id: string;
  category: string;
  tags: string[];
  mime: string;
  size: number;
  source: StickerSource;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CategorySummary {
  category: string;
  count: number;
}

export interface TagSummary {
  tag: string;
  count: number;
}

export interface StickerQuery {
  category?: string;
  keyword?: string;
  tags?: readonly string[];
  matchAllTags?: boolean;
  limit?: number;
}

export interface SaveStickerInput {
  scopeKey: string;
  bytes: Uint8Array;
  mediaType: string;
  category: string;
  tags?: readonly string[];
  source: StickerSource;
}

export interface CleanupResult {
  orphanFiles: number;
  missingFiles: string[];
  deletedOrphanFiles: number;
}

export function scopeKeyFor(scope: ChannelContext, config: Pick<StickerConfig, "scope">): string {
  if (config.scope === "global") return "global";
  if (!scope.selfId) throw new AppError(STICKER_ERRORS.sticker_scope_unavailable, { effect: "none" });
  return JSON.stringify(["conversation-v2", scope.platform, scope.selfId, scope.type, scope.channelId]);
}

export function normalizeCategory(value: string): string {
  const cleaned = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 32 || (code >= 33 && code <= 126) || code >= 128) return character;
      return " ";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 64 ? cleaned.slice(0, 64).trim() : cleaned;
}

export function normalizeTags(value: readonly string[] | undefined): string[] {
  const tags = new Set<string>();
  for (const raw of value ?? []) {
    const tag = normalizeCategory(raw).slice(0, 32).trim();
    if (tag) tags.add(tag);
    if (tags.size >= 8) break;
  }
  return [...tags];
}

export function toProjection(row: StickerRow): StickerProjection {
  return {
    id: row.contentId,
    category: row.category,
    tags: row.tags ?? [],
    mime: row.mime,
    size: row.size,
    source: row.source,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/** A tool's input with its experimental `tags` field; without tag mode the field is neither accepted nor listed. */
export function tagModeInput<S extends z.ZodObject>(schema: S, config: StickerConfig): S {
  return config.tagMode ? schema : (schema.omit({ tags: true }).strict() as unknown as S);
}

export type { StickerConfig, StickerScopeMode } from "./config.js";
