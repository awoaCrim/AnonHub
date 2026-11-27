import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { detectImageType } from "@yesimbot/foundation";
import { configForm, configureLogging, parseConfig, type LogRecord } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RESOURCE_MAX_BYTES } from "../../../core/src/resources/index.js";
import { createOpenAIImageAdapter } from "../../../providers/model-provider/src/images.js";
import { identity } from "../../../tests/tool-policy.js";
import { extension, moduleConfig } from "../src/index.js";
import { PNG_BYTES } from "./helpers.js";

type RegisteredChannelAgent = {
  name: string;
  tools: () => Array<{ name: string; description?: string; execute: (input: never, context: never) => Promise<unknown> }>;
  onTurnFinish?: (result: unknown, context: { turnId: string }) => void;
};

type RegisteredChannelPlugin = {
  setup(scope: unknown, bot: unknown, runtime?: { imageProjection: EphemeralImageProjectionStore }): Promise<RegisteredChannelAgent | null>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function runtime(config: Record<string, unknown>, purposes?: { imageModel?: string; imageEditModel?: string; chatModel?: string }) {
  const disposeAgent = vi.fn();
  const agent = { use: vi.fn(() => disposeAgent) };
  const artifactWriter = { put: vi.fn(async () => "artifact://fixture/output") };
  const resource = {
    get: vi.fn(async () => ({
      artifacts: { forTool: vi.fn(() => artifactWriter) },
      maxBytes: RESOURCE_MAX_BYTES,
      detectImageMediaType: detectImageType,
      openStrict: vi.fn(async () => ({ bytes: PNG_BYTES, mediaType: "image/png", filename: "source.png" })),
    })),
  };
  const model = {
    resolveImage: vi.fn((fullId: string) =>
      createOpenAIImageAdapter({ apiKey: "connection-key", baseURL: "https://shared.invalid/v1", modelId: fullId.slice(fullId.indexOf(":") + 1) }),
    ),
    resolveChatModel: vi.fn(),
  };
  const warn = vi.fn();
  const core = { identity, agent, resource, config: purposes ?? {}, model };
  const normalized = parseConfig(moduleConfig, config);
  const undo = extension.start({ config: extension.parse(config), core } as never) as (() => void) | undefined;
  const dispose = undo;
  return { agent, resource, dispose, disposeAgent, normalized, model, warn };
}

describe("image-tools configuration", () => {
  it("has no settings of its own and keeps unknown keys", () => {
    const form = configForm(moduleConfig.schema) as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(form.properties ?? {})).toEqual([]);
    expect(form.required ?? []).toEqual([]);
    expect(parseConfig(moduleConfig, {})).toEqual({});
    expect(parseConfig(moduleConfig, { apiKey: "leftover" })).toEqual({ apiKey: "leftover" });
  });

  it("registers its tools; which chats may use them is up to the tool policy", () => {
    const configured = runtime({}, { imageModel: "shared:image-model" });
    expect(configured.agent.use).toHaveBeenCalledOnce();
  });

  it("does not use chat credentials or leftover keys when the image purpose is empty", () => {
    const configured = runtime({ apiKey: "ignored", model: "ignored" }, { imageModel: "", chatModel: "chat:main" });
    expect(configured.agent.use).not.toHaveBeenCalled();
    expect(configured.model.resolveChatModel).not.toHaveBeenCalled();
    expect(configured.model.resolveImage).not.toHaveBeenCalled();
    expect(runtime({}, { chatModel: "chat:main" }).agent.use).not.toHaveBeenCalled();
  });

  it("registers canonical image tools without plugin-owned credentials", () => {
    expect(runtime({}, { imageModel: "shared:image-model" }).agent.use).toHaveBeenCalledOnce();
  });

  it("leaves chat available when a selected image connection is unavailable, without fallback", async () => {
    const records: LogRecord[] = [];
    configureLogging({ sink: (record) => records.push(record) });
    const configured = runtime({ apiKey: "ignored", model: "ignored" }, { imageModel: "missing:image-model", chatModel: "chat:main" });
    configured.model.resolveImage.mockImplementation(() => {
      throw new Error("unavailable");
    });
    const plugin = configured.agent.use.mock.calls[0]?.[0] as RegisteredChannelPlugin;
    expect(await plugin.setup({}, {})).toBeNull();
    expect(configured.resource.get).not.toHaveBeenCalled();
    expect(configured.model.resolveChatModel).not.toHaveBeenCalled();
    expect(records.filter((record) => record.event === "image_tools.model_unavailable")).toHaveLength(1);
  });
});

