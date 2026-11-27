import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@yesimbot/agent-runtime";
import { systemClock } from "@yesimbot/foundation";
import { partsFromElements } from "koishi-plugin-yesimbot";
import type { ChannelContext, ConversationReadOptions, MessageRecord } from "koishi-plugin-yesimbot";
import { afterEach, describe, expect, it } from "vitest";

import { PNG_BYTES } from "../../image-tools/tests/helpers.js";
import { createChannelTools } from "../src/plugin.js";
import { prepareRegionReview, REVIEW_MEMORY_LIMIT } from "../src/review.js";
import { EvidenceStore } from "../src/store/evidence.js";
import type { OpenedResource } from "../src/writer.js";
import { memoryStore } from "./support.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const room: ChannelContext = { type: "guild", platform: "test", selfId: "bot", channelId: "room", guildId: "room" };
const dm: ChannelContext = { type: "direct", platform: "test", selfId: "bot", channelId: "private:alice", userId: "alice" };

class Model {
  rows: Record<string, unknown>[] = [];
  extend() {}
  async get(_table: string, query: Record<string, unknown>) {
    return this.rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  }
  async create(_table: string, row: Record<string, unknown>) {
    this.rows.push({ ...row });
  }
  async set(table: string, query: Record<string, unknown>, patch: Record<string, unknown>) {
    for (const row of await this.get(table, query)) Object.assign(row, patch);
  }
  async remove(table: string, query: Record<string, unknown>) {
    const removed = await this.get(table, query);
    this.rows = this.rows.filter((row) => !removed.includes(row));
  }
}

function message(context: ChannelContext, id: string, user: string, text: string, timestamp = 1, extra: Partial<MessageRecord> = {}): MessageRecord {
  return {
    platform: context.platform,
    selfId: context.selfId!,
    channel: { id: context.channelId, type: context.type === "direct" ? 1 : 0 },
    user: { id: user, name: user.toUpperCase() },
    messageId: id,
    timestamp,
    parts: partsFromElements([{ type: "text", attrs: { content: text }, children: [] }] as never),
    ...extra,
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Reads behave like Core's persisted log: unknown or repeated IDs throw. */
function conversation(records: readonly MessageRecord[]) {
  const reads: ConversationReadOptions[] = [];
  const read = async (_context: ChannelContext, options: ConversationReadOptions) => {
    reads.push(options);
    if (options.messageIds) {
      for (const id of options.messageIds) {
        const count = records.filter((record) => record.messageId === id).length;
        if (count !== 1) throw new Error(`Conversation source message ID ${id} ${count ? "is duplicated" : "is missing"}`);
      }
      return records.filter((record) => options.messageIds!.includes(record.messageId));
    }
    return records.filter(
      (record) => (options.from === undefined || record.timestamp >= options.from) && (options.to === undefined || record.timestamp <= options.to),
    );
  };
  return { read, reads };
}

async function setup(
  context: ChannelContext,
  records: readonly MessageRecord[],
  extra: { owner?: boolean; assets?: Readonly<Record<string, OpenedResource>>; model?: Model } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "memorizer-remember-"));
  roots.push(root);
  const store = memoryStore(extra.model ?? new Model(), { tenantId: TENANT, isOwner: () => extra.owner === true });
  const evidence = new EvidenceStore(root);
  const log = conversation(records);
  const options = {
    clock: systemClock(),
    evidenceCount: (id: string) => evidence.count(id),
    readConversation: log.read,
    search: async () => ({ answer: "", memories: [], unresolved: [] }),
    openResource: async (uri: string) => {
      const asset = extra.assets?.[uri];
      if (!asset) throw new Error("resource_not_found");
      return asset;
    },
  };
  const tools = createChannelTools(context, store, evidence, options);
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)! as AgentTool<unknown, unknown>;
  const turn = (...users: string[]) =>
    ({ turnId: "turn", messages: users.map((id) => ({ role: "custom", type: "yesimbot.message", data: { user: { id } } })) }) as never;
  return { store, evidence, log, options, tools, tool, turn };
}

