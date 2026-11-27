import type { StickerStore } from "./store.js";
import { normalizeTags, type StickerProjection } from "./types.js";

/** Accept candidates scoring up to this many matched tags below the best, so the same tags do not always resolve to one sticker. */
const TAG_RANDOM_RANGE = 1;

/**
 * Shared tag-scoped selection used by both the preview and send tools so "the best match for these
 * tags" cannot diverge between reading and sending. Tags match fuzzily (case-insensitive substring
 * either way), and `TAG_RANDOM_RANGE` widens the accepted score window.
 */
export async function pickBestTaggedSticker(
  store: StickerStore,
  scopeKey: string,
  tags: readonly string[],
  category?: string,
): Promise<StickerProjection | null> {
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) return null;
  const rows = await store.listByScopeKey(scopeKey);
  const scoped = category ? rows.filter((sticker) => sticker.category === category) : rows;
  const matches = scoped.filter((sticker) => normalized.some((tag) => stickerMatches(sticker.tags, tag)));
  if (matches.length === 0) return null;
  const score = (sticker: StickerProjection): number => normalized.reduce((count, tag) => count + (stickerMatches(sticker.tags, tag) ? 1 : 0), 0);
  const best = Math.max(...matches.map(score));
  const threshold = Math.min(best, TAG_RANDOM_RANGE);
  const candidates = matches.filter((sticker) => score(sticker) >= best - threshold);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

function stickerMatches(tags: readonly string[], requested: string): boolean {
  return tags.some((tag) => fuzzyTagEquals(requested, tag));
}

function fuzzyTagEquals(requested: string, stored: string): boolean {
  const left = requested.toLowerCase();
  const right = stored.toLowerCase();
  return left.length > 0 && (right.includes(left) || left.includes(right));
}
