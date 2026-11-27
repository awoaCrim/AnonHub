import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROLE_CARD_PICTURE_MAX_BYTES,
  ROLE_CARD_PICTURE_TYPES,
  ROLE_CARD_PICTURES,
  roleCardPictureFile,
  roleCardPictureFileType,
  roleCardSchema,
  type RoleCard,
  type RoleCardPictureKey,
  type RoleCardPictureType,
  type RoleCardText,
} from "@yesimbot/contracts/role-cards";
import { AppError, contentHash, createDirectory, defineErrors, detectImageType, resolveInside, writeFileAtomic } from "@yesimbot/foundation";

/**
 * Role card files (the format is `@yesimbot/contracts/role-cards`): `<ROLE_CARDS_DIR>/<id>/card.json`, each picture
 * beside it under a name made from its content. The console and the bot's own edits both write through here; card.json
 * is written only while it still holds what the writer read.
 */
export const ROLE_CARDS_DIR = "data/yesimbot/characters";

export const ROLE_CARD_FILE = "card.json";

export const ROLE_CARD_FILE_ERRORS = defineErrors({
  role_card_invalid: { model: "角色卡文件格式不对，读不了。", user: "角色卡文件格式不对，读不了。", status: 400 },
});

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Cards that ship with the system, each laid out like a stored card (user, 2026-11-27: 「将当前的anon角色卡作为系统内置的
 * 可选角色卡之一」). A library takes one as its own copy, edited there like any other card. The build copies them next to
 * the bundle, so the same path holds in `src/` and `dist/`.
 */
const PRESETS_DIR = fileURLToPath(new URL("./presets/", import.meta.url));

export interface RoleCardPicture {
  readonly bytes: Uint8Array;
  readonly mediaType: RoleCardPictureType;
}

/** A card as read: where it lives, card.json's bytes (what a write must still find there) and its content. */
export interface StoredRoleCard {
  readonly id: string;
  readonly dir: string;
  readonly bytes: Buffer;
  readonly card: RoleCard;
}

export interface RoleCardPreset {
  readonly id: string;
  readonly name: string;
}

/** What an edit changes: card.json's new content, the picture files it adds and the ones it stops using. */
export interface RoleCardEdit {
  readonly card: RoleCard;
  readonly added: ReadonlyArray<{ readonly file: string; readonly bytes: Uint8Array }>;
  readonly removed: readonly string[];
}

export function isRoleCardId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

/** PNG, JPEG or WebP within the size a card keeps. */
export function roleCardPictureType(bytes: Uint8Array): RoleCardPictureType | undefined {
  const type = detectImageType(bytes);
  return type && bytes.byteLength <= ROLE_CARD_PICTURE_MAX_BYTES && (ROLE_CARD_PICTURE_TYPES as readonly string[]).includes(type)
    ? (type as RoleCardPictureType)
    : undefined;
}

export function encodeRoleCard(card: RoleCard): string {
  return `${JSON.stringify(card, null, 2)}\n`;
}

/** card.json's content; `role_card_invalid` when it is not a card in the current format. */
export function decodeRoleCard(bytes: Uint8Array): RoleCard {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (cause) {
    throw new AppError(ROLE_CARD_FILE_ERRORS.role_card_invalid, { effect: "none", cause });
  }
  const parsed = roleCardSchema.safeParse(value);
  if (!parsed.success) throw new AppError(ROLE_CARD_FILE_ERRORS.role_card_invalid, { effect: "none", cause: parsed.error });
  return parsed.data;
}

/**
 * `current` with the given text and pictures (a picture, `null` to remove it, absent to keep it). A picture with the
 * same content as the one in place is no change.
 */
export function editRoleCard(
  current: RoleCard,
  text: Partial<RoleCardText>,
  pictures: Partial<Record<RoleCardPictureKey, RoleCardPicture | null>> = {},
): RoleCardEdit {
  const card: RoleCard = { ...current, ...text, pictures: { ...current.pictures } };
  const added: Array<{ file: string; bytes: Uint8Array }> = [];
  const removed: string[] = [];
  for (const [key, picture] of Object.entries(pictures) as Array<[RoleCardPictureKey, RoleCardPicture | null | undefined]>) {
    if (picture === undefined) continue;
    const before = current.pictures[key];
    const file = picture ? roleCardPictureFile(key, picture.mediaType, contentHash(picture.bytes, { hexLength: 16 })) : undefined;
    if (file === before) continue;
    if (file) {
      card.pictures[key] = file;
      added.push({ file, bytes: picture!.bytes });
    } else delete card.pictures[key];
    if (before) removed.push(before);
  }
  return { card, added, removed };
}

