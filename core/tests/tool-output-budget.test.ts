import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  createAgent,
  createFileToolJournal,
  createMemoryStorage,
  createUserMessage,
  EphemeralImageProjectionStore,
  jsonSchema,
  type AgentTool,
  type AgentToolSet,
  type ToolHookContext,
} from "@yesimbot/agent-runtime";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { toolOutputBudget, TOOL_OUTPUT_BYTES } from "../src/tools/output-budget.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "output-budget-"));
  dirs.push(dir);
  return { dir, plugin: toolOutputBudget(dir) };
}
const hook = {} as ToolHookContext;
const call = (result: unknown) => ({ toolCallId: "call", toolName: "computer_exec", args: {}, result, isError: false });
it("bounds a single huge JSONL line, preserves full output and reads Unicode pages without replay", async () => {
  const { dir, plugin } = await fixture();
  const original = { status: "succeeded", output: { exitCode: 0, stdout: ("历史记录".repeat(10000) + "\n").repeat(11), stderr: "", truncated: false } };
  const patch = await plugin.afterToolCall!(call(original), hook);
  const result = patch!.result as { outputId: string; truncated: boolean; exitCode: number };
  expect(result.truncated).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
  const saved = await readFile(join(dir, result.outputId + ".json"));
  expect(JSON.parse(saved.toString())).toEqual(original);
  const read = (plugin.tools as AgentToolSet)[0]!;
  let offset = 0,
    text = "";
  while (offset < 10000) {
    const page = await read.execute({ id: result.outputId, offset, limit: 101 }, {} as never);
    expect(page.text).not.toContain("\ufffd");
    text += page.text;
    offset = page.nextOffset;
  }
  expect(text).toBe(saved.subarray(0, offset).toString());
  expect(await read.execute({ id: "../escape", offset: 0 }, {} as never)).toEqual({ error: "invalid_output_range" });
  const other = await fixture();
  expect(await (other.plugin.tools as AgentToolSet)[0]!.execute({ id: result.outputId }, {} as never)).toMatchObject({ error: "output_unavailable" });
});
// Preview records, 2026-11-19: round offsets (12000, 20000) inside Chinese text were refused with no explanation.
it("starts a page at the next character when the offset falls inside one, and explains an offset past the end", async () => {
  const { dir, plugin } = await fixture();
  const original = { status: "succeeded", output: { exitCode: 0, stdout: "历史记录".repeat(20000), stderr: "", truncated: false } };
  const result = (await plugin.afterToolCall!(call(original), hook))!.result as { outputId: string };
  const saved = await readFile(join(dir, result.outputId + ".json"));
  const read = (plugin.tools as AgentToolSet)[0]!;
  // Find a byte offset inside a three-byte character.
  let inside = 12000;
  while ((saved[inside]! & 0xc0) !== 0x80) inside++;
  const page = await read.execute({ id: result.outputId, offset: inside, limit: 300 }, {} as never);
  expect(page.offset).toBeGreaterThan(inside);
  expect(page.offset - inside).toBeLessThanOrEqual(3);
  expect(page.text).not.toContain("\ufffd");
  expect(page.text).toBe(saved.subarray(page.offset, page.nextOffset).toString());
  expect(await read.execute({ id: result.outputId, offset: saved.length + 10 }, {} as never)).toMatchObject({
    error: "invalid_output_offset",
    totalBytes: saved.length,
    message: expect.stringContaining("nextOffset"),
  });
});
it("does not change small outcomes or image payloads and preserves explicit failures", async () => {
  const { plugin } = await fixture();
  expect(await plugin.afterToolCall!(call({ status: "unknown", code: "interrupted" }), hook)).toBeUndefined();
  expect(await plugin.afterToolCall!(call({ type: "image", data: "x".repeat(50000) }), hook)).toBeUndefined();
  const out = await plugin.afterToolCall!(call({ status: "succeeded", output: { exitCode: 1, stderr: "E".repeat(50000) } }), hook);
  expect(out!.result).toMatchObject({ exitCode: 1, truncated: true });
});
it("bounds escaped text pages and reports archive failures without throwing/repeating work", async () => {
  const { dir, plugin } = await fixture();
  const patch = await plugin.afterToolCall!(call({ output: "\0".repeat(30000) }), hook);
  const result = patch!.result as { outputId: string };
  const page = await (plugin.tools as AgentToolSet)[0]!.execute({ id: result.outputId, limit: 8192 }, {} as never);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
  const broken = toolOutputBudget(join(dir, result.outputId + ".json", "not-directory"));
  expect((await broken.afterToolCall!(call("x".repeat(100000)), hook))!.result).toMatchObject({ truncated: true, fullOutputSaved: false });
  expect(await readdir(dir)).toHaveLength(1);
});
it("preserves custom projection contracts for tools with staged media or structured formatters", async () => {
  const { dir, plugin } = await fixture();
  const project = vi.fn(async ({ output }) => {
    expect(output).toEqual({ text: "x".repeat(50000) });
    return { type: "text" as const, value: "projected" };
  });
  const original = { name: "custom", toModelOutput: project } as AgentTool;
  const tools = (await plugin.extendTools!([original], {} as never))!;
  expect(await plugin.afterToolCall!({ ...call({ text: "x".repeat(50000) }), toolName: "custom" }, hook)).toBeUndefined();
  expect(await tools[0]!.toModelOutput!({ toolCallId: "call", input: {}, output: { text: "x".repeat(50000) } })).toEqual({ type: "text", value: "projected" });
  expect(original.toModelOutput).toBe(project);
  expect(project).toHaveBeenCalledTimes(1);
  expect(await readdir(dir)).toEqual([]);
});

