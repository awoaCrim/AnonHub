import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelService } from "../src/models/index.js";
import { resolvePrimaryImageInput, resolveReadImagePolicy, resolveReadVideoPolicy } from "../src/runtimes/index.js";
import { TestEvents } from "./helpers/index.js";

type ModelProvider = Parameters<ModelService["register"]>[0];

const temporaryDirectories: string[] = [];

async function createModelsPath(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yesimbot-model-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "models.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function createProvider(): ModelProvider {
  return {
    id: "openai",
    capabilities: { chat: true, embedding: true },
    chatModels: () => [{ id: "gpt-4o", name: "GPT-4o" }],
    embeddingModels: () => [{ id: "text-embedding-3-small", dimension: 1536 }],
    chat: () => ({}) as never,
    embedding: () => ({}) as never,
  };
}

function createProviderWithImage(): ModelProvider {
  return {
    id: "openai",
    capabilities: { chat: true, embedding: true },
    chatModels: () => [{ id: "gpt-4o", name: "GPT-4o", modalities: { input: ["image" as const] } }],
    embeddingModels: () => [{ id: "text-embedding-3-small", dimension: 1536 }],
    chat: () => ({}) as never,
    embedding: () => ({}) as never,
  };
}

async function createModelService(
  models: unknown,
  basePath?: string,
  provider?: ModelProvider,
  auxiliaryModel?: string,
  visionModel?: string,
  video: { chatModel?: string; videoInput?: boolean } = {},
): Promise<ModelService> {
  const directory = basePath ?? (await createModelsPath(models)).slice(0, -"/models.json".length);
  const ctx = new TestEvents();
  const service = new ModelService({ baseDir: "/", emit: ctx.emit.bind(ctx) }, { basePath: directory, auxiliaryModel, visionModel, ...video });
  await service.start();
  service.register(provider ?? createProvider());
  return service;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("models.json modalities", () => {
  it("scopes thinking overrides to cloned resolved entries without changing registry settings or limits", async () => {
    const calls: import("../src/models/config.js").ChatModelConfig[] = [];
    const provider: ModelProvider = {
      ...createProvider(),
      chatModels: () => [{ id: "gpt-4o", reasoning: true, thinkingLevel: "high", thinkingLevelMap: { low: "low" }, limit: { context: 128000, output: 16000 } }],
      chat: (_id, entry) => {
        calls.push(entry!);
        return { specificationVersion: "v3", provider: "openai", modelId: "gpt-4o", supportedUrls: {} } as never;
      },
    };
    const service = await createModelService({}, undefined, provider);
    const revision = service.revision;
    const main = service.resolveChatModel("openai:gpt-4o");
    const historian = service.resolveChatModel("openai:gpt-4o", undefined, { thinkingLevel: "low" });
    expect(main.entry.thinkingLevel).toBe("high");
    expect(historian.entry.thinkingLevel).toBe("low");
    expect(calls.map((entry) => entry.thinkingLevel)).toEqual(["high", "low"]);
    expect(historian.fullId).toBe(main.fullId);
    expect(historian.model).not.toBe(main.model);
    expect(historian.capabilities).toEqual(main.capabilities);
    expect(service.contextLimit(historian.model)).toEqual({ context: 128000, output: 16000 });
    historian.entry.thinkingLevelMap!.low = null;
    historian.entry.limit!.output = 1;
    calls[1]!.thinkingLevelMap!.low = "changed";
    calls[1]!.limit!.context = 1;
    const next = service.resolveChatModel("openai:gpt-4o");
    expect(next.entry).toMatchObject({ thinkingLevel: "high", thinkingLevelMap: { low: "low" }, limit: { context: 128000, output: 16000 } });
    expect(main.entry.limit).toEqual({ context: 128000, output: 16000 });
    expect(service.revision).toBe(revision);
  });
  it("resolves context limits from actual registered provider/model identity without guessing names", async () => {
    const provider: ModelProvider = {
      ...createProvider(),
      chat: () => ({ specificationVersion: "v3", provider: "openai.responses", modelId: "gpt-4o", supportedUrls: {} }) as never,
    };
    const service = await createModelService({ chat: { "openai:gpt-4o": { limit: { context: 128_000, output: 16_000 } } } }, undefined, provider);
    const ref = service.resolveChatModel("openai:gpt-4o");
    expect(service.contextLimit(ref.model)).toEqual({ context: 128_000, output: 16_000 });
    expect(service.contextLimit("openai:gpt-4o")).toEqual({ context: 128_000, output: 16_000 });
    expect(service.contextLimit("unregistered:gpt-4o")).toBeUndefined();
    expect(service.contextLimit({ provider: "unknown", modelId: "gpt-4o" } as never)).toBeUndefined();
    expect(service.contextLimit({ provider: "openai", modelId: "other" } as never)).toBeUndefined();
  });
  it("preserves configured embedding defaults through provider registration, resolution, listing, and query", async () => {
    const embedding = {};
    const provider: ModelProvider = {
      id: "openai",
      capabilities: { chat: true, embedding: true },
      chatModels: () => [{ id: "gpt-4o" }],
      embeddingModels: () => [{ id: "text-embedding-3-small", dimension: 1536 }],
      chat: () => ({}) as never,
      embedding: vi.fn(() => embedding as never),
    };
    const service = await createModelService(
      {
        defaults: { embedding: "openai:text-embedding-3-small" },
        aliases: { semantic: "openai:text-embedding-3-small" },
        embedding: { "openai:text-embedding-3-small": { name: "Semantic" } },
      },
      undefined,
      provider,
    );

    expect(service.getDefaultEmbeddingModelId()).toBe("openai:text-embedding-3-small");
    expect(service.resolveEmbedding("semantic")).not.toBe(embedding);
    expect(service.listEmbeddingModels()).toEqual([
      { fullId: "openai:text-embedding-3-small", config: { id: "text-embedding-3-small", dimension: 1536, name: "Semantic" } },
    ]);
    expect(service.getProvider("openai")).toBe(provider);
  });

  it("increments the model revision when providers register and unregister", async () => {
    const path = await createModelsPath({});
    const directory = path.slice(0, -"/models.json".length);
    const ctx = new TestEvents();
    const service = new ModelService({ baseDir: "/", emit: ctx.emit.bind(ctx) }, { basePath: directory });
    await service.start();
    const before = service.revision;
    const dispose = service.register(createProvider());
    expect(service.revision).toBeGreaterThan(before);
    const registered = service.revision;
    dispose();
    expect(service.revision).toBeGreaterThan(registered);
  });
  it("loads and isolates model-level thinking settings", async () => {
    const chat = vi.fn(() => ({}) as never);
    const provider: ModelProvider = {
      ...createProvider(),
      chat,
      chatModels: () => [
        {
          id: "gpt-4o",
          thinkingLevel: "medium",
          thinkingLevelMap: { medium: "medium", high: "high" },
        },
      ],
    };
    const service = await createModelService(
      {
        chat: {
          "openai:gpt-4o": {
            thinkingLevel: "high",
            thinkingLevelMap: { high: "high" },
          },
        },
      },
      undefined,
      provider,
    );

    const first = service.resolveChatModel("openai:gpt-4o");
    expect(chat).toHaveBeenCalledWith("gpt-4o", expect.objectContaining({ thinkingLevel: "high", thinkingLevelMap: { medium: "medium", high: "high" } }));
    expect(first.entry).toMatchObject({ thinkingLevel: "high", thinkingLevelMap: { medium: "medium", high: "high" } });
    first.entry.thinkingLevelMap!.high = "low";

    expect(service.resolveChatModel("openai:gpt-4o").entry.thinkingLevelMap).toEqual({ medium: "medium", high: "high" });
  });

  it("loads independent input and output modality arrays when their values are supported", async () => {
    const service = await createModelService({ chat: { "openai:gpt-4o": { modalities: { input: ["image"], output: ["text"] } } } });

    expect(service.resolveChatModel("openai:gpt-4o").entry.modalities).toEqual({ input: ["image"], output: ["text"] });
  });

  it("ignores invalid modality arrays without discarding valid independent values", async () => {
    const inputService = await createModelService({ chat: { "openai:gpt-4o": { modalities: { input: ["image"], output: ["unsupported"] } } } });
    const outputService = await createModelService({ chat: { "openai:gpt-4o": { modalities: { input: "image", output: ["text"] } } } });

    expect(inputService.resolveChatModel("openai:gpt-4o").entry.modalities).toEqual({ input: ["image"] });
    expect(outputService.resolveChatModel("openai:gpt-4o").entry.modalities).toEqual({ output: ["text"] });
  });

  it("keeps resolved modality arrays isolated from callers", async () => {
    const service = await createModelService({ chat: { "openai:gpt-4o": { modalities: { input: ["image"] } } } });

    const first = service.resolveChatModel("openai:gpt-4o");
    first.entry.modalities?.input.push("text");

    expect(service.resolveChatModel("openai:gpt-4o").entry.modalities?.input).toEqual(["image"]);
  });

  it("does not expose provider-declared image modalities without a models.json override", async () => {
    const path = await createModelsPath({});
    const service = await createModelService(JSON.parse(await readFile(path, "utf8")), path.slice(0, -"/models.json".length), createProviderWithImage());

    expect(service.resolveChatModel("openai:gpt-4o").entry.modalities?.input).toBeUndefined();
  });

  it("enables the selected vision model in a fresh instance with no models.json and routes its images natively", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yesimbot-vision-role-"));
    temporaryDirectories.push(directory);
    const provider = { ...createProvider(), chatCapabilities: () => ({ imageToolResult: "native" as const }) };
    const service = await createModelService({}, directory, provider, undefined, "openai:gpt-4o");
    const selected = service.resolveChatModel("openai:gpt-4o");
    expect(selected.entry.modalities?.input).toEqual(["text", "image"]);
    expect(resolveReadImagePolicy(selected, selected, true)).toEqual({ mode: "native" });
    expect(resolveReadImagePolicy(selected, selected, false)).toEqual({ mode: "unavailable" });
    expect(service.listChatModels()[0].config.modalities?.input).toContain("image");
    await expect(readFile(join(directory, "models.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a vision alias and preserves metadata without caption fallback for an unknown image transport", async () => {
    const service = await createModelService(
      {
        aliases: { eyesight: "openai:gpt-4o" },
        chat: { "openai:gpt-4o": { modalities: { output: ["text"] } } },
      },
      undefined,
      undefined,
      undefined,
      "eyesight",
    );
    const selected = service.resolveChatModel("eyesight");
    expect(selected.entry.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(resolveReadImagePolicy(selected, selected, true)).toEqual({ mode: "unavailable" });
  });

  it.each([{ input: [] }, { input: ["text"] }, { input: ["text", "image", "video"] }])(
    "does not replace explicitly configured modalities $input",
    async ({ input }) => {
      const service = await createModelService({ chat: { "openai:gpt-4o": { modalities: { input } } } }, undefined, undefined, undefined, "openai:gpt-4o");
      expect(service.resolveChatModel("openai:gpt-4o").entry.modalities?.input).toEqual(input);
    },
  );

  it("does not infer image capability for other models or retain the role after it is cleared", async () => {
    const provider = { ...createProvider(), chatModels: () => [{ id: "gpt-4o" }, { id: "other" }] };
    const configured = await createModelService({}, undefined, provider, undefined, "openai:gpt-4o");
    expect(configured.resolveChatModel("openai:other").entry.modalities).toBeUndefined();
    const cleared = await createModelService({}, undefined, provider, undefined, "");
    expect(cleared.resolveChatModel("openai:gpt-4o").entry.modalities).toBeUndefined();
  });

  it("combines explicit image and video choices without models.json, and keeps other models unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yesimbot-video-role-"));
    temporaryDirectories.push(directory);
    const provider = {
      ...createProvider(),
      chatModels: () => [{ id: "gpt-4o" }, { id: "other" }],
      chatCapabilities: () => ({ imageToolResult: "native" as const, videoInput: "native" as const }),
    };
    const service = await createModelService({}, directory, provider, undefined, "openai:gpt-4o", { chatModel: "openai:gpt-4o", videoInput: true });
    const selected = service.resolveChatModel("openai:gpt-4o");
    expect(selected.entry.modalities?.input).toEqual(["text", "image", "video"]);
    expect(resolveReadImagePolicy(selected, selected, true)).toEqual({ mode: "native" });
    expect(resolveReadVideoPolicy(selected, true)).toEqual({ mode: "native" });
    expect(service.resolveChatModel("openai:other").entry.modalities).toBeUndefined();
    await expect(readFile(join(directory, "models.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false, undefined])("only applies video input after explicit opt-in (%s), without enabling images", async (enabled) => {
    const service = await createModelService({ aliases: { primary: "openai:gpt-4o" } }, undefined, undefined, undefined, undefined, {
      chatModel: "primary",
      videoInput: enabled,
    });
    const selected = service.resolveChatModel("primary");
    expect(selected.entry.modalities?.input).toEqual(enabled ? ["text", "video"] : undefined);
    // Selecting a model never invents support for its API transport.
    expect(resolveReadVideoPolicy(selected, enabled === true)).toEqual({ mode: "unavailable" });
  });

  it.each([false, true])("keeps image routing for a model without metadata when video input is %s", async (videoInput) => {
    const modelId = "gemini-4-hydrogen-xhigh";
    const fullId = `antigravity-gemini:${modelId}`;
    const provider: ModelProvider = {
      ...createProvider(),
      id: "antigravity-gemini",
      chatModels: () => [{ id: modelId }],
      chatCapabilities: () => ({ imageToolResult: "native", videoInput: "native" }),
    };
    const service = await createModelService({ aliases: { primary: fullId } }, undefined, provider, undefined, "", { chatModel: "primary", videoInput });
    const primary = service.resolveChatModel("primary");

    expect(primary.entry.modalities?.input).toEqual(videoInput ? ["text", "video"] : undefined);
    expect(resolvePrimaryImageInput(primary)).toBe(true);
    expect(resolveReadImagePolicy(primary, undefined, true)).toEqual({ mode: "native" });
    expect(resolveReadImagePolicy(primary, undefined, false)).toEqual({ mode: "unavailable" });
    expect(resolveReadVideoPolicy(primary, videoInput)).toEqual({ mode: videoInput ? "native" : "unavailable" });
  });

  it.each([{ input: [] }, { input: ["text"] }, { input: ["text", "video"] }])(
    "keeps explicit image exclusions authoritative with video input enabled ($input)",
    async ({ input }) => {
      const provider: ModelProvider = { ...createProvider(), chatCapabilities: () => ({ imageToolResult: "native", videoInput: "native" }) };
      const service = await createModelService({ chat: { "openai:gpt-4o": { modalities: { input } } } }, undefined, provider, undefined, undefined, {
        chatModel: "openai:gpt-4o",
        videoInput: true,
      });
      const primary = service.resolveChatModel("openai:gpt-4o");

      expect(resolvePrimaryImageInput(primary)).toBe(false);
      expect(resolveReadImagePolicy(primary, undefined, true)).toEqual({ mode: "unavailable" });
    },
  );

  it.each(["unsupported", "unknown"] as const)(
    "does not substitute vision captions for a video-selected model on a %s image transport",
    async (imageToolResult) => {
      const provider: ModelProvider = {
        ...createProvider(),
        chatModels: () => [{ id: "gpt-4o" }, { id: "vision" }],
        chatCapabilities: () => ({ imageToolResult, videoInput: "native" }),
      };
      const service = await createModelService({}, undefined, provider, undefined, "openai:vision", { chatModel: "openai:gpt-4o", videoInput: true });
      const primary = service.resolveChatModel("openai:gpt-4o");
      const vision = service.resolveChatModel("openai:vision");

      expect(resolvePrimaryImageInput(primary)).toBe(false);
      expect(resolveReadImagePolicy(primary, undefined, true)).toEqual({ mode: "unavailable" });
      expect(resolveReadImagePolicy(primary, vision, true)).toEqual({ mode: "unavailable" });
      expect(resolveReadImagePolicy(primary, vision, false)).toEqual({ mode: "unavailable" });
    },
  );

  it.each([{ input: [] }, { input: ["text"] }, { input: ["text", "image"] }])(
    "retains explicit metadata $input even when video is enabled",
    async ({ input }) => {
      const service = await createModelService({ chat: { "openai:gpt-4o": { modalities: { input } } } }, undefined, undefined, undefined, undefined, {
        chatModel: "openai:gpt-4o",
        videoInput: true,
      });
      expect(service.resolveChatModel("openai:gpt-4o").entry.modalities?.input).toEqual(input);
    },
  );

  it("fails closed when a provider does not declare image tool-result support", async () => {
    const service = await createModelService({});

    expect(service.resolveChatModel("openai:gpt-4o").capabilities).toEqual({
      imageToolResult: "unknown",
      videoInput: "unknown",
      historyProjection: "default",
    });
  });

  it("propagates explicit unsupported image tool-result transport capabilities", async () => {
    const provider: ModelProvider = {
      ...createProvider(),
      chatCapabilities: vi.fn(() => ({ imageToolResult: "unsupported" as const })),
    };
    const service = await createModelService({}, undefined, provider);

    expect(service.resolveChatModel("openai:gpt-4o").capabilities).toEqual({
      imageToolResult: "unsupported",
      videoInput: "unknown",
      historyProjection: "default",
    });
    expect(provider.chatCapabilities).toHaveBeenCalledWith("gpt-4o");
  });

  it.each([
    [undefined, "unknown"],
    ["unknown", "unknown"],
    ["unsupported", "unsupported"],
    ["native", "native"],
    ["invalid", "unknown"],
  ])("normalizes explicit video transport %s without inferring from image support", async (declared, expected) => {
    const provider: ModelProvider = {
      ...createProviderWithImage(),
      chatCapabilities: vi.fn(() => ({ imageToolResult: "native", videoInput: declared }) as never),
    };
    const service = await createModelService({}, undefined, provider);
    const resolved = service.resolveChatModel("openai:gpt-4o");
    expect(resolved.capabilities.videoInput).toBe(expected);
    expect(resolved.capabilities.imageToolResult).toBe("native");
  });

  it("resolves provider-scoped history projection capabilities and defaults unknown providers", async () => {
    const provider: ModelProvider = {
      ...createProvider(),
      chatCapabilities: vi.fn(() => ({ imageToolResult: "native" as const, historyProjection: "gemini-native" as const })),
    };
    const service = await createModelService({}, undefined, provider);

    expect(service.resolveChatModel("openai:gpt-4o").capabilities.historyProjection).toBe("gemini-native");

    const defaultService = await createModelService({});
    expect(defaultService.resolveChatModel("openai:gpt-4o").capabilities.historyProjection).toBe("default");
  });

  it("resolves the configured auxiliary model with an explicit route", async () => {
    const service = await createModelService({}, undefined, undefined, "openai:gpt-4o");

    expect(service.resolveAuxiliaryModel("memory-summary")).toMatchObject({
      fullId: "openai:gpt-4o",
      route: "auxiliary",
      purpose: "memory-summary",
      source: "config.auxiliaryModel",
    });
  });

  it("fails closed when the auxiliary model is missing", async () => {
    const service = await createModelService({});

    expect(() => service.resolveAuxiliaryModel("utility")).toThrow("model_auxiliary_missing");
    try {
      service.resolveAuxiliaryModel("utility");
    } catch (error) {
      expect(error).toMatchObject({ name: "AppError", code: "model_auxiliary_missing", detail: "utility" });
    }
  });

  it("does not fall back to the registered chat model when the auxiliary model cannot resolve", async () => {
    const service = await createModelService({}, undefined, undefined, "openai:missing-model");

    expect(() => service.resolveAuxiliaryModel("utility")).toThrow("model_auxiliary_unresolvable");
    try {
      service.resolveAuxiliaryModel("utility");
    } catch (error) {
      expect(error).toMatchObject({ code: "model_auxiliary_unresolvable", detail: "utility openai:missing-model" });
    }
  });
  it("includes a provider tool set with the resolved chat model", async () => {
    const tools = { web_search: { type: "provider", id: "test.web_search", inputSchema: {} as never } } as ToolSet;
    const provider = { ...createProvider(), tools: vi.fn(() => tools) } as ModelProvider & { tools(modelId: string): ToolSet };
    const service = await createModelService({}, undefined, provider);

    const resolved = service.resolveChatModel("openai:gpt-4o");

    expect(provider.tools).toHaveBeenCalledWith("gpt-4o");
    expect(resolved.tools).toEqual(tools);
    expect(resolved.tools).not.toBe(tools);
  });
  it("wraps resolved chat models and emits their usage", async () => {
    const ctx = new TestEvents();
    const model = {
      specificationVersion: "v3",
      provider: "openai",
      modelId: "gpt-4o",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented");
      },
      async doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "finish", usage: { inputTokens: 3, outputTokens: 2 } });
              controller.close();
            },
          }),
        };
      },
    };
    const service = new ModelService(
      { baseDir: "/", emit: ctx.emit.bind(ctx) },
      { basePath: await createModelsPath({}).then((path) => path.slice(0, -"/models.json".length)) },
    );
    await service.start();
    service.register({ ...createProvider(), chat: () => model as never });
    let event: unknown;
    ctx.on("yesimbot/model-usage" as never, (value: unknown) => {
      event = value;
    });
    let wrapped = 0;
    service.middleware({
      specificationVersion: "v3",
      wrapStream: async ({ doStream }) => {
        wrapped++;
        return doStream();
      },
    });

    const context = { type: "guild" as const, platform: "onebot", channelId: "123", guildId: "123" };
    const result = await (service.resolveChatModel("openai:gpt-4o", context).model as unknown as typeof model).doStream({} as never);
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) continue;

    expect(wrapped).toBe(1);
    expect(event).toMatchObject({ context, modelId: "openai:gpt-4o", providerId: "openai", providerModelId: "gpt-4o", kind: "chat" });
  });
});
