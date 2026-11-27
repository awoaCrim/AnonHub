import { createAssistantMessage, createToolMessage } from "@yesimbot/agent-runtime";
import { GifReader } from "omggif";
import { describe, expect, it, vi } from "vitest";

import { stickerFailure } from "../src/errors.js";
import type { StickerStore } from "../src/store.js";
import { pickBestTaggedSticker, stickerSendMessageBlockReason } from "../src/tools.js";
import { createDeps, pngBytes, sticker, stickerId } from "./preview-fixtures.js";

async function send(deps: ReturnType<typeof createDeps>, input = { sticker_id: stickerId }) {
  return deps.execute(deps.tool("sticker_send"), input);
}

describe("sticker agent tools", () => {
  it("creates collection and management next to the library tools; the tool policy picks per conversation", () => {
    const deps = createDeps({ tagMode: true });
    expect(deps.tools.map((t) => t.name).filter((name) => name !== "sticker_send")).toEqual(["sticker_steal", "sticker_manage", "sticker_search"]);
  });

  it("keeps discovery and delivery mechanics without preference or snapshot coaching", () => {
    const deps = createDeps({ enableManage: true });
    expect(deps.tool("sticker_search").description).toContain("分类");
    expect(deps.tool("sticker_search").description).toContain("数量");
    expect(deps.tool("sticker_search").description).not.toContain("用于选择");
    expect(deps.tool("sticker_manage").description).not.toContain("快照");
  });

  it("keeps search metadata-only", () => {
    const deps = createDeps();
    expect(deps.tool("sticker_search").description).toContain("不支持 OR/AND");
    expect(deps.tool("sticker_search").description).toContain("不代表你已经看过");
  });

  it.each([{}, { category: "meme" }])("rejects missing exact IDs %j", async (input) => {
    const deps = createDeps();
    await deps.execute(deps.tool("sticker_search"), {});
    expect(await deps.execute(deps.tool("sticker_send"), input)).toEqual(stickerFailure("sticker_id_invalid"));
    expect(deps.sender.sendWithProof).not.toHaveBeenCalled();
    expect(deps.store.random).not.toHaveBeenCalled();
  });

  it("sends exactly the viewed target and records usage", async () => {
    const deps = createDeps();
    expect(await deps.view({ category: "meme" })).toMatchObject({ ok: true, id: stickerId });
    expect(deps.store.random).toHaveBeenCalledWith("global", "meme");
    expect(deps.store.markUsed).not.toHaveBeenCalled();
    expect(await send(deps)).toMatchObject({ ok: true, id: stickerId });
    expect(deps.sender.sendWithProof).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array), mediaType: "image/gif" });
    expect(deps.store.markUsed).toHaveBeenCalledWith("global", stickerId);
    expect(deps.store.random).toHaveBeenCalledOnce();
    deps.projection.clearAll();
  });

  it("rejects inconsistent target bytes without treating another preview as permission", async () => {
    const deps = createDeps();
    await deps.view();
    expect(await send(deps, { sticker_id: "b".repeat(64) })).toMatchObject({ error: { code: "sticker_preview_stale" } });
    deps.store.readBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    expect(await send(deps)).toMatchObject({ error: { code: "sticker_preview_stale" } });
    expect(deps.sender.sendWithProof).not.toHaveBeenCalled();
    expect(await send(deps)).toMatchObject({ ok: true });
    deps.projection.clearAll();
  });

  it("blocks concurrent sends before sender is awaited", async () => {
    const deps = createDeps();
    await deps.view();
    const results = await Promise.all([send(deps), send(deps)]);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true }), stickerFailure("sticker_send_limit_reached")]));
    expect(deps.sender.sendWithProof).toHaveBeenCalledOnce();
    expect(deps.store.markUsed).toHaveBeenCalledOnce();
    deps.projection.clearAll();
  });

  it("never retries ambiguous delivery", async () => {
    const deps = createDeps();
    await deps.view();
    deps.sender.sendWithProof.mockRejectedValueOnce(new Error("transport failed"));
    expect(await send(deps)).toEqual(stickerFailure("sticker_delivery_uncertain", "unknown"));
    expect(await send(deps)).toMatchObject({ error: { code: "sticker_send_limit_reached" } });
    expect(deps.sender.sendWithProof).toHaveBeenCalledOnce();
    expect(deps.store.markUsed).not.toHaveBeenCalled();
    deps.projection.clearAll();
  });

  it("reports delivery honestly when usage accounting fails", async () => {
    const deps = createDeps();
    await deps.view();
    deps.store.markUsed.mockRejectedValueOnce(new Error("db failed"));
    expect(await send(deps)).toMatchObject({ ok: true, warning: "sticker_usage_update_failed" });
    expect(await send(deps)).toMatchObject({ error: { code: "sticker_send_limit_reached" } });
    deps.projection.clearAll();
  });

  it("allows another exact-ID send in a later turn without a new view", async () => {
    const deps = createDeps();
    await deps.view();
    await send(deps);
    deps.gate.clearTurn("turn-1");
    deps.slot.clearTurn("turn-1");

    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId }, "turn-2")).toMatchObject({ ok: true });
    deps.projection.clearAll();
  });

  it("does not send when abort arrives during byte lookup", async () => {
    const deps = createDeps();
    await deps.view();
    const controller = new AbortController();
    deps.store.readBytes.mockImplementationOnce(async () => {
      controller.abort();
      return pngBytes;
    });
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId }, "turn-1", controller.signal)).toMatchObject({
      error: { code: "request_aborted" },
    });
    expect(deps.sender.sendWithProof).not.toHaveBeenCalled();
    deps.projection.clearAll();
  });

  it("releases preflight failures but not delivery attempts", async () => {
    const deps = createDeps();
    await deps.view();
    deps.store.get.mockResolvedValueOnce(null);
    expect(await send(deps)).toMatchObject({ error: { code: "sticker_not_found" } });
    deps.store.readBytes.mockRejectedValueOnce(new Error("missing"));
    expect(await send(deps)).toMatchObject({ ok: false });
    expect(await send(deps)).toMatchObject({ ok: true });
    deps.projection.clearAll();
  });

  it("still converts static art to GIF only on delivery", async () => {
    const deps = createDeps();
    await deps.view();
    await send(deps);
    const sent = vi.mocked(deps.sender.sendWithProof).mock.calls[0]![0] as unknown as { bytes: Uint8Array; mediaType: string };
    expect(sent.mediaType).toBe("image/gif");
    expect(new GifReader(sent.bytes).numFrames()).toBe(1);
    deps.projection.clearAll();
  });

  it("requires main-model category and completed actual viewing without classifier calls", async () => {
    const deps = createDeps({ tagMode: true });
    const assetId = stickerId.slice(0, 32);
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: assetId })).toMatchObject({ error: { code: "sticker_classification_required" } });
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: assetId, category: "meme" })).toMatchObject({
      error: { code: "sticker_image_read_required" },
    });
    deps.messages.push(
      createAssistantMessage([{ type: "tool-call", toolName: "read", toolCallId: "read-call", input: { uri: `asset://${assetId}` } }]),
      createToolMessage([
        {
          type: "tool-result",
          toolName: "read",
          toolCallId: "read-call",
          output: { type: "content", value: [{ type: "image-data", data: Buffer.from(pngBytes).toString("base64"), mediaType: "image/png" }] },
        },
      ]),
    );
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: assetId, category: "meme", tags: ["搞笑"] })).toMatchObject({
      ok: true,
      status: "created",
    });
    expect(deps.store.save).toHaveBeenCalledWith(expect.objectContaining({ tags: ["meme", "搞笑"] }), expect.objectContaining({ preserveDuplicate: true }));
  });

  it("preserves manual collection and invalid/missing asset behavior", async () => {
    const deps = createDeps();
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: "bad", category: "manual" })).toMatchObject({
      error: { code: "sticker_asset_id_invalid" },
    });
    deps.assets.get.mockRejectedValueOnce(new Error("gone"));
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: "a".repeat(32), category: "manual" })).toMatchObject({
      error: { code: "sticker_asset_not_found" },
    });
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("preserves categories and search without incrementing usage", async () => {
    const deps = createDeps({ enableSteal: false });
    expect(await deps.execute(deps.tool("sticker_search"), {})).toMatchObject({ categories: [{ category: "meme", count: 1 }] });
    expect(await deps.execute(deps.tool("sticker_search"), { category: "meme" })).toMatchObject({ stickers: [{ id: stickerId }] });
    expect(deps.store.markUsed).not.toHaveBeenCalled();
  });

  it("lists categories without conditions, and tags too in tag mode; a limit alone is still a search", async () => {
    const plain = createDeps();
    expect(await plain.execute(plain.tool("sticker_search"), {})).toEqual({
      ok: true,
      categories: [{ category: "meme", count: 1 }],
      message: "已返回分类列表",
    });
    expect(plain.store.search).not.toHaveBeenCalled();
    const tagged = createDeps({ tagMode: true });
    tagged.store.listTags.mockResolvedValue([{ tag: "猫", count: 2 }]);
    expect(await tagged.execute(tagged.tool("sticker_search"), {})).toMatchObject({
      categories: [{ category: "meme", count: 1 }],
      tags: [{ tag: "猫", count: 2 }],
    });
    await tagged.execute(tagged.tool("sticker_search"), { limit: 5 });
    expect(tagged.store.search).toHaveBeenCalledTimes(1);
  });

  it("retains fuzzy tag selection and the one-step random score range for preview", async () => {
    const deps = createDeps({ tagMode: true });
    const a = sticker({ tags: ["可爱猫猫", "工作"] });
    const b = sticker({ id: "b".repeat(64), tags: ["猫"] });
    const c = sticker({ id: "c".repeat(64), tags: ["狗"] });
    deps.store.listByScopeKey.mockResolvedValue([a, b, c]);
    const store = deps.store as unknown as StickerStore;
    const random = vi.spyOn(Math, "random");
    try {
      // "可爱猫猫" fuzzily matches both requested tags (score 2); "猫" matches one (score 1) and stays within range.
      random.mockReturnValue(0);
      expect(await pickBestTaggedSticker(store, "global", ["猫", "可爱"])).toEqual(a);
      random.mockReturnValue(0.99);
      expect(await pickBestTaggedSticker(store, "global", ["猫", "可爱"])).toEqual(b);
      expect(await pickBestTaggedSticker(store, "global", ["鸟"])).toBeNull();
    } finally {
      random.mockRestore();
    }
  });

  it.each([
    '<text><sticker id="example"/></text>',
    '<text><img src="artifact://sticker/id"/></text>',
    '<inner_thought><sticker id="example"/></inner_thought>visible text',
  ])("allows literal or stripped sticker examples %s", (message) => {
    expect(stickerSendMessageBlockReason({ messages: [message] })).toBeUndefined();
  });

  it.each(['<sticker id="a"/>', '<message><sticker id="a"/></message>'])("blocks a bare sticker element %s", (message) => {
    expect(stickerSendMessageBlockReason({ messages: [message] })).toBe("sticker_send_required");
    expect(stickerSendMessageBlockReason({ messages: [message], mode: "raw" })).toBeUndefined();
  });
});
