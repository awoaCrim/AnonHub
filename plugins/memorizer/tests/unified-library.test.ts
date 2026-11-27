import { partsFromElements } from "koishi-plugin-yesimbot";
import type { ChannelContext, MessageRecord } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { memoryStore } from "./support.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const web: ChannelContext = { type: "direct", platform: "web", selfId: "bot", channelId: "owner", userId: "owner" };
const qq: ChannelContext = { type: "direct", platform: "onebot", selfId: "qqbot", channelId: "private:123", userId: "123" };
const room: ChannelContext = { type: "guild", platform: "onebot", selfId: "qqbot", channelId: "room", guildId: "room" };
const otherRoom: ChannelContext = { ...room, platform: "wechat-bridge" };
const fact = { type: "preference" as const, content: "主人长期偏好简洁中文回答", importance: 0.8, confidence: 0.9, tags: ["偏好"] };

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
    if ("id" in patch) throw new Error("cannot modify primary key");
    for (const row of await this.get(table, query)) Object.assign(row, patch);
  }
  async remove(table: string, query: Record<string, unknown>) {
    const removed = await this.get(table, query);
    this.rows = this.rows.filter((row) => !removed.includes(row));
  }
}
function setup() {
  const model = new Model();
  let authenticated = true;
  const store = memoryStore(model, {
    tenantId: TENANT,
    isOwner: (context) =>
      authenticated &&
      [web, qq].some(
        (owner) =>
          context.type === "direct" &&
          context.platform === owner.platform &&
          context.selfId === owner.selfId &&
          context.userId === (owner as { userId: string }).userId,
      ),
  });
  return {
    model,
    store,
    expire: () => {
      authenticated = false;
    },
  };
}

function message(context: ChannelContext, id: string): MessageRecord {
  return {
    platform: context.platform,
    selfId: context.selfId!,
    channel: { id: context.channelId, type: context.type === "direct" ? 1 : 0 },
    user: { id: context.type === "direct" ? context.userId : "123" },
    messageId: id,
    timestamp: 1,
    parts: partsFromElements([]),
  };
}

