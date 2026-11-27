import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage, systemClock } from "@yesimbot/foundation";
import { partsFromElements } from "koishi-plugin-yesimbot";
import type { CoreService } from "koishi-plugin-yesimbot/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";

vi.mock("../src/searcher.js", () => ({ runSearch: vi.fn() }));

import { extension } from "../src/index.js";
import { runSearch } from "../src/searcher.js";
import { EvidenceStore } from "../src/store/evidence.js";
import { sqliteMemoryTable } from "../src/store/sqlite.js";
import type { MemoryRow } from "../src/types.js";

const context = {
  baseDir: "/tmp",
  logger: () => ({ warn: vi.fn(), success: vi.fn(), info: vi.fn() }),
  yesimbot: {
    identity: { ...identity, tenantId: async () => "11111111-1111-4111-8111-111111111111" },
    config: {},
    model: {
      resolveChatModel: vi.fn(() => ({ model: {} })),
      resolveAuxiliaryModel: vi.fn(() => ({ model: {} })),
    },
    agent: { use: vi.fn(() => vi.fn()) },
    conversation: { read: vi.fn() },
    resource: { get: vi.fn(async () => ({})), use: vi.fn(() => vi.fn()) },
  },
  on: vi.fn(),
  plugin: vi.fn(),
  setTimeout: vi.fn(() => vi.fn()),
  setInterval: vi.fn(() => vi.fn()),
};

type FakeHost = typeof context & { bots?: Array<Record<string, unknown>>; yesimbot: object };

/** Starts the extension against a fake host context; `service` is the agent plugin it registered with Core. */
async function startMemorizer(ctx: FakeHost, raw: unknown) {
  type Service = { setup: (scope: unknown, bot: unknown) => Promise<{ tools: (...args: unknown[]) => unknown }> };
  let service: Service | undefined;
  const core = ctx.yesimbot as unknown as CoreService;
  const agentUse = (core.agent as unknown as { use: (plugin: Service) => unknown }).use;
  const wrapped = { ...core, agent: { use: (plugin: Service) => ((service = plugin), agentUse(plugin)) } };
  const provide = vi.fn();
  const undo = (await extension.start({
    config: extension.parse(raw),
    core: wrapped,
    baseDir: ctx.baseDir,
    clock: systemClock(),
    setTimeout: ctx.setTimeout,
    setInterval: ctx.setInterval,
    on: vi.fn(),
    provide,
    isOwnerContext: (scope: { platform?: string; selfId?: string }) =>
      (ctx.bots ?? []).some(
        (bot) =>
          bot.platform === scope.platform &&
          bot.selfId === scope.selfId &&
          (bot.belongsToRuntime as ((core: unknown) => boolean) | undefined)?.(ctx.yesimbot) === true &&
          (bot.isAuthenticatedContext as ((scope: unknown) => boolean) | undefined)?.(scope) === true,
      ),
  } as never)) as () => Promise<void>;
  return { service: service!, provide, stop: undo };
}

type AgentToolLike = { name: string; execute: (input: unknown, execution: unknown) => Promise<unknown> };

const NO_SCOPE = {
  tenantId: null,
  visibility: null,
  channelType: null,
  platform: null,
  guildId: null,
  channelId: null,
  selfId: null,
  userId: null,
  revision: 0,
  forgottenAt: null,
  embedding: null,
  embeddingModel: null,
};

/** A full memory row; `overrides` carries what the case cares about. */
function memoryRow(overrides: Partial<MemoryRow> & Pick<MemoryRow, "id" | "scope">): MemoryRow {
  return {
    type: "fact",
    content: "",
    status: "active",
    importance: 1,
    confidence: 1,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    ...NO_SCOPE,
    ...overrides,
  };
}

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "memorizer-state-"));
  configureStorage({ dataRoot });
});