/** Card `id` under `baseDir`; never through a symlink. */
export async function readRoleCard(baseDir: string, id: string): Promise<StoredRoleCard> {
  if (!isRoleCardId(id)) throw new AppError(ROLE_CARD_FILE_ERRORS.role_card_invalid, { effect: "none", detail: "id" });
  const file = await resolveInside(baseDir, `${ROLE_CARDS_DIR}/${id}/${ROLE_CARD_FILE}`, { links: "reject" });
  const bytes = await readFile(file);
  return { id, dir: dirname(file), bytes, card: decodeRoleCard(bytes) };
}

/** A picture of a card that was read, or undefined when the card has none. */
export async function readRoleCardPicture(stored: Pick<StoredRoleCard, "dir" | "card">, key: RoleCardPictureKey): Promise<RoleCardPicture | undefined> {
  const file = stored.card.pictures[key];
  if (!file) return undefined;
  const bytes = await readFile(await resolveInside(stored.dir, file, { links: "reject" }));
  const mediaType = roleCardPictureType(bytes);
  if (mediaType !== roleCardPictureFileType(file)) throw new AppError(ROLE_CARD_FILE_ERRORS.role_card_invalid, { effect: "none", detail: file });
  return { bytes, mediaType };
}

/**
 * Writes an edit: the new pictures, then card.json if it still holds `stored.bytes` (`file_changed` otherwise), then the
 * pictures it stopped using go. Returns card.json's new bytes.
 */
export async function writeRoleCardEdit(stored: Pick<StoredRoleCard, "dir" | "bytes">, edit: RoleCardEdit): Promise<Buffer> {
  for (const { file, bytes } of edit.added) await writeFileAtomic(join(stored.dir, file), bytes);
  const after = Buffer.from(encodeRoleCard(edit.card));
  await writeFileAtomic(join(stored.dir, ROLE_CARD_FILE), after, { expect: stored.bytes });
  for (const file of edit.removed) await unlink(join(stored.dir, file)).catch(() => undefined);
  return after;
}

/** A new card `id` under `baseDir` with the picture files its card names; fails when that directory already has content. */
export async function createRoleCard(baseDir: string, id: string, card: RoleCard, files: RoleCardEdit["added"] = []): Promise<void> {
  if (!isRoleCardId(id)) throw new AppError(ROLE_CARD_FILE_ERRORS.role_card_invalid, { effect: "none", detail: "id" });
  const dir = await resolveInside(baseDir, `${ROLE_CARDS_DIR}/${id}`, { links: "reject", allowMissing: true });
  await mkdir(dirname(dir), { recursive: true });
  await createDirectory(dir, async (staging) => {
    for (const { file, bytes } of files) await writeFileAtomic(join(staging, file), bytes);
    await writeFileAtomic(join(staging, ROLE_CARD_FILE), encodeRoleCard(card));
  });
}

/** The cards that ship with the system, by id; one that cannot be read is left out. */
export async function listRoleCardPresets(): Promise<RoleCardPreset[]> {
  const presets: RoleCardPreset[] = [];
  for (const entry of (await readdir(PRESETS_DIR, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !isRoleCardId(entry.name)) continue;
    try {
      presets.push({ id: entry.name, name: decodeRoleCard(await readFile(join(PRESETS_DIR, entry.name, ROLE_CARD_FILE))).name });
    } catch {
      continue;
    }
  }
  return presets;
}

/** Preset `id` as `createRoleCard` takes it: the card and its picture files. */
export async function readRoleCardPreset(id: string): Promise<{ card: RoleCard; files: RoleCardEdit["added"] }> {
  if (!isRoleCardId(id)) throw new AppError(ROLE_CARD_FILE_ERRORS.role_card_invalid, { effect: "none", detail: "id" });
  const dir = join(PRESETS_DIR, id);
  const stored = { dir, card: decodeRoleCard(await readFile(join(dir, ROLE_CARD_FILE))) };
  const files: Array<{ file: string; bytes: Uint8Array }> = [];
  for (const { key } of ROLE_CARD_PICTURES) {
    const picture = await readRoleCardPicture(stored, key);
    if (picture) files.push({ file: stored.card.pictures[key]!, bytes: picture.bytes });
  }
  return { card: stored.card, files };
}

/** Deletes card `id` with its pictures. */
export async function deleteRoleCard(baseDir: string, id: string): Promise<void> {
  if (!isRoleCardId(id)) throw new AppError(ROLE_CARD_FILE_ERRORS.role_card_invalid, { effect: "none", detail: "id" });
  await rm(await resolveInside(baseDir, `${ROLE_CARDS_DIR}/${id}`, { links: "reject" }), { recursive: true, force: true });
}
