import { EventEmitter } from "node:events";

import type { Part } from "@yesimbot/contracts/parts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Expectations taken from the Koishi path on 2026-11-25 (spec 09: records and NapCat calls match what Koishi did,
// except that a file goes as a file segment of send_*_msg). The Koishi side is gone; the values below are fixed.
import { OneBotAccount } from "../src/account.js";
import { inboundFromEvent } from "../src/inbound.js";
import type { OneBotEvent } from "../src/protocol.js";

type Reply = { status: string; retcode: number; data: unknown };

type NapCat = (action: string, params: Record<string, unknown>) => Reply;

interface Call {
  readonly action: string;
  readonly params: unknown;
}

const SELF_ID = "10001";
const ok = (data: unknown): Reply => ({ status: "ok", retcode: 0, data });

/** NapCat as the connector meets it: the login, the messages `get_msg` returns, file URLs, and IDs for what is sent. */
function napcat(messages: Record<string, unknown> = {}): NapCat {
  let next = 100;
  return (action, params) => {
    switch (action) {
      case "get_login_info":
        return ok({ user_id: Number(SELF_ID), nickname: "Athena" });
      case "get_msg": {
        const message = messages[String(params.message_id)];
        return message ? ok(message) : { status: "failed", retcode: 1200, data: null };
      }
      case "get_group_file_url":
        return ok({ url: `https://files.example/group/${params.file_id}` });
      case "get_private_file_url":
        return ok({ url: `https://files.example/private/${params.file_id}` });
      case "download_file":
        return ok({ file: "/napcat/cache/upload.bin" });
      case "upload_group_file":
      case "upload_private_file":
        return ok(null);
      default:
        return ok({ message_id: next++ });
    }
  };
}

/** The socket NapCat dialed, answering each action from `answer` as NapCat would. */
class NapCatSocket extends EventEmitter {
  readyState = 1;
  readonly calls: Call[] = [];

  public constructor(private readonly answer: NapCat) {
    super();
  }

  send(data: string) {
    const { action, params, echo } = JSON.parse(data) as { action: string; params: Record<string, unknown>; echo: string };
    if (action !== "get_login_info") this.calls.push({ action, params });
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ ...this.answer(action, params), echo })), false));
  }

  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }

  ping() {}
}

/** Channel resources that keep the parts as given: media goes to the kernel's `persistParts`. */
function resources() {
  return { persistParts: async (parts: readonly Part[]) => [...parts] } as never;
}

async function connectorInput(event: OneBotEvent, messages?: Record<string, unknown>) {
  const socket = new NapCatSocket(napcat(messages));
  const account = new OneBotAccount(SELF_ID, { clock: { now: () => Date.now() }, onEvent: () => {} });
  account.attach(socket as never);
  const inbound = inboundFromEvent(event, account, () => Date.now());
  if (!inbound) return { input: undefined, calls: socket.calls };
  const record = await inbound.translate(resources());
  return { input: { context: inbound.context, record: JSON.parse(JSON.stringify(record)) as unknown }, calls: socket.calls };
}

/** The input Core is handed for `event`, and the actions the connector sent to NapCat to read it. */
async function inputOf(event: OneBotEvent, messages?: Record<string, unknown>) {
  const { input, calls } = await connectorInput(event, messages);
  return { input: input ?? null, calls };
}

