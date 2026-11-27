import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createAgent } from "../src/agent.js";
import { createUserMessage } from "../src/message.js";
import { createFileToolJournal, ToolJournalNotice, type ToolJournalCall } from "../src/tool-journal.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "yesimbot-journal-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
const call: ToolJournalCall = { turnId: "turn", toolCallId: "call", toolName: "effect", input: { destination: "test", count: 1 } };
const key = (value = call) =>
  createHash("sha256")
    .update(JSON.stringify([value.turnId, value.toolCallId]))
    .digest("hex");

describe("durable tool execution admission", () => {
  it("recovers a completed result after recreating the journal without repeating effects", async () => {
    const root = await directory(),
      execute = vi.fn(async () => ({ receipt: "r-1", count: 2 }));
    expect(await createFileToolJournal(root).execute(call, execute)).toEqual({ receipt: "r-1", count: 2 });
    const second = { ...call, input: { count: 1, destination: "test" } };
    expect(await createFileToolJournal(root).execute(second, execute)).toEqual({ receipt: "r-1", count: 2 });
    expect(execute).toHaveBeenCalledTimes(1);
    const intent = await readFile(join(root, `${key()}.intent.json`), "utf8");
    expect(intent).not.toContain("destination");
  });

  it("blocks argument/tool identity conflicts while allowing independent turns and scopes", async () => {
    const root = await directory(),
      other = await directory(),
      execute = vi.fn(async () => "ok");
    const journal = createFileToolJournal(root);
    await journal.execute(call, execute);
    expect(await journal.execute({ ...call, input: { count: 2 } }, execute)).toMatchObject({ code: "call_conflict" });
    expect(await journal.execute({ ...call, toolName: "other" }, execute)).toMatchObject({ code: "call_conflict" });
    await journal.execute({ ...call, turnId: "another-turn" }, execute);
    await createFileToolJournal(other).execute(call, execute);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent callers across instances in the same process", async () => {
    const root = await directory();
    let finish!: (value: string) => void;
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const first = createFileToolJournal(root).execute(call, execute);
    const second = createFileToolJournal(root).execute(call, execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(await createFileToolJournal(root).execute({ ...call, input: {} }, execute)).toMatchObject({ code: "call_conflict" });
    finish("receipt");
    expect(await Promise.all([first, second])).toEqual(["receipt", "receipt"]);
  });

  it("does not admit an effect when durable storage cannot be opened", async () => {
    const root = await directory(),
      path = join(root, "not-a-directory"),
      execute = vi.fn(async () => "bad");
    await writeFile(path, "occupied");
    expect(await createFileToolJournal(path).execute(call, execute)).toMatchObject({ code: "journal_unavailable", executionStatus: "not_started" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("writes the intent before execution and treats post-effect errors as unknown on every recovery", async () => {
    const root = await directory();
    let effects = 0;
    const execute = vi.fn(async () => {
      expect(JSON.parse(await readFile(join(root, `${key()}.intent.json`), "utf8")).version).toBe(1);
      effects++;
      throw new Error("crashed after external write");
    });
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown", automaticReplayBlocked: true });
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(effects).toBe(1);
  });

  it("never executes an intent interrupted after durable admission but before the effect", async () => {
    const root = await directory(),
      controller = new AbortController(),
      execute = vi.fn(async () => "effect");
    const original = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
      if (++checks === 3) controller.abort();
      original();
    });
    await expect(createFileToolJournal(root).execute(call, execute, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(root)).toEqual([`${key()}.intent.json`]);
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never executes again when the existing intent is torn", async () => {
    const root = await directory(),
      execute = vi.fn(async () => "effect");
    await writeFile(join(root, `${key()}.intent.json`), '{"version":');
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks a call whose intent exists but whose result was lost or torn", async () => {
    const root = await directory(),
      execute = vi.fn(async () => "ok");
    await createFileToolJournal(root).execute(call, execute);
    await rm(join(root, `${key()}.result.json`));
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    await writeFile(join(root, `${key()}.result.json`), '{"version":');
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not rerun after cancellation once execution was admitted", async () => {
    const root = await directory(),
      controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    await expect(createFileToolJournal(root).execute(call, execute, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not create a journal for an already aborted operation", async () => {
    const root = await directory(),
      execute = vi.fn(async () => "ok");
    await expect(createFileToolJournal(root).execute(call, execute, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(root)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { content: [{ type: "image", data: "secret-image-bytes" }] },
    { inlineData: { mimeType: "video/mp4", data: "secret-video-bytes" } },
    { content: [{ type: "input_audio", data: "secret-audio-bytes" }] },
    { screen: "data:image/png;base64,c2VjcmV0" },
    { clip: "data:audio/wav;base64,c2VjcmV0" },
    { buffer: new Uint8Array([1, 2, 3]) },
    { receivedAt: new Date() },
    { invalid: Number.POSITIVE_INFINITY },
    "long-result".repeat(20000),
  ])("keeps ephemeral/oversized live output intact but never persists it", async (result) => {
    const root = await directory(),
      execute = vi.fn(async () => result);
    expect(await createFileToolJournal(root).execute(call, execute)).toBe(result);
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "completed_result_unavailable", executionStatus: "completed" });
    expect((await readFile(join(root, `${key()}.result.json`))).byteLength).toBeLessThan(1024);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not invoke getters or custom JSON serializers while storing the result", async () => {
    const root = await directory(),
      getter = vi.fn(() => "secret"),
      serialize = vi.fn(() => ({ image: "data:image/png;base64,c2VjcmV0" }));
    const result = Object.defineProperty({}, "receipt", { get: getter, enumerable: true });
    expect(await createFileToolJournal(root).execute(call, async () => result)).toBe(result);
    expect(await createFileToolJournal(root).execute(call, async () => result)).toMatchObject({ code: "completed_result_unavailable" });
    const another = { ...call, toolCallId: "custom-json" };
    const custom = Object.defineProperty({ receipt: "safe" }, "toJSON", { value: serialize });
    expect(await createFileToolJournal(root).execute(another, async () => custom)).toBe(custom);
    expect(await createFileToolJournal(root).execute(another, async () => custom)).toMatchObject({ code: "completed_result_unavailable" });
    expect(getter).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
  });

  it("recovers bounded plain JSON including shared values and omitted optional fields", async () => {
    const root = await directory(),
      receipt = { id: "r-1" };
    const result = { a: receipt, b: receipt, optional: undefined };
    await createFileToolJournal(root).execute(call, async () => result);
    expect(await createFileToolJournal(root).execute(call, async () => "bad")).toEqual({ a: receipt, b: receipt });
  });

  it("honors the current custom projection policy even when an earlier plain result exists", async () => {
    const root = await directory(),
      execute = vi.fn(async () => ({ receipt: "r-1" }));
    await createFileToolJournal(root).execute(call, execute);
    expect(await createFileToolJournal(root).execute(call, execute, { replayable: false })).toMatchObject({ code: "completed_result_unavailable" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns the actual live result if result persistence fails without re-executing later", async () => {
    const root = await directory();
    const execute = vi.fn(async () => {
      await mkdir(join(root, `${key()}.result.json`));
      return { confirmed: true };
    });
    expect(await createFileToolJournal(root).execute(call, execute)).toEqual({ confirmed: true });
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not follow a symlink journal or forged result file", async () => {
    const root = await directory(),
      target = await directory(),
      execute = vi.fn(async () => "ok");
    await symlink(target, join(root, "linked"));
    expect(await createFileToolJournal(join(root, "linked")).execute(call, execute)).toMatchObject({ code: "journal_unavailable" });
    await createFileToolJournal(root).execute(call, execute);
    const path = join(root, `${key()}.result.json`);
    await rm(path);
    await writeFile(join(target, "fake"), '{"result":"fake"}');
    await symlink(join(target, "fake"), path);
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function repeatedToolModel(requests: LanguageModelV3CallOptions[], count = 2): LanguageModelV3 {
  let step = 0;
  return {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "journal-model",
    supportedUrls: {},
    async doGenerate() {
      throw Error("unused");
    },
    async doStream(options) {
      requests.push(structuredClone(options));
      const tool = step++ < count;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (tool) controller.enqueue({ type: "tool-call", toolCallId: "repeat", toolName: "effect", input: "{}" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: tool ? "tool-calls" : "stop", raw: undefined },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

describe("Agent journal integration", () => {
  it.each(["execution_unknown", "call_conflict", "completed_result_unavailable", "journal_unavailable"] as const)(
    "does not accept a terminal call blocked by %s",
    async (code) => {
      const requests: LanguageModelV3CallOptions[] = [],
        execute = vi.fn(async () => ({ ok: true }));
      let attempts = 0;
      const agent = createAgent({
        model: repeatedToolModel(requests),
        requireTerminalTool: true,
        toolJournal: { execute: async (_call, perform) => (++attempts === 1 ? new ToolJournalNotice(code) : perform()) },
        tools: [{ name: "effect", terminal: true, inputSchema: z.object({}), execute }],
      });

      const events = await Array.fromAsync(agent.run(createUserMessage("work")));
      await agent.wait();

      expect(events.at(-1)?.type).toBe("turn.done");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.prompt)).toContain(code);
      await agent.stop();
    },
  );

  it("keeps an unknown terminal effect unaccepted and never replays its admitted identity", async () => {
    const requests: LanguageModelV3CallOptions[] = [],
      execute = vi.fn(async () => {
        throw Error("crashed after external write");
      });
    const agent = createAgent({
      model: repeatedToolModel(requests),
      requireTerminalTool: true,
      toolJournal: createFileToolJournal(await directory()),
      tools: [{ name: "effect", terminal: true, inputSchema: z.object({}), execute }],
    });

    const events = await Array.fromAsync(agent.run(createUserMessage("work")));
    await agent.wait();

    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: { name: "AgentProtocolError" } });
    expect(events.some((event) => event.type === "turn.done")).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "tool.blocked")).toMatchObject([
      { journalCode: "execution_unknown", automaticReplayBlocked: true },
      { journalCode: "execution_unknown", automaticReplayBlocked: true },
    ]);
    expect(JSON.stringify(requests[1]?.prompt)).toContain("execution_unknown");
    await agent.stop();
  });

  it("accepts a recovered successful terminal result without executing the effect again", async () => {
    const requests: LanguageModelV3CallOptions[] = [],
      execute = vi.fn(async () => ({ accepted: true }));
    const journal = createFileToolJournal(await directory());
    const agent = createAgent({
      model: repeatedToolModel(requests),
      requireTerminalTool: true,
      toolJournal: {
        execute: async (call, perform, options) => {
          await journal.execute(call, perform, options);
          return journal.execute(call, perform, options);
        },
      },
      tools: [{ name: "effect", terminal: (_input, output: { accepted: boolean }) => output.accepted, inputSchema: z.object({}), execute }],
    });

    const events = await Array.fromAsync(agent.run(createUserMessage("work")));
    await agent.wait();

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    await agent.stop();
  });

  it("runs execution and result hooks once and recovers the processed result", async () => {
    const requests: LanguageModelV3CallOptions[] = [],
      execute = vi.fn(async () => "unbounded original");
    const afterToolCall = vi.fn(() => ({ result: "bounded result" }));
    const agent = createAgent({
      model: repeatedToolModel(requests),
      toolJournal: createFileToolJournal(await directory()),
      tools: [{ name: "effect", inputSchema: z.object({}), execute }],
      plugins: [{ name: "budget", afterToolCall }],
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("work")));
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(afterToolCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests.at(-1)?.prompt)).toContain("bounded result");
    expect(JSON.stringify(requests.at(-1)?.prompt)).not.toContain("unbounded original");
    await agent.stop();
  });

  it("does not repeat execution or a post-tool hook whose error the plugin host isolates", async () => {
    const requests: LanguageModelV3CallOptions[] = [],
      execute = vi.fn(async () => "external write completed");
    const afterToolCall = vi.fn(() => {
      throw Error("hook failed");
    });
    const agent = createAgent({
      model: repeatedToolModel(requests),
      toolJournal: createFileToolJournal(await directory()),
      tools: [{ name: "effect", inputSchema: z.object({}), execute }],
      plugins: [{ name: "failing-hook", afterToolCall }],
    });
    let pluginError = false;
    agent.channel.subscribe("internal", (event) => {
      if (event.type === "plugin.error" && event.plugin === "failing-hook") pluginError = true;
    });
    await Array.fromAsync(agent.run(createUserMessage("work")));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(afterToolCall).toHaveBeenCalledTimes(1);
    expect(pluginError).toBe(true);
    expect(JSON.stringify(requests.at(-1)?.prompt)).toContain("external write completed");
    await agent.stop();
  });

  it("preserves live custom projections and bypasses them for recovery notices", async () => {
    const requests: LanguageModelV3CallOptions[] = [],
      execute = vi.fn(async () => ({ staged: "ephemeral-id" }));
    const projection = vi.fn(({ output }) => {
      expect(output).not.toBeInstanceOf(ToolJournalNotice);
      return { type: "text" as const, value: output.staged };
    });
    const agent = createAgent({
      model: repeatedToolModel(requests),
      toolJournal: createFileToolJournal(await directory()),
      tools: [{ name: "effect", inputSchema: z.object({}), execute, toModelOutput: projection }],
    });
    await Array.fromAsync(agent.run(createUserMessage("work")));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalled();
    expect(JSON.stringify(requests.at(-1)?.prompt)).toContain("completed_result_unavailable");
    await agent.stop();
  });

  it("reports unknown execution structurally and bypasses custom projection after an effect fails", async () => {
    const requests: LanguageModelV3CallOptions[] = [],
      execute = vi.fn(async () => {
        throw Error("effect may have happened");
      });
    const afterToolCall = vi.fn(),
      projection = vi.fn(() => ({ type: "text" as const, value: "bad" }));
    const agent = createAgent({
      model: repeatedToolModel(requests),
      toolJournal: createFileToolJournal(await directory()),
      tools: [{ name: "effect", inputSchema: z.object({}), execute, toModelOutput: projection }],
      plugins: [{ name: "observer", afterToolCall }],
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("work")));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(afterToolCall).toHaveBeenCalledTimes(1);
    expect(afterToolCall.mock.calls[0]?.[0]).toMatchObject({ isError: true });
    expect(projection).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "tool.blocked")).toMatchObject([
      { journalCode: "execution_unknown", executionStatus: "unknown", automaticReplayBlocked: true },
      { journalCode: "execution_unknown", executionStatus: "unknown", automaticReplayBlocked: true },
    ]);
    expect(JSON.stringify(requests.at(-1)?.prompt)).toContain("execution_unknown");
    await agent.stop();
  });

  it("runs authorization before a journal lookup and does not recover a result after denial", async () => {
    const requests: LanguageModelV3CallOptions[] = [],
      execute = vi.fn(async () => "secret");
    let allowed = true;
    const agent = createAgent({
      model: repeatedToolModel(requests),
      toolJournal: createFileToolJournal(await directory()),
      tools: [{ name: "effect", inputSchema: z.object({}), execute }],
      plugins: [
        {
          name: "permissions",
          beforeToolCall: () => (allowed ? { type: "allow" } : { type: "block", reason: "denied" }),
          afterToolCall: () => {
            allowed = false;
          },
        },
      ],
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("work")));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "tool.blocked" && event.reason === "denied")).toBe(true);
    await agent.stop();
  });
});