it("keeps ordinary tools on the raw-result guard without adding a projection", async () => {
  const { dir, plugin } = await fixture();
  const tools = (await plugin.extendTools!([{ name: "computer_exec", execute: async () => "done" } as AgentTool], {} as never))!;
  expect(tools[0]!.toModelOutput).toBeUndefined();
  const patch = await plugin.afterToolCall!(call({ status: "succeeded", output: { stdout: "x".repeat(50000), exitCode: 0 } }), hook);
  expect(patch?.result).toMatchObject({ truncated: true, exitCode: 0 });
  expect(await readdir(dir)).toHaveLength(1);
});

it("does not archive or modify an image-only projection", async () => {
  const { dir, plugin } = await fixture();
  const image = { type: "image-data" as const, data: "AQID".repeat(20000), mediaType: "image/png" };
  const original = { type: "content" as const, value: [image] };
  const tools = (await plugin.extendTools!([{ name: "image", toModelOutput: () => original }] as AgentToolSet, {} as never))!;
  expect(await tools[0]!.toModelOutput!({ toolCallId: "image", input: {}, output: {} })).toBe(original);
  expect(await readdir(dir)).toEqual([]);
});

it.each(["text", "error-text", "json", "error-json"] as const)("bounds custom %s without changing its output protocol", async (type) => {
  const { dir, plugin } = await fixture();
  const value = type.endsWith("json") ? { full: "历史\0".repeat(20000) } : "历史\0".repeat(20000);
  const tools = (await plugin.extendTools!([{ name: "custom", toModelOutput: async () => ({ type, value }) }] as AgentToolSet, {} as never))!;
  const result = await tools[0]!.toModelOutput!({
    toolCallId: "call",
    input: {},
    output: { status: "failed", error: { code: "SCREEN_DENIED", message: "Screen recording access denied" } },
  });
  expect(result.type).toBe(type);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
  const preview = JSON.parse(typeof result.value === "string" ? result.value : JSON.stringify(result.value));
  expect(preview).toMatchObject({
    truncated: true,
    fullOutputSaved: true,
    metadata: { status: "failed", error: { code: "SCREEN_DENIED", message: "Screen recording access denied" } },
  });
  expect(JSON.parse(await readFile(join(dir, preview.outputId + ".json"), "utf8"))).toEqual(value);
  expect(JSON.stringify(preview)).not.toContain("\ufffd");
});

