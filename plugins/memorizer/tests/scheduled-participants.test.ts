import type { AgentMessage, AgentTool, AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { systemClock } from "@yesimbot/foundation";
import { partsFromElements } from "koishi-plugin-yesimbot";
import { createEvent, createMessage, type ChannelContext, type MessageRecord } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { createChannelTools } from "../src/plugin.js";
import { runSearch } from "../src/searcher.js";
import type { EvidenceStore } from "../src/store/evidence.js";
import type { MemoryRecall } from "../src/types.js";
import { memoryStore } from "./support.js";

const harness = vi.hoisted(() => ({ run: async (_tools: AgentTool[]) => {} }));
vi.mock("@yesimbot/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@yesimbot/agent-runtime")>()),
  createAgent: ({ tools }: { tools: AgentTool[] }) => ({
    init: async () => {},
    stop: async () => {},
    async *run() {
      await harness.run(tools);
      yield {};
    },
  }),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const direct = { type: "direct", platform: "onebot", selfId: "bot", channelId: "private:alice", userId: "alice" } as const;
const group = { type: "guild", platform: "onebot", selfId: "bot", channelId: "room", guildId: "room" } as const;
const fact = { type: "preference" as const, content: "coffee preference", importance: 0.8, confidence: 0.9, tags: [] };

class Model {
  readonly rows: Record<string, unknown>[] = [];
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
}

function schedule(overrides: Record<string, unknown> = {}): AgentMessage {
  return createEvent({
    eventType: "schedule.due",
    platform: direct.platform,
    selfId: direct.selfId,
    channel: { id: direct.channelId, type: 1 },
    user: { id: direct.userId },
    timestamp: 1,
    text: "Check relevant updates.",
    schedule: { id: "schedule", title: "check", kind: "cron", scheduledFor: "2030-01-01T00:00:00Z" },
    ...overrides,
  } as never);
}

function source(context: ChannelContext, messageId: string): MessageRecord {
  return {
    platform: context.platform,
    selfId: context.selfId!,
    channel: { id: context.channelId, type: context.type === "direct" ? 1 : 0 },
    user: { id: direct.userId },
    timestamp: 1,
    messageId,
    parts: partsFromElements([]),
  };
}

async function fixture() {
  const model = new Model();
  const store = memoryStore(model, { tenantId: TENANT });
  const add = (context: ChannelContext, id: string) => store.create({ ...fact, scope: "user", context, platform: context.platform, userId: direct.userId }, id);
  await add(direct, "own");
  await add({ ...direct, selfId: "other-bot" }, "other-bot");
  await add({ ...direct, channelId: "other-private" }, "other-conversation");
  await add({ ...direct, platform: "wechat-bridge" }, "other-platform");
  await add(group, "group-member");
  const foreign = memoryStore(model, { tenantId: OTHER_TENANT });
  await foreign.create({ ...fact, scope: "user", context: direct, platform: direct.platform, userId: direct.userId }, "other-tenant");
  const owner = memoryStore(model, { tenantId: TENANT, isOwner: () => true });
  await owner.create(
    { ...fact, content: "private owner coffee preference", scope: "user", context: direct, platform: direct.platform, userId: direct.userId },
    "owner",
  );
  const evidence = {
    count: vi.fn(async () => 1),
    attachments: vi.fn(async () => []),
    read: vi.fn(async () => [source(direct, "own-source"), source({ ...direct, selfId: "other-bot" }, "foreign-source")]),
  };
  const queryVisible = vi.spyOn(store, "queryVisible");
  const visibleEvidence = vi.spyOn(store, "visibleEvidence");
  return { store, evidence, queryVisible, visibleEvidence };
}