afterEach(async () => {
  vi.clearAllMocks();
  closeStateDb();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("MemoryAgentPlugin", () => {
  it.each(["chat", "schedule"])("requires a live runtime-owned transport capability for %s participants", async (trigger) => {
    const scope = { type: "direct" as const, platform: "web", selfId: "bot", channelId: "owner", userId: "owner" };
    await sqliteMemoryTable().create(
      memoryRow({
        id: "owner-memory",
        type: "preference",
        content: "private owner preference",
        scope: "user",
        platform: "web",
        tenantId: "11111111-1111-4111-8111-111111111111",
        visibility: "owner",
        lastAccessedAt: Date.now(),
      }),
    );
    let live = true;
    let sameRuntime = true;
    const bot = { platform: "web", selfId: "bot", isAuthenticatedContext: vi.fn(() => live), belongsToRuntime: vi.fn(() => sameRuntime) };
    const ctx = { ...context, bots: [] as unknown[] };
    const plugin = await startMemorizer(ctx as never, {});
    const instance = await plugin.service.setup(scope, bot as never);
    const tools = await (instance.tools as () => Promise<Array<{ name: string; execute: (input: unknown, execution: unknown) => Promise<unknown> }>>)();
    const messages =
      trigger === "schedule"
        ? [
            {
              role: "custom",
              type: "yesimbot.event",
              data: {
                eventType: "schedule.due",
                platform: scope.platform,
                selfId: scope.selfId,
                channel: { id: scope.channelId, type: 1 },
                user: { id: scope.userId },
              },
            },
          ]
        : [{ role: "custom", type: "yesimbot.message", data: { user: { id: "owner" } } }];
    const recall = () => tools.find((tool) => tool.name === "recall")!.execute({}, { messages });
    await expect(recall()).resolves.toMatchObject({ memories: [] });
    ctx.bots.push(bot);
    await expect(recall()).resolves.toMatchObject({ memories: [{ id: "owner-memory" }] });
    sameRuntime = false;
    await expect(recall()).resolves.toMatchObject({ memories: [] });
    sameRuntime = true;
    live = false;
    await expect(recall()).resolves.toMatchObject({ memories: [] });
  });

  it("provides the memory service and registers only public channel tools", async () => {
    const agentUse = vi.fn(() => vi.fn());
    const ctx = {
      ...context,
      yesimbot: { identity, ...context.yesimbot, agent: { use: agentUse } },
    };
    const plugin = await startMemorizer(ctx as never, {});
    expect(plugin.provide).toHaveBeenCalledWith("yesimbotMemory", expect.objectContaining({ list: expect.any(Function), attachment: expect.any(Function) }));
    const factory = agentUse.mock.calls[0]![0];
    expect(await factory.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room" }, { selfId: "bot" })).toMatchObject({
      name: "memory-agent",
    });
    expect(
      (await (await factory.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room" }, { selfId: "bot" })).tools({})).map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(["remember", "recall"]);
    expect(await (await factory.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, { selfId: "bot" })).tools({})).toEqual([]);
    await plugin.stop();
  });

  it("serves a memory's attachment only where that memory is visible", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "memorizer-reader-"));
    try {
      const TENANT = "11111111-1111-4111-8111-111111111111";
      const OWNER_ID = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
      const SHARED_ID = "1f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
      const table = sqliteMemoryTable();
      await table.create(
        memoryRow({
          id: OWNER_ID,
          content: "owner's own picture",
          scope: "user",
          platform: "web",
          tenantId: TENANT,
          visibility: "owner",
          lastAccessedAt: Date.now(),
        }),
      );
      await table.create(
        memoryRow({
          id: SHARED_ID,
          content: "public picture",
          scope: "shared",
          platform: "web",
          tenantId: TENANT,
          visibility: "shared",
          lastAccessedAt: Date.now(),
        }),
      );
      const evidence = new EvidenceStore(join(baseDir, "data/yesimbot/memorizer"));
      for (const id of [OWNER_ID, SHARED_ID])
        await evidence.attach(id, [{ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png", name: "a.png", messageId: "m1" }]);
      let live = true;
      const bot = { platform: "web", selfId: "bot", isAuthenticatedContext: vi.fn(() => live), belongsToRuntime: vi.fn(() => true) };
      const resourcesByChannel = new Map<string, object>();
      const resourcesOf = (scope: { channelId: string }) =>
        resourcesByChannel.get(scope.channelId) ?? resourcesByChannel.set(scope.channelId, {}).get(scope.channelId)!;
      let reader: { setup: (resources: object, uri: URL, options: object) => Promise<unknown> } | undefined;
      const ctx = {
        ...context,
        baseDir,
        bots: [bot],
        yesimbot: {
          ...context.yesimbot,
          resource: {
            get: vi.fn(async (scope: { channelId: string }) => resourcesOf(scope)),
            use: vi.fn((value: typeof reader) => ((reader = value), vi.fn())),
          },
        },
      };
      const plugin = await startMemorizer(ctx as never, {});
      const dm = { type: "direct" as const, platform: "web", selfId: "bot", channelId: "owner", userId: "owner" };
      const room = { type: "guild" as const, platform: "web", selfId: "bot", channelId: "room", guildId: "room" };
      await plugin.service.setup(dm, bot as never);
      await plugin.service.setup(room, bot as never);
      const open = (scope: { channelId: string } | undefined, uri: string, actorIds?: string[]) =>
        reader!.setup(scope ? resourcesOf(scope) : {}, new URL(uri), { signal: new AbortController().signal, maxBytes: 1024, actorIds });
      const bytes = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png", filename: "a.png" };

      await expect(open(dm, `memory://${OWNER_ID}/1`, ["owner"])).resolves.toEqual(bytes);
      await expect(open(room, `memory://${OWNER_ID}/1`, ["owner"])).rejects.toMatchObject({ code: "resource_not_found" });
      await expect(open(room, `memory://${SHARED_ID}/1`, [])).resolves.toEqual(bytes);
      await expect(open(dm, `memory://${OWNER_ID}/2`, ["owner"])).rejects.toMatchObject({ code: "resource_not_found" });
      await expect(open(dm, "memory://../1", ["owner"])).rejects.toMatchObject({ code: "resource_uri_invalid" });
      await expect(open(undefined, `memory://${SHARED_ID}/1`)).rejects.toMatchObject({ code: "resource_unavailable" });
      // The owner's picture follows the transport's owner check, not the chat's ID.
      live = false;
      await expect(open(dm, `memory://${OWNER_ID}/1`, ["owner"])).rejects.toMatchObject({ code: "resource_not_found" });
      await plugin.stop();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("lets a registered admin's direct chat publish shared memories without unlocking owner-private ones", async () => {
    const read = vi.fn(async (scope: { channelId: string; userId?: string }) => [
      {
        platform: "onebot",
        selfId: "bot",
        channel: { id: scope.channelId, type: 1 },
        user: { id: scope.userId, name: "someone" },
        messageId: "m1",
        timestamp: 1,
        parts: partsFromElements([{ type: "text", attrs: { content: "公开：周五群里不发广告" }, children: [] }]),
      },
    ]);
    const ctx = {
      ...context,
      bots: [],
      yesimbot: {
        ...context.yesimbot,
        config: { admins: [{ platform: "onebot", userId: "1049" }] },
        conversation: { read },
        resource: { get: vi.fn(async () => ({})), use: vi.fn(() => vi.fn()) },
      },
    };
    const plugin = await startMemorizer(ctx as never, {});
    const remember = async (userId: string, scope: string) => {
      const chat = { type: "direct" as const, platform: "onebot", selfId: "bot", channelId: `private:${userId}`, userId };
      const tools = await ((await plugin.service.setup(chat, { selfId: "bot", platform: "onebot" } as never)).tools as () => Promise<AgentToolLike[]>)();
      const messages = [{ role: "custom", type: "yesimbot.message", data: { user: { id: userId } } }];
      return tools
        .find((tool) => tool.name === "remember")!
        .execute({ action: "create", content: `${scope}：周五群里不发广告`, sources: ["m1"], type: "knowledge", scope }, { messages });
    };
    await expect(remember("1049", "shared")).resolves.toMatchObject({ saved: true, scope: "shared" });
    await expect(remember("2000", "shared")).resolves.toMatchObject({ ok: false, error: { code: "memory_publish_owner_only" } });
    // Registered admin is not the transport-verified owner: its own chat's memory stays with that chat.
    await expect(remember("1049", "channel")).resolves.toMatchObject({ saved: true });
    expect((await sqliteMemoryTable().all()).map((row) => [row.scope, row.visibility])).toEqual([
      ["shared", "shared"],
      ["channel", "conversation"],
    ]);
  });

  it("resolves delegated searches through the core auxiliary model", async () => {
    const model = {};
    const resolveAuxiliaryModel = vi.fn(() => ({ model }));
    const resolveChatModel = vi.fn();
    const ctx = {
      ...context,
      yesimbot: { identity, ...context.yesimbot, model: { resolveAuxiliaryModel, resolveChatModel } },
    };
    const plugin = await startMemorizer(ctx as never, {});
    const scope = { type: "guild" as const, platform: "onebot", channelId: "room", guildId: "room" };
    const instance = await plugin.service.setup(scope, { selfId: "bot" } as never);
    const tools = await (instance as { tools: () => Array<{ name: string; execute: (input: unknown, execution: unknown) => Promise<unknown> }> }).tools();
    const report = { answer: "fixture", memories: [], unresolved: [] };
    // Starting the service resolves its own maintenance model; only the search call counts here.
    resolveAuxiliaryModel.mockClear();
    vi.mocked(runSearch).mockResolvedValue(report);

    await expect(tools.find((tool) => tool.name === "recall")!.execute({ query: "question", report: true }, {})).resolves.toEqual(report);
    expect(resolveAuxiliaryModel).toHaveBeenCalledExactlyOnceWith("utility", { ...scope, selfId: "bot" });
    expect(runSearch).toHaveBeenCalledWith(expect.objectContaining({ model, context: { ...scope, selfId: "bot" }, query: "question" }));
    expect(resolveChatModel).not.toHaveBeenCalled();
    await expect(tools.find((tool) => tool.name === "recall")!.execute({ report: true }, {})).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_recall_input",
    });
  });
});
