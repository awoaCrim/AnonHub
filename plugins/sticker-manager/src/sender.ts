import { replyPlatformIds, type ChannelContext } from "koishi-plugin-yesimbot/kernel";
import type { ChatAccount, Part } from "koishi-plugin-yesimbot/kernel";

const ANIMATED_STICKER_FILENAME = "sticker.gif";

export interface StickerSendInput {
  bytes: Uint8Array;
  mediaType: string;
}

export interface StickerSender {
  /** Returns the real platform IDs; an empty result stays unknown. */
  sendWithProof(input: StickerSendInput): Promise<readonly string[]>;
}

export class BotStickerSender implements StickerSender {
  public constructor(
    private readonly bot: ChatAccount,
    private readonly scope: ChannelContext,
  ) {}

  /** Same transport, bounded actual IDs. An empty/invalid result stays unknown, never invented. */
  public async sendWithProof(input: StickerSendInput): Promise<readonly string[]> {
    const ids = await this.bot.sendMessage(this.scope.channelId, [stickerImagePart(input.bytes, input.mediaType)]);
    return replyPlatformIds(ids) ?? [];
  }
}

/** An animated sticker is marked as one; each platform sends it its own way. */
export function stickerImagePart(bytes: Uint8Array, mediaType: string): Part {
  const src = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  if (mediaType.toLowerCase().split(";", 1)[0] !== "image/gif") return { type: "image", src };
  return { type: "image", src, title: ANIMATED_STICKER_FILENAME, sticker: true };
}
