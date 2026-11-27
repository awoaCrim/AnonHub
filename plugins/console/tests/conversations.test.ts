import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { systemClock } from "@yesimbot/foundation";
import { partsFromElements } from "koishi-plugin-yesimbot";
import { describe, expect, it } from "vitest";

import { buildConversationIndex, parseConversationJsonl, readConversationPage } from "../src/conversation-history.js";

describe("parseConversationJsonl", () => {
  it("distinguishes reasoning from replies and skips retired summaries", async () => {
    const fixtures = resolve(process.cwd(), "plugins/console/tests/fixtures");
    const content = await readFile(resolve(fixtures, "real-session.jsonl"), "utf8");
    const { entries } = await parseConversationJsonl(content, "real-session.jsonl", fixtures);

    expect(entries.find((entry) => entry.kind === "thought")?.text).toContain("搜一下");
    expect(entries.find((entry) => entry.kind === "assistant")?.text).toContain("今天晴");
    expect(entries.find((entry) => entry.kind === "tool-call")?.toolName).toBe("search_service");
    expect(entries.find((entry) => entry.kind === "will")?.decision).toBe("trigger");
    // A retired compaction summary is not an entry any more; it is skipped, not shown.
    expect(entries.map((entry) => entry.text ?? "").join("\n")).not.toContain("用户询问天气");
    expect(entries.find((entry) => entry.kind === "user")?.assets?.[0]).toMatchObject({
      kind: "file",
      title: "notes.txt",
    });
  });
});

describe("conversation index without retired policy configuration", () => {
  it("preserves configured storage/history while omitting plugin-specific policy payloads", async () => {
    await withTempContent("", async (_file, root) => {
      const channel = join(root, "channels", "shared-test-room");
      await mkdir(join(channel, "sessions"), { recursive: true });
      await writeFile(
        join(channel, "channel.json"),
        JSON.stringify({ type: "guild", platform: "test", channelId: "room", createdAt: "2026-10-23T00:00:00.000Z" }),
      );
      const index = await buildConversationIndex({
        baseDir: root,
        clock: systemClock(),
        loader: {
          config: {
            plugins: {
              "group:yesimbot": {
                yesimbot: { basePath: "." },
                "yesimbot-will-policy:old": { engine: "willingness", privateOption: "must-not-leak" },
              },
            },
          },
        },
      } as never);
      expect(index.totalChannels).toBe(1);
      expect(index.channels[0]).toMatchObject({ platform: "test", channelId: "room", sessions: [] });
      expect(index).not.toHaveProperty("will");
      expect(index.channels[0]).not.toHaveProperty("will");
      expect(JSON.stringify(index)).not.toContain("must-not-leak");
    });
  });
});

