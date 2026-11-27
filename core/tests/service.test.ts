import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ChannelContext } from "../src/channels/index.js";
import type { Config } from "../src/config.js";
import type { ConversationReadOptions } from "../src/conversations/index.js";
import { YesImBotCore } from "../src/core.js";
import { TestEvents } from "./helpers/index.js";

const config: Config = {
  basePath: "data/yesimbot",
  chatModel: "test:model",
  auxiliaryModel: undefined,
  visionModel: undefined,
  logLevel: 2,
  allowedChannels: [],
  imageInput: false,
  modelRetries: 0,
  resourceReadTimeout: 30,
  pacing: { charactersPerSecond: 8, maxTotalDelayMs: 60_000 },
  customInnerThought: true,
  session: {
    magicContext: {},
    archive: { maxKB: 0 },
  },
};

function createCore(raw: unknown) {
  return new YesImBotCore({ baseDir: tmpdir(), config: raw, events: new TestEvents(), account: () => undefined });
}

describe("YesImBotCore facade", () => {
  it("accepts a null plugin config and applies schema defaults", () => {
    const service = createCore(null);

    expect(service.config.logLevel).toBe(2);
  });

  it("exposes only narrow domain entries", () => {
    const service = createCore({ ...config, basePath: join(tmpdir(), `yesimbot-service-${randomUUID()}`) });

    expect(service.model).toBeDefined();
    expect(service.messenger).toMatchObject({ accept: expect.any(Function), post: expect.any(Function) });
    expect(service.message).toMatchObject({ use: expect.any(Function) });
    expect(service.agent).toMatchObject({ use: expect.any(Function), will: expect.any(Function) });
    expect(service.resource).toMatchObject({ get: expect.any(Function), use: expect.any(Function) });
    expect(service.conversation).toMatchObject({ read: expect.any(Function), archive: expect.any(Function) });
    expect("trigger" in service).toBe(false);
    expect("reset" in service).toBe(false);
    expect("assets" in service).toBe(false);
    expect("getStoragePath" in service).toBe(false);
  });

  it("delegates conversation reads to the resolved channel", async () => {
    const service = createCore({ ...config, basePath: join(tmpdir(), `yesimbot-service-${randomUUID()}`) });
    const context: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };
    const options: ConversationReadOptions = { limit: 2 };
    const result = [{ messageId: "message" }];
    const resolve = vi.fn().mockResolvedValue({ conversation: { read: vi.fn().mockResolvedValue(result) } });
    (service as unknown as { channels: { resolve: typeof resolve } }).channels.resolve = resolve;

    await expect(service.conversation.read(context, options)).resolves.toEqual(result);
    expect(resolve).toHaveBeenCalledWith(context);
  });

  it("archives only existing local chat histories through the serialized runtime boundary", async () => {
    const service = createCore({ ...config, basePath: join(tmpdir(), `yesimbot-archive-service-${randomUUID()}`) });
    const storedContext = vi.fn();
    const archive = vi.fn();
    const internals = service as unknown as { channels: { storedContext: typeof storedContext }; runtimes: { archive: typeof archive } };
    internals.channels.storedContext = storedContext;
    internals.runtimes.archive = archive;
    const request = { channel: "existing-history", session: "20261103.jsonl" };
    await expect(service.conversation.archive(request)).rejects.toThrow("conversation_not_found");
    // Records of a retired platform (Xiaoheihe) stay readable but are never archived or run.
    storedContext.mockResolvedValueOnce({ type: "guild", platform: "xiaoheihe", channelId: "account:1", guildId: "account:1" });
    await expect(service.conversation.archive(request)).rejects.toThrow("conversation_not_found");
    expect(archive).not.toHaveBeenCalled();
    const context = { type: "guild", platform: "onebot", channelId: "room", guildId: "room", selfId: "bot" };
    storedContext.mockResolvedValueOnce(context);
    vi.spyOn(service.conversation, "locate").mockResolvedValue(request);
    await service.conversation.archive(request);
    expect(archive).toHaveBeenCalledExactlyOnceWith(context, true, request.session);
  });
  it("threads independent opt-in video input through the service resource facade", async () => {
    const service = createCore({ ...config, basePath: join(tmpdir(), `yesimbot-service-video-${randomUUID()}`), videoInput: true });
    const resources = await service.resource.get({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
    expect(resources.videoInput).toBe(true);
    expect(resources.imageInput).toBe(false);
    service.model.register({
      id: "test",
      capabilities: { chat: true, embedding: false },
      chatModels: () => [{ id: "model" }],
      embeddingModels: () => [],
      chat: () => ({}) as never,
    });
    expect(service.model.resolveChatModel(config.chatModel).entry.modalities?.input).toEqual(["text", "video"]);
  });

  it("honors a saved image-understanding role without a second hidden capability setting", () => {
    const service = createCore({
      ...config,
      basePath: join(tmpdir(), `yesimbot-vision-role-${randomUUID()}`),
      chatModel: "google:vision",
      visionModel: "google:vision",
    });
    service.model.register({
      id: "google",
      capabilities: { chat: true, embedding: false },
      chatModels: () => [{ id: "vision" }, { id: "other" }],
      embeddingModels: () => [],
      chat: () => ({}) as never,
      chatCapabilities: () => ({ imageToolResult: "native" }),
    });
    expect(service.model.resolveChatModel("google:vision").entry.modalities?.input).toEqual(["text", "image"]);
    expect(service.model.resolveChatModel("google:other").entry.modalities?.input).toBeUndefined();
  });

  it("threads image input and converts resource timeout seconds", async () => {
    vi.useFakeTimers();
    try {
      const basePath = join(tmpdir(), `yesimbot-service-config-${randomUUID()}`);
      const service = createCore({ ...config, basePath, imageInput: true, resourceReadTimeout: 1 });
      const resources = await service.resource.get({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
      resources.use({ scheme: "slow", prompt: "slow reader", setup: async () => Promise.withResolvers<never>().promise });
      const controller = new AbortController();
      let cause: unknown;
      void resources.openStrict("slow:///file", controller.signal).catch((error: unknown) => {
        cause = error;
      });
      try {
        expect(resources.imageInput).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(cause).toMatchObject({ code: "resource_timeout" });
      } finally {
        controller.abort();
        await vi.runAllTimersAsync();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
