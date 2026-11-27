import type { AgentTool } from "@yesimbot/agent-runtime";
import { systemClock } from "@yesimbot/foundation";
import { partsFromElements } from "koishi-plugin-yesimbot";
import type { ChannelContext } from "koishi-plugin-yesimbot";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMaintenance } from "../src/maintainer.js";
import { runSearch } from "../src/searcher.js";
import type { MemoryCreateInput, MemoryUpdateInput } from "../src/types.js";
import { memoryStore } from "./support.js";

const harness = vi.hoisted(() => ({ run: async (_tools: AgentTool[]) => {} }));
vi.mock("@yesimbot/agent-runtime", () => ({
  jsonSchema: (schema: unknown) => schema,
  createUserMessage: (text: string) => text,
  createAgent: ({ tools }: { tools: AgentTool[] }) => ({
    init: async () => {},
    wait: async () => {},
    stop: async () => {},
    async *run() {
      await harness.run(tools);
      yield {};
    },
  }),
}));

class Model {
  rows: Record<string, unknown>[] = [];
  extend() {}
  async get(_table: string, query: Record<string, unknown>) {
    return this.rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  }
  async create(_table: string, row: Record<string, unknown>) {
    this.rows.push({ ...row });
  }
  async set(_table: string, query: Record<string, unknown>, patch: Record<string, unknown>) {
    if ("id" in patch) throw new TypeError("cannot modify primary key");
    for (const row of await this.get(_table, query)) Object.assign(row, patch);
  }
  async remove(_table: string, query: Record<string, unknown>) {
    const removed = await this.get(_table, query);
    this.rows = this.rows.filter((row) => !removed.includes(row));
  }
}
const channel = (platform: string): ChannelContext => ({ type: "guild", selfId: "bot", platform, channelId: "same", guildId: "same" });
const base = { type: "fact", content: "same coffee", importance: 0.8, confidence: 1, tags: [] } as const;

const shared = (platform: string): MemoryCreateInput => ({ ...base, tags: [], scope: "shared", platform });
function setup() {
  const model = new Model();
  const store = memoryStore(model, {
    indexer: { modelId: "toy", embed: async () => [1, 0], queryPrefix: "" },
  });
  /** The same table seen by another tenant: nothing it writes is visible to `store`. */
  const foreign = memoryStore(model, { tenantId: "44444444-4444-4444-8444-444444444444" });
  return { model, store, foreign };
}

function execute(tools: AgentTool[], name: string, input: unknown) {
  return tools.find((tool) => tool.name === name)!.execute(input, {} as never);
}
const evidence = () => ({
  read: vi.fn(async () => []),
  count: vi.fn(async () => 0),
  attachments: vi.fn(async () => []),
  append: vi.fn(async () => {}),
  merge: vi.fn(async () => {}),
});

beforeEach(() => {
  harness.run = async () => {};
});