// User, 2026-11-17: 「会话管理页面优化一下」 — the list shows what was said last, and who a direct chat is with.
describe("conversation list previews", () => {
  const text = (content: string) => ({ type: "text", attrs: { content }, children: [] });
  const said = (timestamp: number, id: string, name: string, words: string, extra: Record<string, unknown> = {}) => ({
    type: "message",
    id: `u${timestamp}`,
    timestamp,
    data: {
      role: "custom",
      type: "yesimbot.message",
      data: { parts: partsFromElements([text(words)]), user: { id, name }, messageId: `m${timestamp}`, ...extra },
    },
  });
  const sent = (timestamp: number, input: Record<string, unknown>) => ({
    type: "message",
    id: `a${timestamp}`,
    timestamp,
    data: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "私下的想法" },
        { type: "tool-call", toolCallId: `c${timestamp}`, toolName: "send_message", input },
      ],
    },
  });
  const will = (timestamp: number) => ({ type: "event", id: `w${timestamp}`, timestamp, data: { type: "will.decision", decision: "skip" } });
  async function index(channels: Record<string, { manifest: Record<string, unknown>; sessions: unknown[][] }>) {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-preview-"));
    try {
      for (const [key, channel] of Object.entries(channels)) {
        const dir = join(root, "channels", key);
        await mkdir(join(dir, "sessions"), { recursive: true });
        await writeFile(join(dir, "channel.json"), JSON.stringify({ createdAt: "2026-11-01T00:00:00.000Z", ...channel.manifest }));
        for (const [n, lines] of channel.sessions.entries())
          await writeFile(join(dir, "sessions", `2026111${n}T000000Z.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
      }
      const result = await buildConversationIndex({
        baseDir: root,
        clock: systemClock(),
        loader: { config: { plugins: { yesimbot: { basePath: "." } } } },
      } as never);
      return Object.fromEntries(result.channels.map((channel) => [channel.key, channel]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("previews the latest visible message: a person's, or the bot's send without its private thoughts", async () => {
    const channels = await index({
      group: {
        manifest: { type: "guild", platform: "onebot", channelId: "1", selfId: "bot" },
        sessions: [[said(1, "20001", "阿杰", "早上好"), sent(2, { parts: [{ kind: "text", text: '早！<img src="workspace:///a.png"/>' }] }), will(3)]],
      },
      direct: {
        manifest: { type: "direct", platform: "wechat-bridge", channelId: "wxid_a", userId: "wxid_a", selfId: "wxid_self" },
        sessions: [[said(1, "wxid_a", "王老师", "下周的课改到周三")], []],
      },
      web: {
        manifest: { type: "direct", platform: "web", channelId: "owner", userId: "owner", selfId: "owner" },
        sessions: [[said(1, "owner", "主人", "x".repeat(100)), sent(2, { messages: ["第一条", "第二条"] })]],
      },
    });
    expect(channels.group!.preview).toEqual({ text: "早！[图片]", fromBot: true, at: 2 });
    expect(channels.group).not.toHaveProperty("peerName");
    // An empty newer session falls back to the one before it.
    expect(channels.direct!.preview).toEqual({ text: "下周的课改到周三", sender: "王老师", fromBot: false, at: 1 });
    expect(channels.direct!.peerName).toBe("王老师");
    expect(channels.web!.preview).toMatchObject({ text: "第一条 第二条", fromBot: true });
    expect(JSON.stringify(channels)).not.toContain("私下的想法");
  });

  // User, 2026-11-20: every archived web row read 「网页对话 · 你好」, the conversation's first message.
  it("gives each web session its own latest message and leaves other platforms' sessions alone", async () => {
    const channels = await index({
      web: {
        manifest: { type: "direct", platform: "web", channelId: "owner", userId: "owner", selfId: "owner" },
        sessions: [[said(1, "owner", "主人", "你好")], [], [said(3, "owner", "主人", "法国机掉线了"), sent(4, { messages: ["我去看看"] }), will(5)]],
      },
      group: {
        manifest: { type: "guild", platform: "onebot", channelId: "1", selfId: "bot" },
        sessions: [[said(1, "20001", "阿杰", "早上好")]],
      },
    });
    expect(channels.web!.sessions.map((session) => session.preview)).toEqual([
      { text: "你好", sender: "主人", fromBot: false, at: 1 },
      undefined,
      { text: "我去看看", fromBot: true, at: 4 },
    ]);
    // The conversation keeps its own newest message for the list.
    expect(channels.web!.preview).toEqual({ text: "我去看看", fromBot: true, at: 4 });
    expect(channels.group!.sessions.some((session) => "preview" in session)).toBe(false);
    expect(JSON.stringify(channels)).not.toContain("私下的想法");
  });

  it("reads a web session's end again only when the file's size or mtime changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-preview-"));
    try {
      const dir = join(root, "channels", "web");
      await mkdir(join(dir, "sessions"), { recursive: true });
      const manifest = { createdAt: "2026-11-01T00:00:00.000Z", type: "direct", platform: "web", channelId: "owner", userId: "owner", selfId: "owner" };
      await writeFile(join(dir, "channel.json"), JSON.stringify(manifest));
      const file = join(dir, "sessions", "20261110T000000Z.jsonl");
      const write = async (words: string, mtime = 1_763_600_000) => {
        await writeFile(file, JSON.stringify(said(1, "owner", "主人", words)) + "\n");
        await utimes(file, mtime, mtime);
      };
      const preview = async () =>
        (await buildConversationIndex({ baseDir: root, clock: systemClock(), loader: { config: { plugins: { yesimbot: { basePath: "." } } } } } as never))
          .channels[0]!.sessions[0]!.preview?.text;
      await write("第一句");
      expect(await preview()).toBe("第一句");
      // Same size, same mtime: the cached end answers and the file is not read again.
      await write("第二句");
      expect(await preview()).toBe("第一句");
      await write("第二句", 1_763_600_060);
      expect(await preview()).toBe("第二句");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clips a long message and marks the owner's private word as theirs", async () => {
    const channels = await index({
      room: {
        manifest: { type: "guild", platform: "onebot", channelId: "2", selfId: "bot" },
        sessions: [[said(1, "owner", "主人", "长".repeat(80), { whisper: true })]],
      },
    });
    expect(channels.room!.preview).toMatchObject({ sender: "你", fromBot: false });
    expect(channels.room!.preview!.text).toBe(`${"长".repeat(60)}…`);
  });
});

// AI SDK 6 records a failed tool call in its output; the thread showed every failure as a plain call.
describe("tool failures", () => {
  it("marks error outputs, refusals and ok:false values as failures", async () => {
    const result = (output: unknown, extra: Record<string, unknown> = {}) => ({ type: "tool-result", toolCallId: "c", toolName: "t", output, ...extra });
    const lines = [
      result({ type: "error-text", value: "时间格式无法识别" }),
      result({ type: "error-json", value: { error: { name: "Timeout", message: "超时" } } }),
      result({ type: "execution-denied", reason: "需要确认" }),
      result({ type: "json", value: { ok: false, error: { name: "NotFound", message: "找不到" } } }),
      result({ type: "json", value: { ok: true } }),
      result({ type: "text", value: "完成" }),
      result(undefined, { isError: true }),
    ].map((part, index) => JSON.stringify({ type: "message", id: `r${index}`, timestamp: index, data: { role: "tool", content: [part] } }));
    const { entries } = await parseConversationJsonl(lines.join("\n"), "s.jsonl", tmpdir());
    expect(entries.map((entry) => entry.error)).toEqual([
      { message: "时间格式无法识别" },
      { name: "Timeout", message: "超时" },
      { name: "ExecutionDenied", message: "需要确认" },
      { name: "NotFound", message: "找不到" },
      undefined,
      undefined,
      { message: "工具返回错误" },
    ]);
  });
});

describe("readConversationPage", () => {
  it("returns the newest ten records and walks older pages without duplicates", async () => {
    await withTempSession(
      Array.from({ length: 25 }, (_, index) => userLine(index, "x".repeat(4_000))),
      async (filePath, channelRoot) => {
        const texts = (page: { entries: { text?: string }[] }) => page.entries.map((entry) => entry.text?.replace(/x+$/, ""));
        const latest = await readConversationPage(filePath, "session.jsonl", channelRoot);
        expect(texts(latest)).toEqual(Array.from({ length: 10 }, (_, index) => `message-${index + 15}`));
        expect(latest.entries).toHaveLength(10);
        expect(latest.hasMore).toBe(true);
        expect(latest.nextCursor).toBeTruthy();

        const older = await readConversationPage(filePath, "session.jsonl", channelRoot, { cursor: latest.nextCursor });
        expect(older.entries).toHaveLength(10);
        const olderIds = new Set(older.entries.map((entry) => entry.id));
        expect(latest.entries.filter((entry) => olderIds.has(entry.id))).toHaveLength(0);
        expect(older.hasMore).toBe(true);

        const oldest = await readConversationPage(filePath, "session.jsonl", channelRoot, { cursor: older.nextCursor });
        expect(oldest.entries).toHaveLength(5);
        expect(oldest.hasMore).toBe(false);
        expect(oldest.nextCursor).toBeUndefined();
      },
    );
  });

  it("reaches back to the message that opened the earliest turn, and internal lines do not count", async () => {
    // One message, then a long bot turn: diagnostics, a thought and reply, tool steps, state lines.
    const turn = [
      eventLine(1),
      ...Array.from({ length: 6 }, (_, index) =>
        JSON.stringify({ id: `state-${index}`, type: "state", timestamp: 10 + index, data: { key: "x", value: index } }),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        JSON.stringify({
          id: `assistant-${index}`,
          type: "message",
          timestamp: 20 + index,
          data: { id: `a-${index}`, role: "assistant", content: [{ type: "text", text: `reply-${index}` }] },
        }),
      ),
      ...Array.from({ length: 6 }, (_, index) => eventLine(30 + index)),
    ];
    await withTempSession([userLine(0, "", "earlier"), userLine(1, "", "你好"), ...turn], async (filePath, channelRoot) => {
      const latest = await readConversationPage(filePath, "session.jsonl", channelRoot, { limit: 10 });
      expect(latest.entries[0]).toMatchObject({ kind: "user", text: "你好" });
      expect(latest.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(6);
      expect(latest.hasMore).toBe(true);
      const rest = await readConversationPage(filePath, "session.jsonl", channelRoot, { cursor: latest.nextCursor });
      expect(rest.entries.map((entry) => entry.text)).toEqual(["earlier"]);
      expect(rest.hasMore).toBe(false);
    });
  });

  it("clamps page size, validates cursors, and keeps fallback ids stable", async () => {
    await withTempSession(
      Array.from({ length: 60 }, (_, index) => userLine(index, "", undefined, index % 2 === 0)),
      async (filePath, channelRoot) => {
        const first = await readConversationPage(filePath, "session.jsonl", channelRoot, { limit: 100 });
        expect(first.entries).toHaveLength(50);

        const samePage = await readConversationPage(filePath, "session.jsonl", channelRoot, { limit: 50 });
        expect(samePage.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));

        await expect(readConversationPage(filePath, "session.jsonl", channelRoot, { limit: 0 })).rejects.toThrow("Invalid conversation limit");
        await expect(readConversationPage(filePath, "session.jsonl", channelRoot, { cursor: "not-a-cursor" })).rejects.toThrow("Invalid conversation cursor");
      },
    );
  });

  it("keeps ids stable when new records are appended", async () => {
    const line = (index: number) => userLine(index, "", undefined, index % 2 === 0);
    await withTempSession(
      Array.from({ length: 20 }, (_, index) => line(index)),
      async (filePath, channelRoot) => {
        const before = await readConversationPage(filePath, "session.jsonl", channelRoot);
        await writeFile(filePath, `${Array.from({ length: 22 }, (_, index) => line(index)).join("\n")}\n`, "utf8");
        const after = await readConversationPage(filePath, "session.jsonl", channelRoot);
        expect(after.entries.map((entry) => entry.text)).toEqual(Array.from({ length: 10 }, (_, index) => `message-${index + 12}`));
        const beforeIds = new Map(before.entries.map((entry) => [entry.text, entry.id]));
        for (const entry of after.entries) {
          if (beforeIds.has(entry.text)) expect(entry.id).toBe(beforeIds.get(entry.text));
        }
      },
    );
  });

  it("handles blank, malformed, and CRLF lines", async () => {
    await withTempContent(`\r\n${eventLine(0)}\r\nnot-json\r\nnull\r\n  \r\n${eventLine(1)}\r\n${eventLine(2)}\r\n`, async (filePath, channelRoot) => {
      const page = await readConversationPage(filePath, "session.jsonl", channelRoot);
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["event-0", "event-1", "event-2"]);
    });
  });
});

/** A message that arrived in a group: it opens a turn. */
function userLine(index: number, padding = "", text = `message-${index}${padding}`, withId = true): string {
  return JSON.stringify({
    ...(withId ? { id: `user-${index}` } : {}),
    type: "message",
    timestamp: index,
    data: {
      id: `message-${index}`,
      timestamp: index,
      role: "custom",
      type: "yesimbot.message",
      data: {
        platform: "onebot",
        selfId: "bot-1",
        channel: { id: "group-1", type: 0 },
        user: { id: "user-1", name: "小明" },
        timestamp: index,
        messageId: `platform-${index}`,
        parts: partsFromElements([{ type: "text", attrs: { content: text }, children: [] }]),
      },
    },
  });
}

function eventLine(index: number, withId = true, padding = ""): string {
  return JSON.stringify({
    ...(withId ? { id: `entry-${index}` } : {}),
    type: "event",
    timestamp: index,
    data: { type: `event-${index}`, padding },
  });
}

async function withTempSession(lines: string[], callback: (filePath: string, channelRoot: string) => Promise<void>): Promise<void> {
  return withTempContent(`${lines.join("\n")}\n`, callback);
}

async function withTempContent(content: string, callback: (filePath: string, channelRoot: string) => Promise<void>): Promise<void> {
  const channelRoot = await mkdtemp(join(tmpdir(), "yesimbot-console-"));
  const filePath = join(channelRoot, "session.jsonl");
  try {
    await writeFile(filePath, content, "utf8");
    await callback(filePath, channelRoot);
  } finally {
    await rm(channelRoot, { recursive: true, force: true });
  }
}
