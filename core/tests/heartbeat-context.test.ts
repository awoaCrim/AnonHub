import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createEntry } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { systemClock } from "@yesimbot/foundation";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { ScheduleScheduler } from "../../plugins/schedule/src/scheduler.js";
import type { ScheduleStore } from "../../plugins/schedule/src/store.js";
import type { Schedule } from "../../plugins/schedule/src/types.js";
import { Channels, type ChannelContext } from "../src/channels/index.js";
import { createMessage, type EventRecord } from "../src/messages/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import type { PostOptions } from "../src/runtimes/types.js";
import { TestEvents, defaultConfig, h } from "./helpers/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

it.each((["direct", "guild"] as const).flatMap((kind) => [false, true].map((magicContext) => ({ kind, magicContext }))))(
  "a scheduled QQ $kind heartbeat isolates its history with Magic Context=$magicContext",
  async ({ kind, magicContext }) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-heartbeat-context-"));
    const ctx = new TestEvents();
    const channels = new Channels({ basePath: root, magicContext });
    const scope: ChannelContext =
      kind === "direct"
        ? { type: "direct", platform: "onebot", selfId: "bot", channelId: "private:alice", userId: "alice" }
        : { type: "guild", platform: "onebot", selfId: "bot", channelId: "group-a", guildId: "group-a" };
    const otherScope: ChannelContext = { type: "direct", platform: "onebot", selfId: "bot", channelId: "private:bob", userId: "bob" };
    const channel = await channels.resolve(scope);
    const other = await channels.resolve(otherScope);
    if (magicContext) {
      await channel.conversation.storage.append(
        createEntry(
          "message",
          { id: "old-covered", timestamp: 1, role: "user", content: "COVERED_RAW_HISTORY:" + "x".repeat(16000) },
          { id: "old-covered", timestamp: 1 },
        ),
      );
      await channel.conversation.commitContextRegion(await channel.conversation.freezeContextRegion(["old-covered"]), {
        tiers: { P1: "EARLIER_CONTEXT_SUMMARY", P2: "EARLIER_CONTEXT_SUMMARY", P3: "EARLIER_CONTEXT_SUMMARY", P4: "EARLIER_CONTEXT_SUMMARY" },
        importance: 0.5,
      });
    }
    for (const [target, user, text] of [
      [channel, "alice", "CURRENT_CONVERSATION_FOLLOWUP: 等项目发布后提醒我。"],
      [other, "bob", "OTHER_CONVERSATION_PRIVATE: 我的另外一件事。"],
    ] as const) {
      await target.conversation.storage.append(
        createEntry(
          "message",
          createMessage({
            platform: "onebot",
            selfId: "bot",
            channel: { id: target.context.channelId, type: target.context.type === "direct" ? 1 : 0 },
            user: { id: user, name: user },
            timestamp: Date.now() - 1000,
            messageId: `history-${user}`,
            parts: partsFromElements([h.text(text)]),
          }),
        ),
      );
    }
    const requests: LanguageModelV3CallOptions[] = [];
    const model = new MockLanguageModelV3({
      async doStream(options) {
        requests.push(options);
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "heartbeat-finish", toolName: "finish", input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    });
    const sendMessage = vi.fn();
    const runtime = new ChannelRuntime(ctx, {
      channel,
      bot: { platform: "onebot", selfId: "bot", sendMessage } as never,
      will: { decide: () => "trigger" },
      model,
      config: defaultConfig({
        basePath: root,
        modelRetries: 0,
        customInnerThought: false,
        session: { archive: { maxKB: 0 }, magicContext: { enabled: magicContext } },
      }),
      readImagePolicy: { mode: "unavailable" },
      plugins: [],
    });
    let finished!: () => void;
    const completion = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const due = new Date().toISOString();
    let row: Schedule = {
      ...scope,
      selfId: "bot",
      id: "local-heartbeat",
      title: "检查近期进展",
      prompt: "关注本会话的项目发布。",
      purpose: "heartbeat",
      delivery: "channel",
      kind: "cron",
      cron: "*/30 * * * *",
      state: "enabled",
      nextRunAt: due,
      createdAt: due,
      updatedAt: due,
    };
    const store = {
      recover: async () => [],
      listEnabled: async () => [row],
      claim: async () => {
        const claimed = row;
        row = { ...row, nextRunAt: new Date(Date.now() + 30 * 60_000).toISOString() };
        return claimed;
      },
      started: async () => {},
      finish: vi.fn(async () => {
        finished();
      }),
    };
    const scheduler = new ScheduleScheduler(store as unknown as ScheduleStore, {
      messenger: {
        async post() {
          throw new Error("unexpected post");
        },
        async postAndReport(event: EventRecord, options: PostOptions) {
          const result = await runtime.post(event, options);
          if (result.kind !== "run") return { kind: result.kind };
          await result.done;
          return { kind: "run", outcome: await result.outcome };
        },
      } as never,
      timer: (callback, milliseconds) => {
        const handle = setTimeout(callback, milliseconds);
        return () => clearTimeout(handle);
      },
      clock: systemClock(),
    });
    cleanup.push(async () => {
      scheduler.stop();
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    });
    await runtime.init();
    await scheduler.start();
    await completion;
    expect(requests).toHaveLength(1);
    const prompt = JSON.stringify(requests[0]!.prompt);
    expect(prompt).toContain("CURRENT_CONVERSATION_FOLLOWUP");
    expect(prompt).not.toContain("OTHER_CONVERSATION_PRIVATE");
    expect(prompt).toContain("不是用户刚发来的消息");
    if (magicContext) {
      expect(prompt).toContain("EARLIER_CONTEXT_SUMMARY");
      expect(prompt).not.toContain("COVERED_RAW_HISTORY");
      expect(requests[0]!.maxOutputTokens).toBe(8192);
    }
    expect(store.finish).toHaveBeenCalledWith(row.id, due, "completed", undefined, false, undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  },
);