describe("remember writes directly", () => {
  it("saves at once with persisted evidence, and reuses an identical fact instead of duplicating it", async () => {
    const source = message(room, "m1", "alice", "我在杭州做后端开发");
    const { store, evidence, log, tool, turn } = await setup(room, [source]);
    const saved = (await tool("remember").execute(
      { action: "create", content: "alice 在杭州做后端开发", sources: ["m1", "m1"], type: "fact", scope: "user" },
      turn("alice"),
    )) as { id: string };
    expect(saved).toMatchObject({ saved: true, content: "alice 在杭州做后端开发", scope: "user", reusedExisting: false });
    expect(log.reads[0]).toEqual({ messageIds: ["m1"], before: 0, after: 0, limit: 1 });
    expect(await store.queryVisible(room, ["alice"])).toMatchObject([{ id: saved.id, userId: "alice", importance: 0.7, confidence: 0.85 }]);
    expect((await evidence.read(saved.id)).map((record) => record.messageId)).toEqual(["m1"]);
    const again = await tool("remember").execute(
      { action: "create", content: " alice 在杭州做后端开发 ", sources: ["m1"], type: "fact", scope: "user" },
      turn("alice"),
    );
    expect(again).toMatchObject({ id: saved.id, reusedExisting: true });
    expect(await store.queryVisible(room, ["alice"])).toHaveLength(1);
  });

  it("rejects missing, foreign, whispered or duplicated evidence and writes nothing", async () => {
    const valid = message(room, "m1", "alice", "长期偏好简洁回答");
    for (const records of [[], [{ ...valid, platform: "onebot" }], [{ ...valid, whisper: true }], [valid, valid]]) {
      const { store, tool, turn } = await setup(room, records as MessageRecord[]);
      await expect(
        tool("remember").execute({ action: "create", content: "alice 偏好简洁回答", sources: ["m1"], type: "preference" }, turn("alice")),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: expect.stringMatching(/^memory_source_/) },
      });
      expect(await store.queryVisible(room, ["alice"])).toEqual([]);
    }
  });

  it("keeps the hard rules: credentials, weak facts, private or identifying shared knowledge", async () => {
    const records = [message(room, "m1", "alice", "群规：周五不发广告"), message(room, "m2", "alice", "密码是 hunter2hunter2")];
    const { store, tool, turn } = await setup(room, records);
    const remember = (input: object) => tool("remember").execute({ action: "create", sources: ["m1"], type: "knowledge", ...input }, turn("alice"));
    await expect(remember({ content: "管理后台 password: hunter2hunter2" })).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_credential", message: expect.stringContaining("凭据"), retryable: false },
      effect: "none",
    });
    await expect(remember({ content: "周五不发广告", sources: ["m2"] })).resolves.toMatchObject({ ok: false, error: { code: "memory_source_credential" } });
    await expect(remember({ content: "周五不发广告", importance: 0.3 })).resolves.toMatchObject({ ok: false, error: { code: "memory_importance_range" } });
    await expect(remember({ content: "ALICE 定的规矩：周五不发广告", scope: "shared" })).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_shared_names_person" },
    });
    await expect(remember({ content: "周五群里不发广告", scope: "shared" })).resolves.toMatchObject({ saved: true, scope: "shared" });
    const direct = await setup(dm, [message(dm, "d1", "alice", "我对花生过敏")]);
    await expect(
      direct
        .tool("remember")
        .execute({ action: "create", content: "对花生过敏的人要避开花生", sources: ["d1"], type: "knowledge", scope: "shared" }, direct.turn("alice")),
    ).resolves.toMatchObject({ ok: false, error: { code: "memory_publish_owner_only" } });
    expect(await store.queryVisible(room, ["alice"])).toHaveLength(1);
  });

  it("publishes from the verified owner's direct chat only, and lets the owner edit public knowledge there", async () => {
    const model = new Model();
    const records = [message(dm, "d1", "alice", "公开吧：千早爱音是粉色长发"), message(dm, "d2", "alice", "改一下：粉色长发、灰色眼睛", 2)];
    const owner = await setup(dm, records, { owner: true, model });
    const saved = (await owner
      .tool("remember")
      .execute({ action: "create", content: "千早爱音是粉色长发", sources: ["d1"], type: "knowledge", scope: "shared" }, owner.turn("alice"))) as {
      id: string;
    };
    expect(saved).toMatchObject({ saved: true, scope: "shared" });
    // Public: a group on another platform sees it.
    expect(await owner.store.queryVisible({ ...room, platform: "other" }, [])).toMatchObject([{ id: saved.id, visibility: "shared" }]);
    await expect(
      owner.tool("remember").execute({ action: "update", id: saved.id, content: "千早爱音是粉色长发、灰色眼睛", sources: ["d2"] }, owner.turn("alice")),
    ).resolves.toMatchObject({ updated: true });
    // Someone else's direct chat on the same library may not edit it.
    const stranger = await setup(dm, records, { owner: false, model });
    await expect(
      stranger.tool("remember").execute({ action: "update", id: saved.id, content: "改掉", sources: ["d2"] }, stranger.turn("alice")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_edit_shared_owner_only" },
    });
  });
});

