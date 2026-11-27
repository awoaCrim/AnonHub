import type { ChannelContext, ChatAccount, Part } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { BotStickerSender, stickerImagePart } from "../src/sender.js";

const scope: ChannelContext = { type: "guild", platform: "onebot", channelId: "room", guildId: "room" };
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The sent part, as the OneBot connector receives it. */
function imageFrom(sendMessage: ReturnType<typeof vi.fn>) {
  const parts = sendMessage.mock.calls[0]?.[1] as Part[] | undefined;
  const image = parts?.[0];
  if (!image) throw new Error("missing sent image");
  return image;
}

describe("BotStickerSender", () => {
  it("marks a GIF as an animated sticker", async () => {
    const sendMessage = vi.fn(async () => ["message-1"]);
    const sender = new BotStickerSender({ sendMessage } as unknown as ChatAccount, scope);

    await sender.sendWithProof({ bytes: GIF_BYTES, mediaType: "image/gif" });

    const image = imageFrom(sendMessage);
    expect(image).toEqual({
      type: "image",
      src: `data:image/gif;base64,${Buffer.from(GIF_BYTES).toString("base64")}`,
      title: "sticker.gif",
      sticker: true,
    });
  });

  it("does not mark ordinary images as animated", () => {
    expect(stickerImagePart(PNG_BYTES, "image/png")).toEqual({ type: "image", src: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}` });
  });
});
