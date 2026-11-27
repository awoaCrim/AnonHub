import { AppError, manualClock } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { EmojiCatalog, emojiPrompt, normalizeEmojis, normalizeEmojiText } from "../src/emojis.js";
const catalog = {
  status: "ok",
  result: {
    emoji_version: 1,
    emoji_groups: [
      { group_code: "cube", emojis: [{ code: "抱拳", name: "", img: "https://imgheybox.max-c.com/heybox/emoji/cube_191.png" }] },
      { group_code: "heygirl", emojis: [{ code: "rua!", name: "揉揉" }] },
    ],
  },
};
describe("native Xiaoheihe emojis", () => {
  it("uses group+code wire tokens, accepts punctuation and image aliases without changing ordinary prose", () => {
    const entries = normalizeEmojis(catalog);
    expect(normalizeEmojiText("[cube_抱拳][heygirl_rua!][cube_191] [普通文字]", entries)).toBe("[cube_抱拳][heygirl_rua!][cube_抱拳] [普通文字]");
    expect(() => normalizeEmojiText("[cube_不存在]", entries)).toThrow("unknown_native_emoji");
    expect(() => normalizeEmojiText("[cube_未闭合", entries)).toThrow("unknown_native_emoji");
    expect(emojiPrompt(entries)).toContain("[heygirl_rua!]（揉揉）");
    expect(emojiPrompt(Array.from({ length: 100 }, (_, i) => ({ ...entries[0]!, token: `[cube_${i}]` }))).match(/（抱拳）/g)).toHaveLength(32);
  });
  it("rejects malformed/failed or unbounded catalogs", () => {
    for (const value of [
      null,
      {},
      { status: "error", result: catalog.result },
      { status: "ok", result: { emoji_groups: [] } },
      { status: "ok", result: { emoji_groups: [{ group_code: "cube", emojis: [{ code: "bad]" }] }] } },
      { status: "ok", result: { emoji_groups: Array.from({ length: 33 }, () => catalog.result.emoji_groups[0]) } },
    ]) {
      expect(() => normalizeEmojis(value)).toThrow("invalid_emoji_catalog");
    }
  });
  it("coalesces inflight reads, caches successes, expires and backs off failures", async () => {
    const clock = manualClock(1);
    let resolve!: (value: unknown) => void;
    const load = vi.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    );
    const cache = new EmojiCatalog(load, clock);
    const first = cache.get();
    const second = cache.get();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    resolve(catalog);
    expect(await first).toHaveLength(2);
    expect(await cache.get()).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
    clock.advance(24 * 3600_000);
    load.mockRejectedValueOnce(new AppError("authentication_required"));
    expect(await cache.get()).toEqual([]);
    expect(await cache.get()).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(normalizeEmojiText("文字[cube_抱拳][普通文字]", [])).toBe("文字[普通文字]");
    expect(emojiPrompt([])).toBe("");
  });
});