it("preserves an error projection even when its raw result has no structured error metadata", async () => {
  const { plugin } = await fixture();
  const tools = (await plugin.extendTools!(
    [{ name: "screen", toModelOutput: () => ({ type: "error-text", value: "Screen capture failed: " + "x".repeat(50000) }) }] as AgentToolSet,
    {} as never,
  ))!;
  const result = await tools[0]!.toModelOutput!({ toolCallId: "screen", input: {}, output: "opaque result" });
  expect(result.type).toBe("error-text");
  if (result.type !== "error-text") throw Error("error-text expected");
  expect(JSON.parse(result.value)).toMatchObject({ isError: true, truncated: true, head: expect.stringContaining("Screen capture failed") });
});

it("bounds all projected text together while preserving native media and errors outside the preview", async () => {
  const { dir, plugin } = await fixture();
  const image = { type: "image-data" as const, data: "AQID".repeat(20000), mediaType: "image/png" };
  const texts = [
    { type: "text" as const, text: "header".repeat(2000) },
    {
      type: "text" as const,
      text: JSON.stringify({ tree: "前".repeat(5000), error: { code: "AMBIGUOUS_TARGET", message: "目标不唯一" }, tail: "后".repeat(5000) }),
    },
    { type: "text" as const, text: "footer".repeat(2000) },
  ];
  const raw = {
    status: "succeeded",
    width: 1920,
    height: 1080,
    coordinates: "截图坐标 0..1000 映射至 1920×1080",
    screenshot: "1920×1080 pixels",
    isError: true,
  };
  const original = { type: "content" as const, value: [texts[0]!, image, texts[1]!, texts[2]!] };
  const tools = (await plugin.extendTools!([{ name: "computer_ui", toModelOutput: () => original }] as AgentToolSet, {} as never))!;
  const result = await tools[0]!.toModelOutput!({ toolCallId: "ui", input: {}, output: raw });
  expect(result.type).toBe("content");
  if (result.type !== "content") throw Error("content expected");
  expect(result.value.filter((part) => part.type !== "text")).toEqual([image]);
  expect(result.value[1]).toBe(image);
  const compactTexts = result.value.filter((part) => part.type === "text");
  expect(Buffer.byteLength(JSON.stringify(compactTexts))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
  const preview = JSON.parse(compactTexts[0]!.text);
  expect(preview).toMatchObject({
    status: "succeeded",
    isError: true,
    truncated: true,
    metadata: { ...raw, projection: [{ error: { code: "AMBIGUOUS_TARGET", message: "目标不唯一" } }] },
  });
  const saved = await readFile(join(dir, preview.outputId + ".json"), "utf8");
  expect(JSON.parse(saved)).toEqual(texts);
  expect(saved).not.toContain(image.data);
  expect(original.value).toHaveLength(4);
});

it("keeps later sequence failures and bounds oversized diagnostic metadata", async () => {
  const { plugin } = await fixture();
  const text = JSON.stringify({
    completed: 40,
    failedAt: 40,
    results: [
      ...Array.from({ length: 40 }, () => ({ isError: false, text: "ok" })),
      { isError: true, text: JSON.stringify({ ok: false, error: { code: "STALE_REF", message: "Screen reference expired " + "x".repeat(100000) } }) },
    ],
  });
  const raw = { status: "succeeded", output: { isError: true, text }, recovery: "先 snapshot 获取新引用；动作未重试。" };
  const tools = (await plugin.extendTools!(
    [{ name: "computer_ui", toModelOutput: () => ({ type: "content", value: [{ type: "text", text: JSON.stringify(raw) }] }) }] as AgentToolSet,
    {} as never,
  ))!;
  const result = await tools[0]!.toModelOutput!({ toolCallId: "sequence", input: {}, output: raw });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
  if (result.type !== "content" || result.value[0]!.type !== "text") throw Error("text expected");
  const preview = JSON.parse(result.value[0]!.text);
  expect(preview).toMatchObject({
    isError: true,
    metadata: {
      recovery: raw.recovery,
      output: {
        isError: true,
        text: { completed: 40, failedAt: 40, results: [{ index: 40, isError: true, text: { ok: false, error: { code: "STALE_REF" } } }] },
      },
    },
  });
});

it.each([false, true])("bounds the real Agent projection without replay or media leakage (archive unavailable=%s)", async (archiveUnavailable) => {
  const { dir } = await fixture();
  const archive = join(dir, "output");
  if (archiveUnavailable) await writeFile(archive, "occupied");
  const budget = toolOutputBudget(archive);
  const requests: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    async doStream(options) {
      requests.push(options);
      const first = requests.length === 1;
      const chunks: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (first) chunks.push({ type: "tool-call", toolCallId: "ui-call", toolName: "computer_ui", input: "{}" });
      else chunks.push({ type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: "done" }, { type: "text-end", id: "answer" });
      chunks.push({
        type: "finish",
        finishReason: { unified: first ? "tool-calls" : "stop", raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: first ? 0 : 1, reasoning: 0 } },
      });
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=", "base64");
  const images = new EphemeralImageProjectionStore();
  const original = { status: "succeeded", text: "界面观察".repeat(5000), width: 1920, height: 1080, coordinates: "0..1000", isError: false };
  const execute = vi.fn(async (_input, context) => {
    images.stage({ toolCallId: context.toolCallId, turnId: context.turnId, bytes: png, mediaType: "image/png" });
    return original;
  });
  const projection = vi.fn(async ({ output, toolCallId }) => {
    expect(output).toBe(original);
    const image = images.get(toolCallId);
    expect(image).toBeDefined();
    return {
      type: "content" as const,
      value: [
        { type: "text" as const, text: JSON.stringify(output) },
        { type: "image-data" as const, data: Buffer.from(image!.bytes).toString("base64"), mediaType: image!.mediaType },
      ],
    };
  });
  const storage = createMemoryStorage();
  const agent = createAgent({
    model,
    storage,
    toolJournal: createFileToolJournal(join(dir, "journal")),
    tools: [{ name: "computer_ui", inputSchema: jsonSchema({ type: "object", properties: {} }), execute, toModelOutput: projection }],
    plugins: [budget, { name: "release-images", onTurnFinish: ({ turnId }) => images.clearTurn(turnId) }],
  });
  try {
    const events = await Array.fromAsync(agent.run(createUserMessage("inspect")));
    expect(requests).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    // The SDK projects the live tool response and the collected response separately.
    expect(projection).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "tool.failed")).toBe(false);
    const prompt = JSON.stringify(requests[1]!.prompt);
    expect(prompt).toContain(png.toString("base64"));
    const toolResult = requests[1]!.prompt.flatMap((message) => (message.role === "tool" ? message.content : [])).find((part) => part.type === "tool-result");
    expect(toolResult).toBeDefined();
    const projected = toolResult!.output;
    if (projected.type !== "content") throw Error("native content expected");
    const texts = projected.value.filter((part) => part.type === "text");
    expect(Buffer.byteLength(JSON.stringify(texts))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
    const preview = JSON.parse(texts[0]!.text);
    expect(preview).toMatchObject({
      fullOutputSaved: !archiveUnavailable,
      metadata: { status: "succeeded", coordinates: "0..1000", width: 1920, height: 1080, isError: false },
    });
    if (!archiveUnavailable) {
      const reader = (budget.tools as AgentToolSet)[0]!;
      let offset = 0,
        saved = "";
      for (;;) {
        const page = await reader.execute({ id: preview.outputId, offset, limit: 8192 }, {} as never);
        expect(page.text).not.toContain("\ufffd");
        saved += page.text;
        if (page.eof) break;
        offset = page.nextOffset;
      }
      expect(JSON.parse(saved)).toEqual([{ type: "text", text: JSON.stringify(original) }]);
      expect(saved).not.toContain(png.toString("base64"));
    }
    expect(images.has("ui-call")).toBe(false);
    expect(JSON.stringify(await storage.read())).not.toContain(png.toString("base64"));
    await Array.fromAsync(agent.run(createUserMessage("next turn")));
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.prompt)).not.toContain(png.toString("base64"));
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await agent.stop();
    images.clearAll();
  }
});