const sender = { user_id: 200, nickname: "小明", card: "群名片", role: "member" };
const group = (message: unknown, extra: Record<string, unknown> = {}): OneBotEvent => ({
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: 5001,
  group_id: 300,
  user_id: 200,
  self_id: Number(SELF_ID),
  time: 1_700_000_000,
  message,
  sender,
  ...extra,
});
const direct = (message: unknown, extra: Record<string, unknown> = {}): OneBotEvent => ({
  post_type: "message",
  message_type: "private",
  sub_type: "friend",
  message_id: 6001,
  user_id: 200,
  self_id: Number(SELF_ID),
  time: 1_700_000_100,
  message,
  sender: { user_id: 200, nickname: "小明", card: "" },
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("QQ input: what Core is handed for NapCat's events (adapter-onebot 6.9.4 + OneBotTranslator)", () => {
  it("text, pictures with the adapter's spaces, mentions, faces and segments Core does not know", async () => {
    const event = group([
      { type: "text", data: { text: "看" } },
      { type: "image", data: { file: "a.jpg", url: "https://multimedia.nt.qq.com.cn/a", sub_type: 1, file_size: "2048", summary: "[动画表情]" } },
      { type: "text", data: { text: "这个" } },
      { type: "at", data: { qq: "10001", name: "Athena" } },
      { type: "at", data: { qq: "all" } },
      { type: "face", data: { id: "14", raw: { faceIndex: 14 } } },
      { type: "face", data: { id: "99999" } },
      { type: "record", data: { file: "v.amr", path: "/napcat/v.amr", url: "https://x/v.amr", file_size: "10" } },
      { type: "video", data: { file: "v.mp4", url: "https://x/v.mp4" } },
      { type: "mface", data: { emoji_id: "e1", emoji_package_id: 7, key: "k", summary: "[开心]" } },
      { type: "reply", data: { id: "77" } },
      { type: "json", data: { data: '{"app":"x"}' } },
    ]);
    const result = await inputOf(event);
    expect(result).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000000000,
          channel: {
            id: "300",
            type: 0,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "5001",
          parts: [
            {
              type: "text",
              text: "看 ",
            },
            {
              type: "image",
              src: "https://multimedia.nt.qq.com.cn/a",
              subtype: 1,
              summary: "[动画表情]",
            },
            {
              type: "text",
              text: " 这个",
            },
            {
              type: "mention",
              userId: "10001",
              name: "Athena",
            },
            {
              type: "mention",
              scope: "all",
            },
            {
              type: "platform",
              tag: "face",
              attrs: {
                id: "14",
                name: "微笑",
                platform: "onebot",
              },
              parts: [
                {
                  type: "image",
                  src: "https://koishi.js.org/QFace/gif/s14.gif",
                },
              ],
            },
            {
              type: "platform",
              tag: "face",
              attrs: {
                id: "99999",
                platform: "onebot",
              },
              parts: [
                {
                  type: "image",
                  src: "",
                },
              ],
            },
            {
              type: "platform",
              tag: "audio",
              attrs: {
                src: "https://x/v.amr",
                file: "v.amr",
                path: "/napcat/v.amr",
                fileSize: "10",
              },
              parts: [],
            },
            {
              type: "video",
              src: "https://x/v.mp4",
            },
            {
              type: "platform",
              tag: "mface",
              attrs: {
                emojiId: "e1",
                emojiPackageId: 7,
                key: "k",
                summary: "[开心]",
              },
              parts: [],
            },
            {
              type: "platform",
              tag: "reply",
              attrs: {
                id: "77",
              },
              parts: [],
            },
            {
              type: "platform",
              tag: "json",
              attrs: {
                data: '{"app":"x"}',
              },
              parts: [],
            },
          ],
        },
      },
      calls: [],
    });
    const { parts } = result.input!.record as { parts: Part[] };
    expect(parts.map((part) => (part.type === "platform" ? part.tag : part.type))).toEqual([
      "text",
      "image",
      "text",
      "mention",
      "mention",
      "face",
      "face",
      "audio",
      "video",
      "mface",
      "reply",
      "json",
    ]);
    expect(parts[0]).toEqual({ type: "text", text: "看 " });
    expect(parts[2]).toEqual({ type: "text", text: " 这个" });
  });

  it("the CQ-code form NapCat posts when set to string", async () => {
    expect(await inputOf(group("前面[CQ:at,qq=10001]中间&#91;不是码&#93;[CQ:image,file=b.png,url=https://x/b.png?a=1&amp;b=2]后面"))).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000000000,
          channel: {
            id: "300",
            type: 0,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "5001",
          parts: [
            {
              type: "text",
              text: "前面",
            },
            {
              type: "mention",
              userId: "10001",
            },
            {
              type: "text",
              text: "中间[不是码] ",
            },
            {
              type: "image",
              src: "https://x/b.png?a=1&b=2",
            },
            {
              type: "text",
              text: " 后面",
            },
          ],
        },
      },
      calls: [],
    });
  });

  it("a direct message: the card, else the nickname, names the conversation", async () => {
    expect(await inputOf(direct([{ type: "text", data: { text: "在吗" } }]))).toEqual({
      input: {
        context: {
          type: "direct",
          platform: "onebot",
          channelId: "private:200",
          selfId: "10001",
          userId: "200",
          userName: "小明",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000100000,
          channel: {
            id: "private:200",
            type: 1,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "6001",
          parts: [
            {
              type: "text",
              text: "在吗",
            },
          ],
        },
      },
      calls: [],
    });
    expect(await inputOf(direct([{ type: "text", data: { text: "在吗" } }], { sender: { user_id: 200, nickname: "", card: "" } }))).toEqual({
      input: {
        context: {
          type: "direct",
          platform: "onebot",
          channelId: "private:200",
          selfId: "10001",
          userId: "200",
          userName: "200",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000100000,
          channel: {
            id: "private:200",
            type: 1,
          },
          user: {
            id: "200",
            name: "",
          },
          messageId: "6001",
          parts: [
            {
              type: "text",
              text: "在吗",
            },
          ],
        },
      },
      calls: [],
    });
  });

  it("a leading reply becomes the record's quote, read back with get_msg; a failed get_msg leaves no quote", async () => {
    const quoted = {
      message_id: 77,
      message_type: "group",
      message: [
        { type: "text", data: { text: "原话" } },
        { type: "image", data: { file: "q.jpg", url: "https://x/q.jpg" } },
      ],
      sender: { user_id: 300, nickname: "老王" },
      time: 1_699_999_000,
      group_id: 300,
    };
    const replying = (id: string) => [
      { type: "reply", data: { id } },
      { type: "text", data: { text: "回你" } },
    ];
    expect(await inputOf(group(replying("77")), { "77": quoted })).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000000000,
          channel: {
            id: "300",
            type: 0,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "5001",
          parts: [
            {
              type: "text",
              text: "回你",
            },
          ],
          quote: {
            messageId: "77",
            parts: [
              {
                type: "text",
                text: "原话 ",
              },
              {
                type: "image",
                src: "https://x/q.jpg",
              },
            ],
            author: {
              id: "300",
            },
          },
        },
      },
      calls: [
        {
          action: "get_msg",
          params: {
            message_id: 77,
          },
        },
      ],
    });
    expect(await inputOf(group(replying("78")))).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000000000,
          channel: {
            id: "300",
            type: 0,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "5001",
          parts: [
            {
              type: "text",
              text: "回你",
            },
          ],
        },
      },
      calls: [
        {
          action: "get_msg",
          params: {
            message_id: 78,
          },
        },
      ],
    });
  });

  it("files NapCat sends by ID get their URL from QQ, in a group and in a direct chat", async () => {
    expect(await inputOf(group([{ type: "file", data: { file: "报告.pdf", file_id: "/abc-123", file_size: "4096", busid: "102" } }]))).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000000000,
          channel: {
            id: "300",
            type: 0,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "5001",
          parts: [
            {
              type: "file",
              src: "https://files.example/group//abc-123",
              title: "报告.pdf",
            },
          ],
        },
      },
      calls: [
        {
          action: "get_group_file_url",
          params: {
            group_id: 300,
            file_id: "/abc-123",
            busid: 102,
          },
        },
      ],
    });
    expect(await inputOf(direct([{ type: "file", data: { file: "笔记.txt", file_id: "f-9", file_hash: "h1" } }]))).toEqual({
      input: {
        context: {
          type: "direct",
          platform: "onebot",
          channelId: "private:200",
          selfId: "10001",
          userId: "200",
          userName: "小明",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000100000,
          channel: {
            id: "private:200",
            type: 1,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "6001",
          parts: [
            {
              type: "file",
              src: "https://files.example/private/f-9",
              title: "笔记.txt",
            },
          ],
        },
      },
      calls: [
        {
          action: "get_private_file_url",
          params: {
            user_id: 200,
            file_id: "f-9",
            file_hash: "h1",
          },
        },
      ],
    });
    // The Koishi path asked for a group file's URL only with a textual busid; with a number the file stays as it came.
    expect(await inputOf(group([{ type: "file", data: { file: "报告.pdf", file_id: "/abc-123", busid: 102 } }]))).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          timestamp: 1700000000000,
          channel: {
            id: "300",
            type: 0,
          },
          user: {
            id: "200",
            name: "小明",
          },
          messageId: "5001",
          parts: [
            {
              type: "file",
              src: "报告.pdf",
              title: "报告.pdf",
            },
          ],
        },
      },
      calls: [
        {
          action: "get_msg",
          params: {
            message_id: 5001,
          },
        },
      ],
    });
  });

  it("a poke in a group is an event; a poke in a direct chat, notices without a record and the account's own messages are not", async () => {
    const poke = {
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      group_id: 300,
      user_id: 200,
      target_id: 10001,
      self_id: Number(SELF_ID),
      time: 1,
    };
    expect(await inputOf(poke)).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: {
          platform: "onebot",
          selfId: "10001",
          channel: {
            id: "300",
            type: 0,
          },
          timestamp: 1795507200000,
          eventType: "notice.poke",
          actorId: "200",
          targetId: "10001",
          action: "拍了拍",
          text: "200 拍了拍 10001",
        },
      },
      calls: [],
    });
    expect(await inputOf({ ...poke, group_id: undefined })).toEqual({
      input: null,
      calls: [],
    });
    expect(
      await inputOf({ post_type: "notice", notice_type: "group_recall", group_id: 300, user_id: 200, operator_id: 200, message_id: 9, self_id: 10001 }),
    ).toEqual({
      input: {
        context: {
          type: "guild",
          platform: "onebot",
          channelId: "300",
          guildId: "300",
          selfId: "10001",
        },
        record: null,
      },
      calls: [],
    });
    expect(await inputOf({ post_type: "notice", notice_type: "group_upload", group_id: 300, user_id: 200, self_id: 10001 })).toEqual({
      input: null,
      calls: [],
    });
    expect(await inputOf({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 10001 })).toEqual({
      input: null,
      calls: [],
    });
    expect(
      await inputOf(
        group([{ type: "text", data: { text: "我自己发的" } }], { post_type: "message_sent", user_id: 10001, sender: { user_id: 10001, nickname: "Athena" } }),
      ),
    ).toEqual({
      input: null,
      calls: [],
    });
  });
});