describe("attachments", () => {
  const IMAGE = "a".repeat(32);
  const OTHER = "b".repeat(32);
  const FILE = "c".repeat(32);
  const picture = (id: string): MessageRecord["elements"] => [{ type: "img", attrs: { id }, children: [] }] as never;
  const assets = {
    [`asset://${IMAGE}`]: { bytes: PNG_BYTES, mediaType: "image/png" },
    [`asset://${OTHER}`]: { bytes: new Uint8Array([...PNG_BYTES, 0]), mediaType: "image/png" },
    [`asset://${FILE}`]: { bytes: new TextEncoder().encode("api_key = sk-abcdefghijklmnop"), mediaType: "text/plain" },
  };

  it("keeps a picture from a source message and reads it back through recall's memory:// URI", async () => {
    const records = [
      message(dm, "d1", "alice", "", 1, { parts: partsFromElements(picture(IMAGE)) }),
      message(dm, "d2", "alice", "这是你的立绘，记住", 2, { quote: { messageId: "d1", parts: partsFromElements(picture(IMAGE)) } }),
      message(dm, "d3", "alice", "", 3, { parts: partsFromElements([{ type: "file", attrs: { id: FILE, title: "keys.txt" }, children: [] }] as never) }),
    ];
    const { evidence, tool, turn } = await setup(dm, records, { owner: true, assets });
    const remember = (input: object) => tool("remember").execute({ action: "create", content: "千早爱音的立绘", type: "fact", ...input }, turn("alice"));
    const saved = (await remember({ sources: ["d2"], attachments: [`asset://${IMAGE}`, `asset://${IMAGE}`] })) as { id: string; attachments: string[] };
    expect(saved.attachments).toEqual([`memory://${saved.id}/1`]);
    expect(await evidence.openAttachment(saved.id, 1, 1 << 20)).toEqual({ bytes: new Uint8Array(PNG_BYTES), mediaType: "image/png" });
    const recalled = (await tool("recall").execute({}, turn("alice"))) as { memories: { attachments?: unknown }[] };
    expect(recalled.memories[0]!.attachments).toEqual([{ uri: `memory://${saved.id}/1`, mediaType: "image/png" }]);

    await expect(remember({ content: "另一张", sources: ["d1"], attachments: [`asset://${OTHER}`] })).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_attachment_not_in_sources" },
    });
    await expect(remember({ content: "钥匙文件", sources: ["d3"], attachments: [`asset://${FILE}`] })).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_attachment_credential" },
    });
    await expect(remember({ content: "外链", sources: ["d1"], attachments: ["https://example.com/a.png"] })).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_attachment_not_in_sources" },
    });
  });

  it("replaces or drops a memory's attachments without reusing an index, and deletes or merges them with the memory", async () => {
    const records = [
      message(room, "m1", "alice", "", 1, { parts: partsFromElements(picture(IMAGE)) }),
      message(room, "m2", "alice", "", 2, { parts: partsFromElements(picture(OTHER)) }),
    ];
    const { evidence, tool, turn } = await setup(room, records, { assets });
    const saved = (await tool("remember").execute(
      { action: "create", content: "alice 的猫叫团子", sources: ["m1"], type: "fact", scope: "user", attachments: [`asset://${IMAGE}`] },
      turn("alice"),
    )) as { id: string };
    await expect(tool("remember").execute({ action: "update", id: saved.id, attachments: [`asset://${OTHER}`] }, turn("alice"))).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_attachment_source_required" },
    });
    await expect(
      tool("remember").execute({ action: "update", id: saved.id, sources: ["m2"], attachments: [`asset://${OTHER}`] }, turn("alice")),
    ).resolves.toMatchObject({
      attachments: [`memory://${saved.id}/2`],
    });
    expect(await evidence.openAttachment(saved.id, 1, 1 << 20)).toBeUndefined();
    await expect(tool("remember").execute({ action: "update", id: saved.id, attachments: [] }, turn("alice"))).resolves.toMatchObject({ attachments: [] });
    expect(await evidence.attachments(saved.id)).toEqual([]);

    await evidence.attach("keep", [{ bytes: PNG_BYTES, mediaType: "image/png", messageId: "m1" }]);
    await evidence.attach("gone", [
      { bytes: PNG_BYTES, mediaType: "image/png", messageId: "m1" },
      { bytes: new Uint8Array([1, 2]), mediaType: "application/octet-stream", name: "a.bin", messageId: "m2" },
    ]);
    await evidence.merge("keep", ["gone"]);
    expect((await evidence.attachments("keep")).map((item) => [item.index, item.name])).toEqual([
      [1, undefined],
      [2, "a.bin"],
    ]);
    expect(await evidence.attachments("gone")).toEqual([]);
    await evidence.remove("keep");
    expect(await evidence.attachments("keep")).toEqual([]);
  });
});

