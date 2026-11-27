import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agents } from "../src/agents/index.js";
import type { ResourceReadResult } from "../src/agents/tools.js";
import type { ChannelContext } from "../src/channels/index.js";
import { YesImBotCore } from "../src/core.js";
import type { ChatModelModality } from "../src/models/config.js";
import { ChannelResources } from "../src/resources/index.js";
import type { TaskHost } from "../src/tasks/manager.js";
import type { TaskRecord } from "../src/tasks/store.js";
import { TestEvents, testAccount } from "./helpers/index.js";

const directories: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=", "base64");
const scope: ChannelContext = { type: "direct", platform: "test", channelId: "channel", selfId: "bot", userId: "user" };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("background-task image input", () => {
  it.each<{
    name: string;
    enabled: boolean;
    transport: "native" | "unsupported" | "unknown";
    input?: ChatModelModality[];
    expected: "native" | "unavailable";
  }>([
    { name: "video-derived metadata", enabled: true, transport: "native", expected: "native" },
    { name: "explicit image capability", enabled: true, transport: "native", input: ["text", "image"], expected: "native" },
    { name: "disabled image input", enabled: false, transport: "native", expected: "unavailable" },
    { name: "explicit text-only metadata", enabled: true, transport: "native", input: ["text"], expected: "unavailable" },
    { name: "explicit video-only metadata", enabled: true, transport: "native", input: ["text", "video"], expected: "unavailable" },
    { name: "explicit empty metadata", enabled: true, transport: "native", input: [], expected: "unavailable" },
    { name: "unsupported transport", enabled: true, transport: "unsupported", input: ["image"], expected: "unavailable" },
    { name: "unknown transport", enabled: true, transport: "unknown", input: ["image"], expected: "unavailable" },
  ])("uses the shared policy for $name", async ({ enabled, transport, input, expected }) => {
    const path = await mkdtemp(join(tmpdir(), "yesimbot-task-image-"));
    directories.push(path);
    await writeFile(join(path, "models.json"), JSON.stringify(input === undefined ? {} : { chat: { "test:model": { modalities: { input } } } }));
    const service = new YesImBotCore({
      baseDir: path,
      config: {
        basePath: path,
        chatModel: "test:model",
        imageInput: enabled,
        videoInput: true,
      },
      events: new TestEvents(),
      account: () => testAccount(scope.platform, scope.selfId),
    });
    await service.model.start();
    service.model.register({
      id: "test",
      capabilities: { chat: true, embedding: false },
      chatModels: () => [{ id: "model" }],
      embeddingModels: () => [],
      chat: () => ({}) as never,
      chatCapabilities: () => ({ imageToolResult: transport }),
    });
    const resources = new ChannelResources(path, enabled);
    resources.use({ scheme: "fixture", prompt: "test image", setup: async () => ({ bytes: png, mediaType: "image/png" }) });
    const internal = service as unknown as { channels: { storedContext: unknown; resolve: unknown } };
    internal.channels.storedContext = vi.fn(async () => scope);
    internal.channels.resolve = vi.fn(async () => ({ conversation: { currentSessionId: () => "session" }, resources }));
    const host = (service.tasks as unknown as { host: TaskHost }).host;
    const setup = vi.spyOn(service.agent as Agents, "setup");
    const record: TaskRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      channel: "channel",
      session: "session.jsonl",
      key: "image",
      kind: "content",
      instruction: "inspect the image",
      status: "queued",
      createdAt: 0,
      updatedAt: 0,
    };
    const prepared = await host.prepare(record, new AbortController().signal);
    try {
      expect(setup).toHaveBeenCalledWith(scope, expect.anything(), expect.objectContaining({ nativeImageInput: { mode: expected } }));
      const read = prepared.config.tools!.find((tool) => tool.name === "read") as AgentTool<{ uri: string }, ResourceReadResult>;
      const args = { uri: "fixture:///image.png" };
      const result = await read.execute(args, { turnId: "turn", toolCallId: "read", toolName: "read", messages: [] } as never);
      expect(result.imageMode).toBe(expected);
      const projected = await read.toModelOutput!({ toolCallId: "read", input: args, output: result });
      if (expected === "native") {
        expect(result.error).toBeUndefined();
        expect(projected).toMatchObject({
          type: "content",
          value: expect.arrayContaining([{ type: "image-data", data: png.toString("base64"), mediaType: "image/png" }]),
        });
        expect(JSON.stringify(result)).not.toContain(png.toString("base64"));
        await prepared.release?.();
        const released = await read.toModelOutput!({ toolCallId: "read", input: args, output: result });
        expect(released.type).toBe("json");
        expect(released).toMatchObject({ value: { imageMode: "unavailable", error: "image_projection_unavailable" } });
        expect(JSON.stringify(released)).not.toContain(png.toString("base64"));
      } else {
        expect(result.error).toBe("image_input_unavailable");
        expect(projected.type).toBe("json");
      }
    } finally {
      await prepared.release?.();
      await service.tasks.stop();
      service.model.stop();
    }
  });
});