/** What the connector sent to NapCat for `parts`, and the message IDs it resolved with. */
async function sendOut(channelId: string, parts: readonly Part[]) {
  const socket = new NapCatSocket(napcat());
  const account = new OneBotAccount(SELF_ID, { clock: { now: () => Date.now() }, onEvent: () => {} });
  account.attach(socket as never);
  await vi.waitFor(() => expect(account.status).toBe(1));
  const ids = await account.sendMessage(channelId, parts);
  return { calls: socket.calls, ids };
}

describe("QQ output: what NapCat is sent for Core's parts (adapter-onebot 6.9.4)", () => {
  it("text, mentions and a picture go together, trimmed at the ends, a data URL as base64://", async () => {
    expect(
      await sendOut("300", [
        { type: "text", text: "  你好 " },
        { type: "mention", userId: "200", name: "小明" },
        { type: "text", text: "" },
        { type: "mention", scope: "all" },
        { type: "image", src: "data:image/png;base64,iVBORw0KGgo=", summary: "[图片]" },
        { type: "text", text: " \n" },
      ]),
    ).toEqual({
      calls: [
        {
          action: "send_group_msg",
          params: {
            group_id: 300,
            message: [
              {
                type: "text",
                data: {
                  text: "你好 ",
                },
              },
              {
                type: "at",
                data: {
                  qq: "200",
                  name: "小明",
                },
              },
              {
                type: "text",
                data: {
                  text: "",
                },
              },
              {
                type: "at",
                data: {
                  qq: "all",
                },
              },
              {
                type: "image",
                data: {
                  summary: "[图片]",
                  file: "base64://iVBORw0KGgo=",
                  cache: 0,
                },
              },
            ],
          },
        },
      ],
      ids: ["100"],
    });
  });

  it("a quote, voice or video starts another message; a direct chat sends to the QQ number", async () => {
    const sent = await sendOut("private:200", [
      { type: "quote", messageId: "55", parts: [] },
      { type: "text", text: "回复" },
      { type: "video", src: "https://x/v.mp4" },
      { type: "text", text: "后面" },
      { type: "platform", tag: "audio", attrs: { src: "https://x/v.amr" }, parts: [] },
    ]);
    expect(sent).toEqual({
      calls: [
        {
          action: "send_private_msg",
          params: {
            user_id: 200,
            message: [
              {
                type: "reply",
                data: {
                  id: "55",
                },
              },
              {
                type: "text",
                data: {
                  text: "回复",
                },
              },
            ],
          },
        },
        {
          action: "send_private_msg",
          params: {
            user_id: 200,
            message: [
              {
                type: "video",
                data: {
                  file: "https://x/v.mp4",
                  cache: 0,
                },
              },
              {
                type: "text",
                data: {
                  text: "后面",
                },
              },
            ],
          },
        },
        {
          action: "send_private_msg",
          params: {
            user_id: 200,
            message: [
              {
                type: "record",
                data: {
                  file: "https://x/v.amr",
                  cache: 0,
                },
              },
            ],
          },
        },
      ],
      ids: ["100", "101", "102"],
    });
    expect(sent.calls.map((call) => call.action)).toEqual(["send_private_msg", "send_private_msg", "send_private_msg"]);
  });

  // The one deliberate difference (spec 09 rule 3). NapCat (the pinned image's `napcat.mjs`) sends `upload_*_file` and a
  // file segment the same way, `createValidSendFileElement` then `sendMsgWithOb11UniqueId`; `upload_*_file` answers with
  // the file's ID, so adapter-onebot resolved a file with "" and Core could never confirm it. The Koishi path made the
  // calls send_group_msg, download_file, upload_group_file (group_id 300, file "/napcat/cache/upload.bin", name "a.txt"),
  // send_group_msg and the IDs ["100", "", "101"]; the connector's own calls and IDs are pinned here.
  it("a file starts another message too; the connector sends it as a file segment and gets its message ID", async () => {
    const sent = await sendOut("300", [
      { type: "text", text: "附件" },
      { type: "file", src: "data:text/plain;base64,aGk=", title: "a.txt" },
      { type: "text", text: "完" },
    ]);
    expect(sent).toEqual({
      calls: [
        {
          action: "send_group_msg",
          params: {
            group_id: 300,
            message: [
              {
                type: "text",
                data: {
                  text: "附件",
                },
              },
            ],
          },
        },
        {
          action: "download_file",
          params: {
            url: "data:text/plain;base64,aGk=",
          },
        },
        {
          action: "send_group_msg",
          params: {
            group_id: 300,
            message: [
              {
                type: "file",
                data: {
                  file: "/napcat/cache/upload.bin",
                  name: "a.txt",
                },
              },
            ],
          },
        },
        {
          action: "send_group_msg",
          params: {
            group_id: 300,
            message: [
              {
                type: "text",
                data: {
                  text: "完",
                },
              },
            ],
          },
        },
      ],
      ids: ["100", "101", "102"],
    });
    expect(sent.calls[2]).toEqual({
      action: "send_group_msg",
      params: { group_id: 300, message: [{ type: "file", data: { file: "/napcat/cache/upload.bin", name: "a.txt" } }] },
    });
    expect(sent.ids).toEqual(["100", "101", "102"]);
  });

  it("an animated sticker goes out as NapCat's animated emoji, byte for byte as the platform part it replaced", async () => {
    const sent = await sendOut("300", [{ type: "image", src: "data:image/gif;base64,R0lGODlh", title: "sticker.gif", sticker: true }]);
    expect(JSON.stringify(sent)).toBe(
      '{"calls":[{"action":"send_group_msg","params":{"group_id":300,"message":[{"type":"image","data":{"name":"sticker.gif","summary":"[动画表情]","subType":1,"file":"base64://R0lGODlh","cache":0}}]}}],"ids":["100"]}',
    );
  });

  it("markup the model may write: faces, line breaks, links, OneBot segments; what QQ has no segment for keeps its text only", async () => {
    const sent = await sendOut("300", [
      { type: "platform", tag: "face", attrs: { id: "14", name: "微笑", platform: "onebot" }, parts: [{ type: "image", src: "https://x/s14.gif" }] },
      { type: "platform", tag: "face", attrs: { id: "1", platform: "wechat-bridge" }, parts: [{ type: "text", text: "[微笑]" }] },
      { type: "text", text: "一行" },
      { type: "platform", tag: "br", attrs: {}, parts: [] },
      { type: "platform", tag: "p", attrs: {}, parts: [{ type: "text", text: "段落" }] },
      { type: "platform", tag: "a", attrs: { href: "https://example.com" }, parts: [{ type: "text", text: "链接" }] },
      { type: "platform", tag: "sharp", attrs: { id: "频道" }, parts: [] },
      { type: "platform", tag: "mface", attrs: { emojiId: "e1" }, parts: [] },
      { type: "platform", tag: "b", attrs: {}, parts: [{ type: "text", text: "粗" }] },
      { type: "platform", tag: "onebot:poke", attrs: { qq: "200" }, parts: [] },
    ]);
    expect(sent).toEqual({
      calls: [
        {
          action: "send_group_msg",
          params: {
            group_id: 300,
            message: [
              {
                type: "face",
                data: {
                  id: "14",
                },
              },
              {
                type: "text",
                data: {
                  text: "[微笑]",
                },
              },
              {
                type: "text",
                data: {
                  text: "一行",
                },
              },
              {
                type: "text",
                data: {
                  text: "\n",
                },
              },
              {
                type: "text",
                data: {
                  text: "段落",
                },
              },
              {
                type: "text",
                data: {
                  text: "\n",
                },
              },
              {
                type: "text",
                data: {
                  text: "链接",
                },
              },
              {
                type: "text",
                data: {
                  text: "（https://example.com）",
                },
              },
              {
                type: "text",
                data: {
                  text: "频道",
                },
              },
              {
                type: "text",
                data: {
                  text: "粗",
                },
              },
            ],
          },
        },
        {
          action: "send_group_msg",
          params: {
            group_id: 300,
            message: [
              {
                type: "poke",
                data: {
                  qq: "200",
                },
              },
            ],
          },
        },
      ],
      ids: ["100", "101"],
    });
    // A OneBot segment goes after what came before it was sent.
    expect(sent.calls.map((call) => call.action)).toEqual(["send_group_msg", "send_group_msg"]);
  });

  it("a figure of messages goes as a merged forward", async () => {
    const sent = await sendOut("300", [
      {
        type: "platform",
        tag: "figure",
        attrs: {},
        parts: [
          {
            type: "platform",
            tag: "message",
            attrs: {},
            parts: [
              { type: "platform", tag: "author", attrs: { id: "200", name: "小明" }, parts: [] },
              { type: "text", text: "第一条" },
            ],
          },
          { type: "platform", tag: "message", attrs: { id: "4321" }, parts: [] },
        ],
      },
    ]);
    expect(sent.calls).toEqual([
      {
        action: "send_group_forward_msg",
        params: {
          group_id: 300,
          messages: [
            { type: "node", data: { name: "小明", uin: "200", content: [{ type: "text", data: { text: "第一条" } }], time: "1795507200" } },
            { type: "node", data: { id: "4321" } },
          ],
        },
      },
    ]);
    expect(sent.ids).toEqual(["100"]);
  });
});

