import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { EphemeralImageProjectionStore, type AgentTool } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadTool } from "../../../core/src/agents/tools.js";
import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { ChannelResources } from "../../../core/src/resources/index.js";
import { PNG_BYTES } from "../../../core/tests/helpers/index.js";
import { createWorkspaceComputerTools } from "../../../plugins/workspace/src/computer.js";
import { registerWith } from "./register.js";

const roots: string[] = [];
const base64 = Buffer.from(PNG_BYTES).toString("base64");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registeredModel(format: "chat" | "responses", placement?: "tool-output" | "user-message") {
  const register = vi.fn(() => () => undefined);
  registerWith(
    {
      id: "task-provider",
      apiKey: "test",
      baseURL: "https://fixture.invalid/v1",
      format,
      chatModels: [{ id: "selected-task-model" }],
      embeddingModels: [],
      ...(placement === undefined ? {} : { imageToolResultPlacement: placement }),
    },
    register as never,
  );
  const provider = register.mock.calls[0]![0] as {
    chat(id: string): LanguageModelV3;
    chatCapabilities(id: string): { imageToolResult: string };
  };
  expect(provider.chatCapabilities("selected-task-model")).toEqual({ imageToolResult: "native" });
  return provider.chat("selected-task-model");
}

async function imageTool(name: "read" | "computer_ui", projection: EphemeralImageProjectionStore): Promise<{ tool: AgentTool; input: object }> {
  if (name === "read") {
    const root = await mkdtemp(join(tmpdir(), "native-image-transport-"));
    roots.push(root);
    const resources = new ChannelResources(root, true);
    const id = await resources.assets.put(PNG_BYTES);
    return { tool: createReadTool(resources, { mode: "native" }, projection), input: { uri: `asset://${id}` } };
  }
  const tools = createWorkspaceComputerTools(
    {
      invoke: vi.fn(async () => ({ status: "succeeded", output: { text: "current desktop", data: base64, mediaType: "image/png" } })),
      activity: new ComputerActivity(),
    } as never,
    { platform: "test", channelId: "channel", type: "direct" },
    { deviceId: "device" },
    projection,
    (tool) => tool === "computer_ui",
    undefined,
    { mode: "native" },
  );
  return { tool: tools[0]!, input: { tool: "screenshot" } };
}

describe("registered OpenAI native image transport", () => {
  it.each([false, true])("keeps parallel tool receipts contiguous before promoting their images (separate=%s)", async (separate) => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        body = JSON.parse(await new Response(init?.body ?? null).text());
        throw new Error("captured parallel image request");
      }),
    );
    const secondImage = Buffer.concat([PNG_BYTES, Buffer.from([0])]).toString("base64");
    const receipt = (id: string, data: string) => ({
      type: "tool-result" as const,
      toolCallId: id,
      toolName: "computer_ui",
      output: { type: "content" as const, value: [{ type: "image-data" as const, data, mediaType: "image/png" }] },
    });
    const receipts = [receipt("screen-A", base64), receipt("screen-B", secondImage)];
    const prompt: LanguageModelV3Prompt = [
      { role: "user", content: [{ type: "text", text: "Inspect both screenshots." }] },
      { role: "assistant", content: receipts.map((item) => ({ type: "tool-call", toolCallId: item.toolCallId, toolName: item.toolName, input: {} })) },
      ...(separate ? receipts.map((item) => ({ role: "tool" as const, content: [item] })) : [{ role: "tool" as const, content: receipts }]),
      { role: "assistant", content: [{ type: "text", text: "Both observations received." }] },
    ];
    await expect(registeredModel("chat").doGenerate({ prompt })).rejects.toThrow("captured parallel image request");
    const messages = body!.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user", "assistant"]);
    expect(messages.slice(2, 4).map((message) => message.tool_call_id)).toEqual(["screen-A", "screen-B"]);
    expect(JSON.stringify(messages.slice(2, 4))).not.toContain(base64);
    expect(messages[4]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining('"toolCallId":"screen-A"') },
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
        { type: "text", text: expect.stringContaining('"toolCallId":"screen-B"') },
        { type: "image_url", image_url: { url: `data:image/png;base64,${secondImage}` } },
      ],
    });
  });

  it.each([
    ["chat", undefined, "read"],
    ["chat", undefined, "computer_ui"],
    ["chat", "tool-output", "computer_ui"],
    ["responses", undefined, "computer_ui"],
    ["responses", "user-message", "computer_ui"],
  ] as const)("sends %s/%s %s pixels to the selected task model through the real SDK", async (format, placement, name) => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        requests.push(JSON.parse(await new Response(init?.body ?? null).text()));
        throw new Error("captured native image request");
      }),
    );
    const projection = new EphemeralImageProjectionStore();
    try {
      const { tool, input } = await imageTool(name, projection);
      const output = await tool.execute(input, { runtime: { id: "runtime" }, toolCallId: "image-call", turnId: "turn", messages: [] } as never);
      const projected = await tool.toModelOutput!({ toolCallId: "image-call", input, output });
      const prompt: LanguageModelV3Prompt = [
        { role: "user", content: [{ type: "text", text: "Inspect these pixels in this task." }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "image-call", toolName: name, input }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "image-call", toolName: name, output: projected }] },
      ];
      await expect(registeredModel(format, placement).doGenerate({ prompt })).rejects.toThrow("captured native image request");
      expect(requests).toHaveLength(1);
      const body = requests[0]!;
      expect(body.model).toBe("selected-task-model");
      if (format === "chat") {
        const messages = body.messages as Array<Record<string, unknown>>;
        const at = messages.findIndex((message) => message.role === "tool");
        expect(messages[at]?.content).not.toContain(base64);
        expect(messages[at]?.content).not.toContain("image-data");
        expect(messages[at + 1]).toMatchObject({
          role: "user",
          content: [
            { type: "text", text: expect.stringContaining('"toolCallId":"image-call"') },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        });
      } else {
        const input = body.input as Array<Record<string, unknown>>;
        const at = input.findIndex((item) => item.type === "function_call_output");
        const media = placement === "user-message" ? input[at + 1]?.content : input[at]?.output;
        expect(media).toEqual(expect.arrayContaining([expect.objectContaining({ type: "input_image", image_url: `data:image/png;base64,${base64}` })]));
        if (placement === "user-message") expect(JSON.stringify(input[at]?.output)).not.toContain(base64);
      }
      expect(JSON.stringify(prompt)).toContain("image-data"); // Request-only promotion must not rewrite durable/live pairing.
    } finally {
      projection.clearAll();
    }
  });
});