describe("remember update", () => {
  it("changes a visible memory by its short ID only with evidence, and forgets it", async () => {
    const records = [message(room, "m1", "alice", "婚礼定在 11 月 30 日"), message(room, "m2", "alice", "婚礼改到 12 月 20 日了", 2)];
    const { store, evidence, tool, turn } = await setup(room, records);
    const saved = (await tool("remember").execute(
      { action: "create", content: "2026-11-01 alice 把婚礼定在 11 月 30 日", sources: ["m1"], type: "event", scope: "user" },
      turn("alice"),
    )) as { id: string };
    const short = saved.id.slice(0, 8);
    await expect(tool("remember").execute({ action: "update", id: short, content: "alice 的婚礼改到 12 月 20 日" }, turn("alice"))).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_content_sources_required" },
    });
    await expect(tool("remember").execute({ action: "update", id: saved.id.slice(0, 4), forget: true }, turn("alice"))).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_id_too_short" },
    });
    // A user fact is visible only while its person takes part.
    await expect(tool("remember").execute({ action: "update", id: short, forget: true }, turn("bob"))).resolves.toMatchObject({
      ok: false,
      error: { code: "memory_not_visible" },
    });
    await expect(
      tool("remember").execute({ action: "update", id: short, content: "2026-11-20 alice 把婚礼改到 12 月 20 日", sources: ["m2"] }, turn("alice")),
    ).resolves.toMatchObject({ updated: true, id: saved.id, content: "2026-11-20 alice 把婚礼改到 12 月 20 日" });
    expect((await evidence.read(saved.id)).map((record) => record.messageId).sort()).toEqual(["m1", "m2"]);
    await expect(tool("remember").execute({ action: "update", id: short, forget: true }, turn("alice"))).resolves.toEqual({ forgotten: true, id: saved.id });
    expect(await store.queryVisible(room, ["alice"])).toEqual([]);
  });
});

describe("pre-summary review", () => {
  it("lists the range's people's memories with short IDs under a cap and fixes participants for its tools", async () => {
    const records = [
      message(room, "m1", "alice", "我养了一只叫团子的猫", 10),
      message(room, "m2", "bot", "好可爱", 11),
      message(room, "m3", "carol", "我在学日语", 12),
    ];
    const { store, evidence, options, tool, turn } = await setup(room, records);
    const kept = (await tool("remember").execute(
      { action: "create", content: "alice 养了一只叫团子的猫", sources: ["m1"], type: "fact", scope: "user" },
      turn("alice"),
    )) as {
      id: string;
    };
    await evidence.attach(kept.id, [{ bytes: PNG_BYTES, mediaType: "image/png", messageId: "m1" }]);
    for (let index = 0; index < REVIEW_MEMORY_LIMIT + 5; index += 1)
      await store.create({ type: "knowledge", content: `群规 ${index}`, scope: "channel", context: room, importance: 0.6, confidence: 0.9, tags: [] });
    const controller = new AbortController();
    const review = await prepareRegionReview(
      { ...options, context: room, store, evidence },
      { messageIds: ["m1", "m2", "m3"], sourceStartAt: 10, sourceEndAt: 12, signal: controller.signal },
    );
    expect(review!.tools.map((entry) => entry.name)).toEqual(["remember", "recall"]);
    expect(review!.instructions).toContain("3 条消息");
    expect(review!.instructions).toContain("1970-01-01 周四 08:00（UTC+8） 到 1970-01-01 周四 08:00（UTC+8）");
    expect(review!.instructions).toContain(`[${kept.id.slice(0, 8)}] (fact) alice 养了一只叫团子的猫（带 1 个附件）`);
    expect(review!.instructions).toContain("attachments");
    expect(review!.instructions).not.toContain(kept.id);
    expect(review!.instructions).toMatch(/另有 \d+ 条没列出/);
    expect(review!.instructions.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(REVIEW_MEMORY_LIMIT);
    // carol speaks only in the range: the review's tools see her even without an Agent turn.
    const remember = review!.tools.find((entry) => entry.name === "remember")!;
    await expect(
      remember.execute({ action: "create", content: "carol 在学日语", sources: ["m3"], type: "fact", scope: "user" }, controller.signal),
    ).resolves.toMatchObject({
      saved: true,
    });
    const recall = review!.tools.find((entry) => entry.name === "recall")!;
    expect(JSON.stringify(await recall.execute({ query: "carol" }, controller.signal))).toContain("carol 在学日语");
  });
});