describe("QQ actions: what the connector declares for plugins (spec 09 rule 6)", () => {
  /** NapCat answering every OneBot action plugins use; set_group_kick is refused. */
  const answer: NapCat = (action, params) =>
    action === "set_group_kick"
      ? { status: "failed", retcode: 1404, data: null }
      : action === "get_forward_msg"
        ? ok({ messages: [{ id: params.message_id }] })
        : ok({ action, message_id: 9 });
  const inputs: Record<string, Record<string, unknown>> = {
    get_forward_msg: { message_id: "12345" },
    get_image: { file: "a.jpg" },
    send_group_forward_msg: { group_id: "300", messages: [] },
    send_private_forward_msg: { user_id: "200", messages: [] },
    set_essence_msg: { message_id: "9" },
    set_msg_emoji_like: { message_id: "9", emoji_id: "76" },
    ocr_image: { image: "https://example.test/a.png" },
    set_qq_profile: { nickname: "Athena" },
    set_qq_avatar: { file: "https://example.test/a.png" },
    set_group_ban: { group_id: 300, user_id: 200, duration: 60 },
    set_group_kick: { group_id: 300, user_id: 200, reject_add_request: false },
    get_group_member_info: { group_id: 300, user_id: 200, no_cache: true },
  };
  const outcomes = async (actions: Readonly<Record<string, ((input: Record<string, unknown>) => Promise<unknown>) | undefined>> | undefined) => {
    const results: Record<string, unknown> = {};
    for (const [name, input] of Object.entries(inputs))
      results[name] = await actions![`onebot.${name}`]!(input).then(
        (data) => ({ data }),
        () => "refused",
      );
    return results;
  };

  it("the actions, the frames sent to NapCat, the answers and the refusals", async () => {
    const socket = new NapCatSocket(answer);
    const account = new OneBotAccount(SELF_ID, { clock: { now: () => Date.now() }, onEvent: () => {} });
    account.attach(socket as never);
    expect(Object.keys(inputs).map((name) => `onebot.${name}`)).toEqual(Object.keys(account.actions));
    const results = await outcomes(account.actions);
    expect({ names: Object.keys(account.actions), results, frames: socket.calls }).toEqual({
      names: [
        "onebot.get_forward_msg",
        "onebot.get_image",
        "onebot.send_group_forward_msg",
        "onebot.send_private_forward_msg",
        "onebot.set_essence_msg",
        "onebot.set_msg_emoji_like",
        "onebot.ocr_image",
        "onebot.set_qq_profile",
        "onebot.set_qq_avatar",
        "onebot.set_group_ban",
        "onebot.set_group_kick",
        "onebot.get_group_member_info",
      ],
      results: {
        get_forward_msg: {
          data: {
            messages: [
              {
                id: 12345,
              },
            ],
          },
        },
        get_image: {
          data: {
            action: "get_image",
            message_id: 9,
          },
        },
        send_group_forward_msg: {
          data: {
            action: "send_group_forward_msg",
            message_id: 9,
          },
        },
        send_private_forward_msg: {
          data: {
            action: "send_private_forward_msg",
            message_id: 9,
          },
        },
        set_essence_msg: {
          data: {
            action: "set_essence_msg",
            message_id: 9,
          },
        },
        set_msg_emoji_like: {
          data: {
            action: "set_msg_emoji_like",
            message_id: 9,
          },
        },
        ocr_image: {
          data: {
            action: "ocr_image",
            message_id: 9,
          },
        },
        set_qq_profile: {
          data: {
            action: "set_qq_profile",
            message_id: 9,
          },
        },
        set_qq_avatar: {
          data: {
            action: "set_qq_avatar",
            message_id: 9,
          },
        },
        set_group_ban: {
          data: {
            action: "set_group_ban",
            message_id: 9,
          },
        },
        set_group_kick: "refused",
        get_group_member_info: {
          data: {
            action: "get_group_member_info",
            message_id: 9,
          },
        },
      },
      frames: [
        {
          action: "get_forward_msg",
          params: {
            message_id: 12345,
          },
        },
        {
          action: "get_image",
          params: {
            file: "a.jpg",
          },
        },
        {
          action: "send_group_forward_msg",
          params: {
            group_id: 300,
            messages: [],
          },
        },
        {
          action: "send_private_forward_msg",
          params: {
            user_id: 200,
            messages: [],
          },
        },
        {
          action: "set_essence_msg",
          params: {
            message_id: 9,
          },
        },
        {
          action: "set_msg_emoji_like",
          params: {
            message_id: 9,
            emoji_id: 76,
          },
        },
        {
          action: "ocr_image",
          params: {
            image: "https://example.test/a.png",
          },
        },
        {
          action: "set_qq_profile",
          params: {
            nickname: "Athena",
          },
        },
        {
          action: "set_qq_avatar",
          params: {
            file: "https://example.test/a.png",
          },
        },
        {
          action: "set_group_ban",
          params: {
            group_id: 300,
            user_id: 200,
            duration: 60,
          },
        },
        {
          action: "set_group_kick",
          params: {
            group_id: 300,
            user_id: 200,
            reject_add_request: false,
          },
        },
        {
          action: "get_group_member_info",
          params: {
            group_id: 300,
            user_id: 200,
            no_cache: true,
          },
        },
      ],
    });
    expect(results.set_group_kick).toBe("refused");
    expect(socket.calls.find((call) => call.action === "get_forward_msg")).toEqual({ action: "get_forward_msg", params: { message_id: 12345 } });
  });
});