describe("image-tools registration", () => {
  it.each([undefined, "shared:edit-model", " "])("uses shared connection adapters for all image paths with edit purpose %s", async (imageEditModel) => {
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const configured = runtime({}, { imageModel: "shared:image-model", imageEditModel });
    const plugin = configured.agent.use.mock.calls[0]?.[0] as RegisteredChannelPlugin;
    const channel = await plugin.setup({ platform: "onebot", channelId: "group", selfId: "bot", type: "guild", guildId: "group" }, {});
    const [generate, edit] = await channel!.tools();
    const context = (toolCallId: string) => ({ toolCallId, turnId: "shared", messages: [] }) as never;
    await expect(generate!.execute({ subjectType: "generic", prompt: "new image" } as never, context("new"))).resolves.toMatchObject({
      ok: true,
      model: "shared:image-model",
    });
    const editRef = imageEditModel?.trim() || "shared:image-model";
    await expect(
      generate!.execute(
        { subjectType: "specific", prompt: "same subject", referenceUris: ["asset://0123456789abcdef0123456789abcdef"] } as never,
        context("reference"),
      ),
    ).resolves.toMatchObject({ ok: true, model: editRef });
    await expect(edit!.execute({ uri: "asset://0123456789abcdef0123456789abcdef", prompt: "edit" } as never, context("edit"))).resolves.toMatchObject({
      ok: true,
      model: editRef,
    });
    expect(requests.map((request) => [request.url, request.body.model, request.authorization])).toEqual([
      ["https://shared.invalid/v1/images/generations", "image-model", "Bearer connection-key"],
      ["https://shared.invalid/v1/images/edits", editRef.slice(7), "Bearer connection-key"],
      ["https://shared.invalid/v1/images/edits", editRef.slice(7), "Bearer connection-key"],
    ]);
    expect(requests[1]!.body.images).toEqual([{ image_url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}` }]);
    expect(configured.model.resolveChatModel).not.toHaveBeenCalled();
    expect(configured.model.resolveImage.mock.calls.map(([id]) => id)).toEqual(
      imageEditModel?.trim() ? ["shared:image-model", "shared:edit-model"] : ["shared:image-model"],
    );
    channel?.onTurnFinish?.({}, { turnId: "shared" });
  });

  it("registers only generate_image and edit_image and disposes cleanly", async () => {
    const configured = runtime({}, { imageModel: "shared:image-model" });
    const plugin = configured.agent.use.mock.calls[0]?.[0] as RegisteredChannelPlugin;
    const imageProjection = new EphemeralImageProjectionStore();
    const channelPlugin = await plugin.setup({ type: "guild", platform: "onebot", channelId: "group", guildId: "group" }, {}, { imageProjection });

    expect(configured.resource.get).toHaveBeenCalledWith({ type: "guild", platform: "onebot", channelId: "group", guildId: "group" });
    expect(channelPlugin?.name).toBe("image-tools");
    const tools = (await channelPlugin?.tools()) ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(["generate_image", "edit_image"]);
    expect(tools.every((tool) => tool.description?.includes("每轮合计最多输出 3 张图片"))).toBe(true);
    expect(tools.find((tool) => tool.name === "edit_image")?.description).toContain("用户消息中的 [图片：asset://<32 位十六进制 id>] 就是可编辑的当前频道图片");

    configured.dispose?.();
    expect(configured.disposeAgent).toHaveBeenCalledOnce();
  });

  it("shares a three-output budget across generation and editing, then clears it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const configured = runtime({}, { imageModel: "shared:image-model" });
    const plugin = configured.agent.use.mock.calls[0]?.[0] as RegisteredChannelPlugin;
    const imageProjection = new EphemeralImageProjectionStore();
    const channelPlugin = await plugin.setup(
      { type: "guild", platform: "onebot", channelId: "group", guildId: "group", selfId: "bot" },
      {},
      { imageProjection },
    );
    const tools = (await channelPlugin?.tools()) ?? [];
    const generate = tools.find((tool) => tool.name === "generate_image");
    const edit = tools.find((tool) => tool.name === "edit_image");
    const context = (toolCallId: string) => ({ toolCallId, turnId: "turn-1", abortSignal: undefined, messages: [] }) as never;

    await expect(generate?.execute({ subjectType: "generic", prompt: "one" } as never, context("one"))).resolves.toMatchObject({ ok: true });
    await expect(edit?.execute({ uri: "artifact://generate_image/source", prompt: "two" } as never, context("two"))).resolves.toMatchObject({ ok: true });
    await expect(generate?.execute({ subjectType: "generic", prompt: "three" } as never, context("three"))).resolves.toMatchObject({ ok: true });
    await expect(edit?.execute({ uri: "artifact://generate_image/source", prompt: "four" } as never, context("four"))).resolves.toMatchObject({
      ok: false,
      error: { code: "image_budget_exhausted" },
    });
    expect(fetch).toHaveBeenCalledTimes(3);

    channelPlugin?.onTurnFinish?.({}, { turnId: "turn-1" });
    await expect(edit?.execute({ uri: "artifact://generate_image/source", prompt: "after finish" } as never, context("five"))).resolves.toMatchObject({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    imageProjection.clearAll();
  });
});