describe("memory platform isolation", () => {
  it("writes update/merge/forget/restore without primary keys while preserving returned IDs", async () => {
    const { store } = setup();
    await store.create(shared("onebot"), "keep");
    await store.create({ ...shared("onebot"), content: "other coffee" }, "drop");
    await expect(store.update("keep", { content: "updated" })).resolves.toMatchObject({ id: "keep", content: "updated" });
    await expect(store.merge("keep", "drop", { content: "merged" })).resolves.toMatchObject({ id: "keep", content: "merged" });
    expect(await store.get("drop")).toBeUndefined();
    await expect(store.forget("keep", "test", 100)).resolves.toMatchObject({ id: "keep", status: "forgotten", forgottenAt: 100 });
    await expect(store.restore("keep", 200)).resolves.toMatchObject({ id: "keep", status: "active", forgottenAt: undefined });
    expect(await store.get("keep")).toMatchObject({ id: "keep", content: "merged", status: "active" });
  });

  it.each([false, true])("filters every scope before ranking and limit (semantic=%s)", async (semantic) => {
    const { store } = setup();
    for (const platform of ["onebot", "xiaoheihe"]) {
      const content = `${platform} coffee`;
      await store.create({ ...shared(platform), content }, `${platform}-shared`);
      await store.create({ ...base, content, tags: [], scope: "user", context: channel(platform), platform, userId: "same" }, `${platform}-user`);
      await store.create({ ...base, content, tags: [], scope: "channel", context: channel(platform) }, `${platform}-channel`);
    }
    for (const platform of ["onebot", "xiaoheihe"]) {
      const query = { query: semantic ? "unmatched" : "coffee", semantic };
      const all = await store.queryVisible(channel(platform), ["same"], query);
      // Shared memory belongs to the library and crosses platforms; user and channel memory stay on their own platform.
      expect(all.map((memory) => memory.id).sort()).toEqual([`${platform}-channel`, `${platform}-user`, "onebot-shared", "xiaoheihe-shared"].sort());
      expect(await store.queryVisible(channel(platform), ["same"], { ...query, scopes: ["shared"], limit: 1 })).toHaveLength(1);
      expect(await store.queryVisible(channel(""), ["same"], query)).toEqual([]);
    }
  });

  it("shares only explicitly shared memory across channels", async () => {
    const { store } = setup();
    await store.create(shared("onebot"), "shared");
    await store.create({ ...base, tags: [], scope: "user", context: channel("onebot"), platform: "onebot", userId: "same" }, "user");
    await store.create({ ...base, tags: [], scope: "channel", context: channel("onebot") }, "channel");
    const other = { ...channel("onebot"), channelId: "other", guildId: "other" } as ChannelContext;
    expect((await store.queryVisible(other, ["same"])).map((row) => row.id).sort()).toEqual(["shared"]);
    expect((await store.queryVisible(other, [])).map((row) => row.id)).toEqual(["shared"]);
    expect((await store.queryVisible({ ...other, platform: "xiaoheihe" }, ["same"])).map((row) => row.id)).toEqual(["shared"]);
  });

  it("requires a platform for new shared memories and rejects user/channel targets", async () => {
    const { store, model } = setup();
    await expect(store.create({ ...shared("onebot"), platform: undefined })).rejects.toThrow("memory_platform_required");
    await expect(store.create(shared("  "))).rejects.toThrow("memory_platform_required");
    await expect(store.create({ ...shared("onebot"), userId: "same" })).rejects.toThrow("memory_scope_targets_invalid");
    await expect(store.create({ ...shared("onebot"), context: channel("onebot") })).rejects.toThrow("memory_scope_targets_invalid");
    expect(model.rows).toEqual([]);
  });

  it("rejects ownership edits including raw fields and context overrides without mutation", async () => {
    const { store, model } = setup();
    await store.create({ ...base, tags: [], scope: "channel", context: channel("onebot") }, "qq");
    const original = structuredClone(model.rows);
    for (const patch of [
      { platform: "xiaoheihe" },
      { scope: "shared" },
      { context: channel("xiaoheihe") },
      { channelId: "other" },
      { channelType: "direct" },
      { guildId: "other" },
      { selfId: "other" },
      { userId: "other" },
    ]) {
      await expect(store.update("qq", patch as MemoryUpdateInput)).rejects.toThrow("memory_ownership_immutable");
      expect(model.rows).toEqual(original);
    }
    await expect(store.update("qq", { content: "updated", tags: ["tag"], confidence: 0.9, context: channel("onebot") })).resolves.toMatchObject({
      platform: "onebot",
      content: "updated",
    });
    await store.forget("qq", "test");
    await expect(store.restore("qq")).resolves.toMatchObject({ status: "active", platform: "onebot" });
  });

  it("validates merge ownership and patch before touching evidence or rows", async () => {
    const { store, model } = setup();
    await store.create(shared("onebot"), "qq");
    await store.create({ ...shared("onebot"), content: "second coffee" }, "qq2");
    await store.create({ ...base, content: "room coffee", tags: [], scope: "channel", context: channel("onebot") }, "room");
    const before = structuredClone(model.rows);
    const mergeEvidence = vi.fn(async () => {});
    await expect(store.merge("qq", "room", {}, mergeEvidence)).rejects.toThrow("memory_merge_scope_mismatch");
    await expect(store.merge("qq", "qq2", { platform: "xiaoheihe" }, mergeEvidence)).rejects.toThrow("memory_ownership_immutable");
    await expect(store.merge("qq", "qq", {}, mergeEvidence)).rejects.toThrow("memory_merge_scope_mismatch");
    expect(mergeEvidence).not.toHaveBeenCalled();
    expect(model.rows).toEqual(before);
    await expect(store.merge("qq", "qq2", { content: "combined" }, mergeEvidence)).resolves.toMatchObject({ content: "combined", platform: "onebot" });
    expect(mergeEvidence).toHaveBeenCalledOnce();
    expect(await store.get("qq2")).toBeUndefined();
  });

  it("authorizes search evidence and reports only from the caller's tenant", async () => {
    const { store, foreign } = setup();
    await store.create(shared("onebot"), "qq");
    await foreign.create(shared("xiaoheihe"), "xhk");
    const files = evidence();
    harness.run = async (tools) => {
      expect(await execute(tools, "query_memories", { scopes: ["shared"], query: "unmatched", semantic: true })).toMatchObject([{ id: "qq" }]);
      await expect(execute(tools, "read_evidence", { id: "xhk" })).resolves.toMatchObject({ ok: false, error: { code: "memory_not_authorized" } });
      await expect(execute(tools, "submit_report", { answer: "bad", memoryIds: ["xhk"], unresolved: [] })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_report_unauthorized" },
      });
      await execute(tools, "read_evidence", { id: "qq" });
      await execute(tools, "submit_report", { answer: "ok", memoryIds: ["qq"], unresolved: [] });
    };
    const result = await runSearch({
      clock: systemClock(),
      model: {} as never,
      context: channel("onebot"),
      execution: { messages: [] } as never,
      store,
      evidence: files as never,
      query: "coffee",
    });
    expect(result.memories.map((row) => row.id)).toEqual(["qq"]);
    expect(files.read.mock.calls).toEqual([["qq"]]);
  });

  it("creates shared memories with trusted platform and guards maintenance evidence and merge patches", async () => {
    const { store, foreign } = setup();
    await store.create(shared("onebot"), "qq");
    await store.create({ ...shared("onebot"), content: "second coffee" }, "qq2");
    await foreign.create(shared("xiaoheihe"), "xhk");
    const files = evidence();
    harness.run = async (tools) => {
      await execute(tools, "query_memories", {});
      await expect(execute(tools, "read_evidence", { id: "xhk" })).resolves.toMatchObject({ ok: false, error: { code: "memory_not_authorized" } });
      await expect(execute(tools, "merge_memories", { canonicalId: "qq", mergedId: "xhk" })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_not_authorized" },
      });
      await expect(execute(tools, "merge_memories", { canonicalId: "qq", mergedId: "qq2", platform: "xiaoheihe" })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_ownership_immutable" },
      });
      expect(files.merge).not.toHaveBeenCalled();
      await expect(execute(tools, "update_memory", { id: "qq", platform: "xiaoheihe" })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_ownership_immutable" },
      });
      await execute(tools, "merge_memories", { canonicalId: "qq", mergedId: "qq2", content: "normal merge", sourceMessageIds: ["source"] });
      await execute(tools, "create_memory", { ...shared("onebot"), content: "created coffee", sourceMessageIds: ["source"] });
    };
    await runMaintenance({
      model: {} as never,
      context: channel("onebot"),
      messages: [
        {
          messageId: "source",
          platform: "onebot",
          selfId: "bot",
          channel: { id: "same", type: 0 },
          user: { id: "alice" },
          timestamp: 0,
          parts: partsFromElements([]),
        },
      ] as never,
      store,
      evidence: files as never,
      request: "shared",
      allowShared: true,
    });
    expect(files.merge.mock.calls).toEqual([["qq", ["qq2"]]]);
    const own = await store.queryVisible(channel("onebot"), [], { scopes: ["shared"] });
    expect(own).toHaveLength(2);
    expect(own.every((row) => row.platform === "onebot" && row.channelId === undefined && row.userId === undefined)).toBe(true);
  });
});

it("never recalls private user memory merely because that user joins a group", async () => {
  const { store, model } = setup();
  const privateContext: ChannelContext = { type: "direct", platform: "onebot", selfId: "bot", userId: "same", channelId: "private:same" };
  await store.create({ ...base, tags: [], scope: "user", platform: "onebot", userId: "same", context: privateContext }, "private");
  expect((await store.queryVisible(privateContext, ["same"])).map((row) => row.id)).toEqual(["private"]);
  expect(await store.queryVisible(channel("onebot"), ["same"])).toEqual([]);
  expect(await store.queryVisible({ ...privateContext, selfId: "other-bot" }, ["same"])).toEqual([]);
  await store.create(shared("onebot"), "shared");
  const another = memoryStore(model, { tenantId: "44444444-4444-4444-8444-444444444444" });
  expect(await another.queryVisible(channel("onebot"), ["same"])).toEqual([]);
});
