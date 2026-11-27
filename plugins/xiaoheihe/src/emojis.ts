import { AppError, systemClock, type Clock } from "@yesimbot/foundation";

/** Protocol-only catalog normalization; no image downloads or model tools. */
const GROUP = /^[a-z][a-z0-9]{0,31}$/;

const CODE = /^[^\s[\]<>]{1,48}$/;

const KNOWN_NAMESPACE = /^(?:cube|heygirl|grandemoji|bigemoji)\d*_/;

const COMMON_CODES = [
  "抱拳",
  "滑稽",
  "doge",
  "哭泣",
  "捂脸哭",
  "并不简单",
  "惊讶",
  "笑cry",
  "沧桑",
  "感动",
  "喜欢",
  "困",
  "委屈",
  "生气",
  "吃瓜",
  "摸摸头",
  "微笑",
  "比心",
  "哈哈",
  "无语",
  "rua!",
];

export interface NativeEmoji {
  token: string;
  name: string;
  aliases: readonly string[];
}

/** Per-account, bounded cache. Failure backoff and coalescing never affect account health. */
export class EmojiCatalog {
  private entries: readonly NativeEmoji[] = [];
  private expires = 0;
  private pending?: Promise<readonly NativeEmoji[]>;
  constructor(
    private readonly load: () => Promise<unknown>,
    private readonly clock: Clock = systemClock(),
  ) {}
  get(): Promise<readonly NativeEmoji[]> {
    if (this.pending) return this.pending;
    if (this.clock.now() < this.expires) return Promise.resolve(this.entries);
    this.pending = Promise.resolve()
      .then(() => this.load())
      .then((value) => {
        this.entries = normalizeEmojis(value);
        this.expires = this.clock.now() + 24 * 3600_000;
        return this.entries;
      })
      .catch(() => {
        this.entries = [];
        this.expires = this.clock.now() + 5 * 60_000;
        return this.entries;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

export function normalizeEmojis(value: unknown): readonly NativeEmoji[] {
  const data = object(value);
  if (data.status !== "ok") throw new AppError("invalid_emoji_catalog", { effect: "none" });
  const groups = object(data.result).emoji_groups;
  if (!Array.isArray(groups) || groups.length > 32) throw new AppError("invalid_emoji_catalog", { effect: "none" });
  const result: NativeEmoji[] = [];
  const seen = new Set<string>();
  for (const raw of groups) {
    const group = object(raw);
    if (typeof group.group_code !== "string" || !GROUP.test(group.group_code) || !Array.isArray(group.emojis) || group.emojis.length > 512)
      throw new AppError("invalid_emoji_catalog", { effect: "none" });
    for (const rawEmoji of group.emojis) {
      const emoji = object(rawEmoji);
      if (typeof emoji.code !== "string" || !safeCode(emoji.code)) throw new AppError("invalid_emoji_catalog", { effect: "none" });
      const token = `[${group.group_code}_${emoji.code}]`;
      if (seen.has(token)) continue;
      seen.add(token);
      const aliases: string[] = [];
      if (typeof emoji.img === "string") {
        const imageKey = /^https:\/\/imgheybox\.max-c\.com\/heybox\/emoji\/([a-z][a-z0-9]*_[a-zA-Z0-9]+)\.(?:png|gif|webp)(?:\?.*)?$/.exec(emoji.img)?.[1];
        if (imageKey?.startsWith(`${group.group_code}_`)) aliases.push(`[${imageKey}]`);
      }
      const name = typeof emoji.name === "string" && safeCode(emoji.name) ? emoji.name : emoji.code;
      result.push(Object.freeze({ token, name, aliases: Object.freeze(aliases) }));
      if (result.length > 1024) throw new AppError("invalid_emoji_catalog", { effect: "none" });
    }
  }
  if (!result.length) throw new AppError("invalid_emoji_catalog", { effect: "none" });
  return Object.freeze(result);
}

export function emojiPrompt(entries: readonly NativeEmoji[]): string {
  if (!entries.length) return "";
  const preferred = COMMON_CODES.flatMap((code) => entries.filter((emoji) => emoji.token === `[cube_${code}]`));
  const chosen = [...new Set([...preferred, ...entries])].slice(0, 32);
  return `可选的小黑盒原生表情（自然需要时少量使用，不必每条都加；只复制这里的完整代码，不猜代码）：${chosen.map((emoji) => `${emoji.token}（${emoji.name}）`).join("、")}`;
}

/** Only known native namespaces are interpreted; ordinary bracketed prose remains literal. */
export function normalizeEmojiText(text: string, entries: readonly NativeEmoji[]): string {
  const tokens = new Map<string, string>();
  for (const emoji of entries) {
    tokens.set(emoji.token, emoji.token);
  }
  for (const emoji of entries) {
    for (const alias of emoji.aliases) if (!tokens.has(alias)) tokens.set(alias, emoji.token);
  }
  const native = (code: string) => KNOWN_NAMESPACE.test(code) || entries.some((emoji) => code.startsWith(emoji.token.slice(1, emoji.token.indexOf("_") + 1)));
  if (entries.length) {
    for (const segment of text.split("[").slice(1)) {
      const closing = segment.indexOf("]");
      if (native(segment) && (closing < 0 || !tokens.has(`[${segment.slice(0, closing)}]`))) throw new AppError("unknown_native_emoji", { effect: "none" });
    }
  }
  return text.replace(/\[([^[\]\r\n]{1,160})\]/g, (literal, code: string) => {
    if (tokens.has(literal)) return tokens.get(literal)!;
    if (!native(code)) return literal;
    // Catalog failure/disabled: omit native codes, preserving surrounding plain text.
    if (!entries.length) return "";
    throw new AppError("unknown_native_emoji", { effect: "none" });
  });
}

function safeCode(value: string): boolean {
  return CODE.test(value) && [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_emoji_catalog", { effect: "none" });
  return value as Record<string, unknown>;
}
