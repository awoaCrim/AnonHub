import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@yesimbot/agent-runtime";
import { systemClock } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ tools: [] as AgentTool[], prompt: "" }));
vi.mock("@yesimbot/agent-runtime", async (original) => ({
  ...(await original<typeof import("@yesimbot/agent-runtime")>()),
  createAgent: (config: { tools: AgentTool[] }) => {
    harness.tools = config.tools;
    return {
      init: async () => {},
      wait: async () => {},
      stop: async () => {},
      async *run(message: { content: string }) {
        harness.prompt = JSON.stringify(message);
        yield {};
      },
    };
  },
}));

import { runConsolidation } from "../src/consolidator.js";
import { EvidenceStore } from "../src/store/evidence.js";
import { memoryStore } from "./support.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const room: ChannelContext = { type: "guild", platform: "test", selfId: "bot", channelId: "room", guildId: "room" };
const other: ChannelContext = { ...room, channelId: "other", guildId: "other" };

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

const vectors: Record<string, number[]> = { cat: [1, 0, 0], kitten: [0.98, 0.05, 0], job: [0, 1, 0] };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daily consolidation", () => {
  it("offers only near-duplicates of new memories within one owned scope, and acts only inside a group", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorizer-consolidate-"));
    roots.push(root);
    const store = memoryStore(new Model(), {
      tenantId: TENANT,
      isOwner: () => false,
      indexer: { modelId: "embed", queryPrefix: "", embed: async (text) => vectors[Object.keys(vectors).find((key) => text.includes(key))!] },
    });
    const evidence = new EvidenceStore(root);
    const base = { type: "fact" as const, scope: "channel" as const, importance: 0.8, confidence: 0.9, tags: [] };
    const old = await store.create({ ...base, content: "alice has a cat", context: room });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const since = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await store.create({ ...base, content: "alice has a kitten", context: room });
    await store.create({ ...base, content: "alice has a kitten named cat", context: other });
    await store.create({ ...base, content: "alice changed job", context: room });

    expect((await store.nearDuplicates(since)).map((group) => group.map((memory) => memory.id))).toEqual([[fresh.id, old.id]]);
    await expect(runConsolidation({ clock: systemClock(), model: {} as never, store, evidence, since })).resolves.toEqual({ groups: 1 });
    expect(harness.prompt).toContain("alice has a kitten");
    expect(harness.prompt).not.toContain("changed job");
    const merge = harness.tools.find((tool) => tool.name === "merge_memories")!;
    const forget = harness.tools.find((tool) => tool.name === "forget_memory")!;
    const outsider = (await store.queryVisible(room, [])).find((memory) => memory.content === "alice changed job")!;
    await expect(forget.execute({ id: outsider.id }, {} as never)).resolves.toMatchObject({ ok: false, error: { code: "memory_not_in_group" } });
    await expect(merge.execute({ canonicalId: fresh.id, mergedId: old.id, content: "alice 养了一只猫" }, {} as never)).resolves.toMatchObject({
      merged: true,
      id: fresh.id,
    });
    expect((await store.queryVisible(room, [])).map((memory) => memory.content).sort()).toEqual(["alice changed job", "alice 养了一只猫"]);
  });
});