describe("instance library and independent visibility", () => {
  it("shares owner facts only between trusted private ingress, never through membership, names or equal IDs", async () => {
    const { store, expire } = setup();
    const memory = await store.create({ ...fact, scope: "user", context: web, platform: "web", userId: "owner" });
    expect(memory).toMatchObject({ tenantId: TENANT, visibility: "owner" });
    expect((await store.queryVisible(qq, ["123"])).map((entry) => entry.id)).toEqual([memory.id]);
    expect(await store.queryVisible(room, ["123", "owner"])).toEqual([]);
    expect(await store.queryVisible({ ...qq, selfId: "foreign-bot", userName: "owner" } as ChannelContext, ["123"])).toEqual([]);
    expect(await store.queryVisible({ ...qq, platform: "unbound", userName: "主人" } as ChannelContext, ["123"])).toEqual([]);
    expect(await store.queryVisible(qq, ["123", "intruder"])).toEqual([]);
    expect(await store.queryVisible(qq, [])).toEqual([]);
    expire();
    expect(await store.queryVisible(web, ["owner"])).toEqual([]);
  });

  it("keeps unbound private facts in their origin while explicit public knowledge crosses platforms without a UUID option", async () => {
    const { store } = setup();
    const unbound = { ...qq, selfId: "unbound-bot" } as ChannelContext;
    const privateFact = await store.create({ ...fact, scope: "channel", context: unbound });
    const shared = await store.create({ ...fact, content: "开发规则：修改后运行相关测试", scope: "shared", platform: "onebot" });
    expect(privateFact.visibility).toBe("conversation");
    expect((await store.queryVisible(unbound, ["123"])).map((entry) => entry.id).sort()).toEqual([privateFact.id, shared.id].sort());
    expect((await store.queryVisible(otherRoom, ["123"])).map((entry) => entry.id)).toEqual([shared.id]);
    expect((await store.queryVisible(qq, ["123"])).map((entry) => entry.id)).toEqual([shared.id]);
  });

  it("filters raw evidence by source independently of shared summaries, including after visibility changes", async () => {
    const { store } = setup();
    const shared = await store.create({ ...fact, content: "通用测试流程", scope: "shared", platform: "onebot" });
    const raw = [message(room, "public"), message(qq, "private"), { ...message(room, "whisper"), whisper: true as const }];
    expect((await store.visibleEvidence(shared, room, ["123"], raw)).map((entry) => entry.messageId)).toEqual(["public"]);
    expect(await store.visibleEvidence(shared, otherRoom, ["123"], raw)).toEqual([]);
    await store.editManaged({ id: shared.id, revision: shared.revision!, content: shared.content, visibility: "owner" });
    expect(await store.visibleEvidence(shared, room, ["123"], raw)).toEqual([]);
    const owner = await store.create({ ...fact, scope: "user", context: qq, platform: "onebot", userId: "123" });
    expect((await store.visibleEvidence(owner, web, ["owner"], [message(qq, "private")])).map((entry) => entry.messageId)).toEqual(["private"]);
    expect(await store.visibleEvidence(owner, room, ["123"], [message(qq, "private")])).toEqual([]);
  });

  it("deduplicates normalized owner facts across origins and guards provenance and merge ownership", async () => {
    const { store } = setup();
    const first = await store.create({ ...fact, scope: "user", context: qq, platform: "onebot", userId: "123" });
    const duplicate = await store.create({ ...fact, content: `  ${fact.content}  `, scope: "user", context: web, platform: "web", userId: "owner" });
    expect(duplicate.id).toBe(first.id);
    const second = await store.create({ ...fact, content: "主人偏好短回答", scope: "user", context: web, platform: "web", userId: "owner" });
    await expect(store.merge(first.id, second.id, { content: "主人偏好简洁中文短回答" })).resolves.toMatchObject({ id: first.id, platform: "onebot" });
    await expect(store.update(first.id, { visibility: "shared" } as never)).rejects.toThrow("memory_ownership_immutable");
    const scoped = await store.create({ ...fact, scope: "user", context: room, platform: "onebot", userId: "123" });
    const sideEffect = vi.fn();
    await expect(store.merge(first.id, scoped.id, {}, sideEffect)).rejects.toThrow("memory_merge_scope_mismatch");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("paginates owner management, rejects stale concurrent edits and isolates foreign tenants", async () => {
    const { model, store } = setup();
    const first = await store.create({ ...fact, scope: "channel", context: room }, "a");
    await store.create({ ...fact, content: "另一条稳定约定", scope: "channel", context: room }, "b");
    const foreign = memoryStore(model, { tenantId: OTHER });
    await foreign.create({ ...fact, scope: "channel", context: room }, "foreign");
    const page = await store.listManaged({ limit: 1 });
    expect(page).toMatchObject({ memories: [{ id: "a", revision: 1 }], nextCursor: "a" });
    expect((await store.listManaged({ cursor: page.nextCursor })).memories.map((entry) => entry.id)).toEqual(["b"]);
    expect(JSON.stringify(page)).not.toMatch(/embedding|evidence|sourceMessageIds/);
    await store.touch(["a"]); // Reading a memory must not invalidate an owner's content edit.
    const edits = await Promise.allSettled(
      ["first edit", "second edit"].map((content) => store.editManaged({ id: first.id, revision: 1, content, visibility: "owner" })),
    );
    expect(edits.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { message: "memory_revision_conflict" } });
    const remove = vi.fn(async () => {});
    await expect(store.deleteManaged({ id: first.id, revision: 1 }, remove)).rejects.toThrow("memory_revision_conflict");
    expect(remove).not.toHaveBeenCalled();
    await expect(store.editManaged({ id: "foreign", revision: 1, content: "steal", visibility: "shared" })).rejects.toThrow("memory_not_found");
    await store.deleteManaged({ id: first.id, revision: 2 }, remove);
    expect(remove).toHaveBeenCalledWith("a");
    expect(await store.get("a")).toBeUndefined();
    await expect(store.listManaged({ limit: 201 })).rejects.toThrow("invalid_memory_page");
    await expect(store.editManaged({ id: "b", revision: 1, content: "password=private-secret", visibility: "owner" })).rejects.toThrow(
      "invalid_memory_content",
    );
  });

  it("rechecks authorization when queued owner edits and deletions begin", async () => {
    const model = new Model();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let holdEmbedding = false;
    const store = memoryStore(model, {
      tenantId: TENANT,
      isOwner: () => true,
      indexer: {
        modelId: "test",
        queryPrefix: "",
        embed: async () => {
          if (holdEmbedding) {
            entered();
            await blocked;
          }
          return [1, 0];
        },
      },
    });
    const memory = await store.create({ ...fact, scope: "channel", context: web });
    holdEmbedding = true;
    const blocker = store.create({ ...fact, content: "另一条长期事实", scope: "channel", context: web });
    await started;
    let authenticated = true;
    const authorize = () => {
      if (!authenticated) throw Error("authorization_revoked");
    };
    const remove = vi.fn(async () => {});
    const edit = expect(store.editManaged({ id: memory.id, revision: 1, content: memory.content, visibility: "shared" }, authorize)).rejects.toThrow(
      "authorization_revoked",
    );
    const deletion = expect(store.deleteManaged({ id: memory.id, revision: 1 }, remove, authorize)).rejects.toThrow("authorization_revoked");
    authenticated = false;
    release();
    await blocker;
    await Promise.all([edit, deletion]);
    expect(await store.get(memory.id)).toMatchObject({ content: memory.content, visibility: "owner", revision: 1 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("rechecks authorization after an owner's edit waits for embedding", async () => {
    const model = new Model();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const changedContent = "主人长期偏好更详细的中文回答";
    const store = memoryStore(model, {
      tenantId: TENANT,
      isOwner: () => true,
      indexer: {
        modelId: "test",
        queryPrefix: "",
        embed: async (text) => {
          if (text.includes(changedContent)) {
            entered();
            await blocked;
          }
          return [1, 0];
        },
      },
    });
    const memory = await store.create({ ...fact, scope: "channel", context: web });
    let authenticated = true;
    const pending = expect(
      store.editManaged({ id: memory.id, revision: 1, content: changedContent, visibility: "shared" }, () => {
        if (!authenticated) throw Error("authorization_revoked");
      }),
    ).rejects.toThrow("authorization_revoked");
    await started;
    authenticated = false;
    release();
    await pending;
    expect(await store.get(memory.id)).toMatchObject({ content: memory.content, visibility: "owner", revision: 1 });
  });
});
