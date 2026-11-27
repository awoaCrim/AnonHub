import { z } from "zod/v4";

/**
 * A role card in this project's own format (user, 2026-11-26: 「不需要适配酒馆那一套，也不要导入导出了，就即时编辑」).
 * Three parts: 角色设定 in seven boxes (「三大类没问题，最好还是按照小类再分一下」), 示例对话 and 回复前提醒 as one box
 * each. Two pictures: 参考图, which is also the card's avatar, and 三视图 (「头像就用参考图吧」「三视图单独需要一个字段」).
 */

/** 角色设定's boxes, in editor and prompt order. */
export const ROLE_SETTINGS = [
  { key: "identity", label: "身份" },
  { key: "looks", label: "外貌" },
  { key: "personality", label: "性格" },
  { key: "speech", label: "说话方式" },
  { key: "history", label: "经历" },
  { key: "relationships", label: "关系" },
  { key: "rules", label: "规矩" },
] as const;

export type RoleSettingKey = (typeof ROLE_SETTINGS)[number]["key"];

export const ROLE_CARD_PICTURES = [
  { key: "reference", label: "参考图" },
  { key: "turnaround", label: "三视图" },
] as const;

export type RoleCardPictureKey = (typeof ROLE_CARD_PICTURES)[number]["key"];

/** The picture formats a card keeps. */
export const ROLE_CARD_PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type RoleCardPictureType = (typeof ROLE_CARD_PICTURE_TYPES)[number];

export const ROLE_CARD_PICTURE_MAX_BYTES = 5 * 1024 * 1024;

export const ROLE_CARD_NAME_MAX = 200;

export const ROLE_CARD_TEXT_MAX = 100_000;

const line = z.string().max(ROLE_CARD_NAME_MAX);

const text = z.string().max(ROLE_CARD_TEXT_MAX);

/** The card's text, which the editor and the bot's own edits write. An empty string is an empty box. */
export const roleCardTextSchema = z.strictObject({
  name: line,
  /** What the character calls itself; empty means the name. */
  nickname: line,
  identity: text,
  looks: text,
  personality: text,
  speech: text,
  history: text,
  relationships: text,
  rules: text,
  examples: text,
  reminder: text,
});

export type RoleCardText = z.infer<typeof roleCardTextSchema>;

export const ROLE_CARD_TEXT_KEYS = Object.keys(roleCardTextSchema.shape) as ReadonlyArray<keyof RoleCardText>;

/** A picture's file beside `card.json`, named by its content: a new picture is a new name. */
const pictureFile = z.string().regex(/^(reference|turnaround)-[0-9a-f]{16}\.(png|jpg|webp)$/);

/** `card.json`: the text, and the file of each picture the card has. */
export const roleCardSchema = roleCardTextSchema.extend({
  pictures: z.strictObject({ reference: pictureFile.optional(), turnaround: pictureFile.optional() }),
});

export type RoleCard = z.infer<typeof roleCardSchema>;

export type RoleCardPictures = RoleCard["pictures"];

export function blankRoleCardText(name = ""): RoleCardText {
  return {
    name,
    nickname: "",
    identity: "",
    looks: "",
    personality: "",
    speech: "",
    history: "",
    relationships: "",
    rules: "",
    examples: "",
    reminder: "",
  };
}

/** The file name a picture with this content hash (16 hex digits) gets. */
export function roleCardPictureFile(key: RoleCardPictureKey, mediaType: RoleCardPictureType, hash: string): string {
  return `${key}-${hash}.${mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length)}`;
}

/** The media type of a stored picture, from its file name. */
export function roleCardPictureFileType(file: string): RoleCardPictureType {
  return file.endsWith(".jpg") ? "image/jpeg" : file.endsWith(".webp") ? "image/webp" : "image/png";
}