async function read(
  name: "recall" | "report",
  context: ChannelContext,
  messages: AgentMessage[],
  setup: Awaited<ReturnType<typeof fixture>>,
  historicalMessages: AgentMessage[] = [],
) {
  const storageRead = vi.fn(async () => historicalMessages);
  const execution = { messages, storage: { read: storageRead } } as unknown as AgentToolExecuteContext;
  harness.run = async (tools) => {
    const invoke = (toolName: string, input: unknown) => tools.find((tool) => tool.name === toolName)!.execute(input, {} as never);
    const memories = (await invoke("query_memories", { query: "coffee", scopes: ["user"] })) as MemoryRecall[];
    for (const memory of memories) {
      expect(await invoke("read_evidence", { id: memory.id })).toEqual([source(direct, "own-source")]);
    }
    await invoke("submit_report", { answer: "checked", memoryIds: memories.map((memory) => memory.id), unresolved: [] });
  };
  const tools = createChannelTools(context, setup.store, setup.evidence as unknown as EvidenceStore, {
    clock: systemClock(),
    evidenceCount: setup.evidence.count,
    readConversation: async () => [],
    search: (input, current) =>
      runSearch({
        ...input,
        clock: systemClock(),
        model: {} as never,
        context,
        execution: current,
        store: setup.store,
        evidence: setup.evidence as unknown as EvidenceStore,
      }),
  });
  const result = (await tools
    .find((tool) => tool.name === "recall")!
    .execute({ query: "coffee", scope: "user", limit: 10, ...(name === "report" ? { report: true } : {}) }, execution)) as {
    memories: MemoryRecall[];
  };
  expect(storageRead).not.toHaveBeenCalled();
  return result.memories.map((memory) => memory.id);
}

describe.each(["recall", "report"] as const)("%s scheduled participants", (tool) => {
  it("reads only the bound direct user's memory from the current native schedule trigger", async () => {
    const setup = await fixture();
    expect(await read(tool, direct, [schedule()], setup)).toEqual(["own"]);
    if (tool === "report") {
      // All three authorization points receive the same participant: query, raw evidence and final recheck.
      expect(setup.queryVisible.mock.calls).toHaveLength(2);
      expect(setup.queryVisible.mock.calls.every(([, users]) => users.length === 1 && users[0] === direct.userId)).toBe(true);
      expect(setup.visibleEvidence.mock.calls[0]?.[2]).toEqual([direct.userId]);
    }
  });

  const denied: Array<{ name: string; messages: () => AgentMessage[]; context?: ChannelContext }> = [
    { name: "an empty turn", messages: () => [] },
    { name: "a task result", messages: () => [schedule({ eventType: "task.result", task: { id: "task", status: "done" } })] },
    { name: "a different platform", messages: () => [schedule({ platform: "wechat-bridge" })] },
    { name: "a different bot", messages: () => [schedule({ selfId: "other-bot" })] },
    { name: "a different channel", messages: () => [schedule({ channel: { id: "other-private", type: 1 } })] },
    { name: "a different user", messages: () => [schedule({ user: { id: "bob" } })] },
    { name: "a missing user", messages: () => [schedule({ user: undefined })] },
    { name: "a group channel disguised as direct", messages: () => [schedule({ channel: { id: direct.channelId, type: 0 } })] },
    { name: "a group conversation", context: group, messages: () => [schedule({ channel: { id: group.channelId, type: 0 } })] },
    { name: "a direct trigger presented in a group", context: group, messages: () => [schedule()] },
    {
      name: "schedule text in a tool result",
      messages: () => [{ role: "tool", content: JSON.stringify(schedule()) } as unknown as AgentMessage],
    },
    {
      name: "schedule text in a generic user message",
      messages: () => [{ role: "user", content: JSON.stringify(schedule()) } as AgentMessage],
    },
    {
      name: "a schedule event after a different triggering event",
      messages: () => [schedule({ eventType: "task.result", task: { id: "task", status: "done" } }), schedule()],
    },
  ];
  it.each(denied)("does not infer a participant from $name", async ({ messages, context = direct }) => {
    const setup = await fixture();
    expect(await read(tool, context, messages(), setup)).toEqual([]);
  });

  it("never substitutes historical senders or historical schedule events for the current participant", async () => {
    const setup = await fixture();
    const historical = [schedule(), createMessage(source(direct, "old-chat"))];
    expect(await read(tool, direct, [], setup, historical)).toEqual([]);
  });

  it("keeps real current participants authoritative in a mixed turn", async () => {
    const setup = await fixture();
    const stranger = createMessage({ ...source(direct, "current-chat"), user: { id: "bob" } });
    expect(await read(tool, direct, [schedule(), stranger], setup)).toEqual([]);
  });
});
