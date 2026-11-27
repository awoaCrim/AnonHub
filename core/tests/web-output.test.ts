import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3StreamPart, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { jsonSchema } from "@yesimbot/agent-runtime";
import { textPart, type FilePart, type ImagePart, type Part } from "@yesimbot/contracts/parts";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { Channel } from "../src/channels/index.js";
import { collectDeliveredSourceRecords } from "../src/conversations/internal-history.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { TestEvents, defaultConfig, defaultMessageRecord } from "./helpers/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
type Step = { text?: string; tool?: string; input?: unknown; fail?: boolean };
const say = (...messages: string[]): Step => ({ tool: "send_message", input: { messages } });
const finish: Step = { tool: "finish" };

async function fixture(steps: Step[], options: { platform?: string; reject?: boolean; current?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "web-output-"));
  const platform = options.platform ?? "web";
  const channel = new Channel({ type: "direct", platform, selfId: "bot", channelId: "user", userId: "user" }, root);
  await channel.conversation.init();
  const archive = vi.spyOn(channel.conversation, "archiveIfOversize").mockResolvedValue(false);
  let index = 0;
  const requests: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      requests.push(request);
      const step = steps[index++];
      if (!step || step.fail) throw Error("model failed");
      const chunks: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (step.text) chunks.push({ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: step.text }, { type: "text-end", id: "text" });
      if (step.tool) chunks.push({ type: "tool-call", toolCallId: `call-${index}`, toolName: step.tool, input: JSON.stringify(step.input ?? {}) });
      chunks.push({
        type: "finish",
        finishReason: { unified: step.tool ? "tool-calls" : "stop", raw: step.tool ? "tool-calls" : "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      });
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
  const createMessage = vi.fn(async (_channel: string, _content: unknown) => {
    if (options.reject) throw Error("transport failed");
    return [{ id: "sent" }];
  });
  const sendMessage = vi.fn(async () => ["platform-sent"]);
  const ctx = new TestEvents();
  const activity = vi.fn();
  ctx.on("yesimbot/turn", activity);
  const delivered = vi.fn();
  ctx.on("yesimbot/delivered", delivered);
  const lookup = vi.fn(async () => ({ fact: "verified" }));
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: { selfId: "bot", platform, createMessage, sendMessage } as never,
    will: { decide: async () => "trigger", observe: () => {} } as never,
    model,
    toolChoice: "required",
    readImagePolicy: { mode: "native" },
    archiveMaxBytes: 1,
    config: defaultConfig({ basePath: root, modelRetries: 0 }),
    replyStillCurrent: () => options.current ?? true,
    plugins: [
      {
        name: "fixture",
        tools: () => [
          {
            name: "lookup",
            capability: { platforms: [platform], sensitive: false, executionKind: "read" },
            description: "Look up a fact",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: lookup,
          },
        ],
      },
    ],
  });
  await runtime.init();
  cleanup.push(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  async function run(silent: boolean | "quiet" = false) {
    const result = silent
      ? await runtime.post(
          { eventType: "notify-webhook", platform, selfId: "bot", timestamp: Date.now(), channel: { id: "user", type: 1 }, text: "done" } as never,
          silent === "quiet" ? { trigger: true, delivery: "channel", quiet: true } : { trigger: true, delivery: "silent" },
        )
      : await runtime.handle(defaultMessageRecord({ platform, selfId: "bot", channel: { id: "user", type: 1 }, user: { id: "user" } }));
    expect(result.kind).toBe("run");
    if (result.kind !== "run") throw Error("not run");
    await result.done;
    return await result.outcome;
  }
  return { run, activity, createMessage, sendMessage, delivered, requests, archive, lookup, channel, runtime };
}
const sentTexts = (f: { createMessage: { mock: { calls: unknown[][] } } }) => f.createMessage.mock.calls.map((call) => call[1] as Part[]);
it("publishes literal Markdown through the web send_message; sending does not end the turn", async () => {
  const answer = "## 标题\n\n**重点**\n\n```html\n<div>原文</div>\n```\n\n第二段";
  const f = await fixture([say(answer), finish]);
  const outcome = await f.run();
  expect(outcome).toMatchObject({ status: "done", delivered: true });
  expect(sentTexts(f)).toEqual([[textPart(answer)]]);
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.delivered).toHaveBeenCalledOnce();
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1].prompt)).toContain("messageIds");
  const send = f.requests[0].tools?.find((t) => t.name === "send_message");
  expect(send?.type === "function" && JSON.stringify(send.inputSchema)).toContain('"messages"');
  expect(JSON.stringify(send)).not.toContain('"parts"');
  expect(JSON.stringify(send)).not.toContain("keep_going");
  expect(f.requests[0].toolChoice?.type).toBe("required");
  const prompt = JSON.stringify(f.requests[0].prompt);
  expect(prompt).toContain("Markdown");
  expect(prompt).toContain("你输出的普通文本不会作为聊天消息显示");
});
it("sends each item as its own message, in order", async () => {
  const f = await fixture([say("先说结论：可以。", "补充一点：要先备份。"), finish]);
  expect(await f.run()).toMatchObject({ status: "done", delivered: true });
  expect(sentTexts(f)).toEqual([[textPart("先说结论：可以。")], [textPart("补充一点：要先备份。")]]);
  expect(f.delivered).toHaveBeenCalledTimes(2);
});
// User, 2026-11-18: clickable replies in the web chat.
it("offers clickable choices under the last message only, and refuses invalid choices without sending", async () => {
  const f = await fixture([{ tool: "send_message", input: { messages: ["要我替你发吗？", "发之前我再念一遍。"], choices: ["替我发", "先等等"] } }, finish]);
  expect(await f.run()).toMatchObject({ status: "done", delivered: true });
  const sent = sentTexts(f);
  expect(sent[0]).toEqual([textPart("要我替你发吗？")]);
  expect(sent[1]![0]).toEqual(textPart("发之前我再念一遍。"));
  expect(sent[1]![1]).toEqual({ type: "choices", options: ["替我发", "先等等"] });
  const send = f.requests[0].tools?.find((t) => t.name === "send_message");
  expect(JSON.stringify(send)).toContain('"choices"');

  for (const choices of [["只有一个"], ["同一个", "同一个"], ["a", "b", "c", "d", "e"], ["好", "x".repeat(41)]]) {
    const bad = await fixture([{ tool: "send_message", input: { messages: ["问"], choices } }, finish]);
    expect(await bad.run()).toMatchObject({ delivered: false });
    expect(bad.createMessage).not.toHaveBeenCalled();
  }
});
it("stops the running turn on request and reports when nothing was running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture([{ tool: "lookup" }, say("不该发出"), finish]);
  f.lookup.mockImplementationOnce(async () => {
    await gate;
    return { fact: "late" };
  });
  const done = f.run();
  await vi.waitFor(() => expect(f.lookup).toHaveBeenCalled());
  expect(await f.runtime.interruptActiveTurn()).toBe(true);
  release();
  expect(await done).toMatchObject({ status: "aborted", delivered: false });
  expect(f.createMessage).not.toHaveBeenCalled();
  expect(await f.runtime.interruptActiveTurn()).toBe(false);
});
// User, 2026-11-17: 「允许网页bot发各种形式的文件」.
it("sends a message that is one <file> or <img> as that file, under its own name", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7");
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const f = await fixture([say("报告和图都在这里：", '<file src="workspace:///out/report.pdf"/>', ' <img src="workspace:///out/chart.png"/> '), finish]);
  const reads: string[] = [];
  f.channel.resources.use({
    scheme: "workspace",
    prompt: "workspace",
    setup: async (_resources, uri) => {
      reads.push(uri.pathname);
      return uri.pathname.endsWith(".png") ? { bytes: png, filename: "chart.png" } : { bytes: pdf, filename: "report.pdf" };
    },
  });
  expect(await f.run()).toMatchObject({ status: "done", delivered: true });
  expect(reads).toEqual(["/out/report.pdf", "/out/chart.png"]);
  const [text, [file], [image]] = f.createMessage.mock.calls.map((call) => call[1] as Part[]);
  expect(text).toEqual([textPart("报告和图都在这里：")]);
  expect(file).toMatchObject({ type: "file", title: "report.pdf" });
  expect(String((file as FilePart).src)).toMatch(/^data:application\/pdf;base64,/);
  expect(image).toMatchObject({ type: "image" });
  expect(String((image as ImagePart).src)).toMatch(/^data:image\/png;base64,/);
  expect(f.delivered).toHaveBeenCalledTimes(3);
});
it("keeps an element inside Markdown literal, and stops at a file it cannot read", async () => {
  const inline = '看这张图 <img src="workspace:///a.png"/> 就懂了';
  const f = await fixture([say(inline, '<file src="workspace:///missing.pdf"/>', "这条不会发"), finish]);
  f.channel.resources.use({
    scheme: "workspace",
    prompt: "workspace",
    setup: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  await f.run();
  expect(sentTexts(f)).toEqual([[textPart(inline)]]);
  const result = JSON.stringify(f.requests[1]?.prompt);
  expect(result).toContain("ResourceReadFailed");
  expect(result).toContain("已发出的不要重发");
});
it("never shows plain model text", async () => {
  const f = await fixture([{ text: "这段正文不会显示" }]);
  expect(await f.run()).toMatchObject({ delivered: false });
  expect(f.createMessage).not.toHaveBeenCalled();
});
it("keeps working after an acknowledgement, then sends the result", async () => {
  const f = await fixture([say("我去查一下。"), { text: "查官方说明", tool: "lookup" }, say("查到了"), finish]);
  expect(await f.run()).toMatchObject({ status: "done", delivered: true });
  expect(f.lookup).toHaveBeenCalledOnce();
  expect(sentTexts(f)).toEqual([[textPart("我去查一下。")], [textPart("查到了")]]);
  expect(f.requests).toHaveLength(4);
});
it("shows ephemeral activity before a tool, and none for the send itself", async () => {
  const f = await fixture([{ text: "我先查一下官方说明。", tool: "lookup" }, say("**查到了**"), finish]);
  await f.run();
  expect(sentTexts(f)).toEqual([[textPart("**查到了**")]]);
  const call = f.activity.mock.calls.findIndex(([event]) => event.activity);
  expect(f.activity.mock.calls[call][0]).toMatchObject({ active: true, activity: "我先查一下官方说明。" });
  expect(f.activity.mock.invocationCallOrder[call]).toBeLessThan(f.lookup.mock.invocationCallOrder[0]!);
  expect(f.activity.mock.calls.some(([event]) => String(event.activity ?? "").includes("send_message"))).toBe(false);
  expect(f.activity.mock.calls.at(-1)?.[0]).toMatchObject({ active: false });
  expect(f.delivered).toHaveBeenCalledOnce();
});
it("clears activity after model failure without claiming a message was delivered", async () => {
  const f = await fixture([{ text: "我先核对资料。", tool: "lookup" }, { fail: true }]);
  expect(await f.run()).toMatchObject({ status: "failed", delivered: false });
  expect(f.createMessage).not.toHaveBeenCalled();
  expect(f.activity.mock.calls.at(-1)?.[0]).toMatchObject({ active: false });
});
it("provides a transient fallback when a tool step omits its summary", async () => {
  const f = await fixture([{ tool: "lookup" }, say("完成"), finish]);
  await f.run();
  expect(f.activity.mock.calls.some(([event]) => event.activity === "正在使用 lookup…")).toBe(true);
  expect(f.createMessage).toHaveBeenCalledOnce();
});
it.each(["silent", "stale", "finish"])("does not publish for %s", async (kind) => {
  const steps = kind === "finish" ? [finish] : [{ text: "检查资料", tool: "lookup" }, say("不能发送"), finish];
  const f = await fixture(steps, { current: kind !== "stale" });
  const outcome = await f.run(kind === "silent");
  expect(f.createMessage).not.toHaveBeenCalled();
  expect(outcome?.delivered).toBe(false);
});
it("hides a quiet turn's process but still delivers its message (a silent heartbeat may speak)", async () => {
  const f = await fixture([{ text: "我先查一下邮件。", tool: "lookup" }, say("Tavily 额度用到 80% 了。"), finish]);
  const outcome = await f.run("quiet");
  expect(f.activity).not.toHaveBeenCalled();
  expect(f.lookup).toHaveBeenCalledOnce();
  expect(sentTexts(f)).toEqual([[textPart("Tavily 额度用到 80% 了。")]]);
  expect(outcome).toMatchObject({ status: "done", delivered: true });
  expect(f.delivered).toHaveBeenCalledOnce();
});
it("does not claim delivery when web transport fails, and tells the model", async () => {
  const f = await fixture([say("answer"), finish], { reject: true });
  expect(await f.run()).toMatchObject({ delivered: false });
  expect(f.delivered).not.toHaveBeenCalled();
  expect(JSON.stringify(f.requests[1].prompt)).toContain("SendFailed");
});
it("records sent web messages as delivered for compaction and context blocks", async () => {
  const f = await fixture([say("**第一条**", "第二条"), finish]);
  await f.run();
  const records = [...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat();
  expect(records.map((record) => [record.speaker, record.text])).toEqual([
    ["assistant (already delivered)", "**第一条**"],
    ["assistant (already delivered)", "第二条"],
  ]);
});
it("keeps earlier sent messages in the next turn's history", async () => {
  const f = await fixture([say("第一次的回答"), finish, say("second"), finish]);
  await f.run();
  await f.run();
  expect(JSON.stringify(f.requests[2].prompt)).toContain("第一次的回答");
});
it("keeps non-web private chat on explicit send tools", async () => {
  const f = await fixture([{ text: "not a platform reply" }], { platform: "onebot" });
  const outcome = await f.run();
  expect(f.createMessage).not.toHaveBeenCalled();
  expect(outcome?.delivered).toBe(false);
  expect(f.requests[0].tools?.some((t) => t.name === "send_message")).toBe(true);
});

it("never automatically archives web chat even with an enabled size threshold", async () => {
  const f = await fixture([say("first"), finish, say("second"), finish]);
  await f.run();
  await f.run();
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.createMessage).toHaveBeenCalledTimes(2);
});
it("retains automatic archiving for other platforms", async () => {
  const f = await fixture([{ tool: "finish" }], { platform: "onebot" });
  await f.run();
  expect(f.archive).toHaveBeenCalledWith(1);
});
