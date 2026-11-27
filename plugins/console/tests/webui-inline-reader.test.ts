import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import { expect, it } from "vitest";
import * as vue from "vue";

import ChatMarkdown from "../web/src/components/ChatMarkdown.vue";
import ConversationRecordDialog from "../web/src/components/ConversationRecordDialog.vue";
import * as recordDetails from "../web/src/lib/conversation-record";
import * as replies from "../web/src/lib/conversation-replies";
import * as formatting from "../web/src/lib/format";
import * as navigation from "../web/src/lib/history-navigation";
import { readableMessageText, senderNames } from "../web/src/lib/message-text";
import * as detailModel from "../web/src/pages/conversation-detail-model";
import BrandMark from "../web/src/shell/BrandMark.vue";
import type { ConversationDetail, ConversationRequest } from "../web/src/state/history-types";
import { ui } from "./fixtures/ui";

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await vue.nextTick();
};

function payload(text: string, more = false): ConversationDetail {
  return {
    entries: [{ id: text, kind: "user", timestamp: 1, text }],
    summary: { messageCount: 1, thoughtCount: 0, toolCallCount: 0, errorCount: 0, sizeBytes: 1 },
    hasMore: more,
    nextCursor: more ? "older" : undefined,
  } as ConversationDetail;
}

function reader(embedded = true) {
  const requests: { request: ConversationRequest; resolve: (result: ConversationDetail) => void }[] = [];
  const props = vue.reactive({
    embedded,
    channel: "A",
    session: "a.jsonl",
    listPath: "/xiaoheihe",
    listLabel: "小黑盒",
    loadPage: (request: ConversationRequest) => new Promise<ConversationDetail>((resolve) => requests.push({ request, resolve })),
  });
  const route = vue.reactive({ params: { channel: "QQ", session: "qq.jsonl" }, query: {} });
  const state: Record<string, vue.Ref> = {};
  let mount: () => void = () => {};
  let unmount: () => void = () => {};
  let poll: () => void = () => {};
  let cleared = false;
  const document = { visibilityState: "visible" };
  const { descriptor } = parse(readFileSync(new URL("../web/src/pages/ConversationDetail.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "inline-reader" });
  const module = {
    exports: {} as {
      default: {
        setup: (
          props: unknown,
          context: { expose: () => void },
        ) => {
          detail: vue.Ref<ConversationDetail | undefined>;
          loadMore: () => Promise<void>;
          timelineScroller: vue.Ref<HTMLElement | null>;
          runtimeDetails: vue.Ref<boolean>;
          recordDetail: vue.Ref<recordDetails.ConversationRecordDetail | undefined>;
          openRecord(node: detailModel.MainNode, event: MouseEvent, thoughtOnly?: boolean): void;
          visibleGroups: vue.ComputedRef<{ mainNodes: { kind: string; thought?: string; reply?: string; delivery?: string; unsupportedParts?: boolean }[] }[]>;
        };
      };
    },
  };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    document,
    window: {
      setInterval: (callback: () => void) => {
        poll = callback;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    },
    require: (name: string) =>
      ({
        vue: {
          ...vue,
          onMounted: (callback: () => void) => {
            mount = callback;
          },
          onBeforeUnmount: (callback: () => void) => {
            unmount = callback;
          },
        },
        "vue-router": { useRoute: () => route, useRouter: () => ({ push: () => {} }) },
        "../lib/route-state": { useRouteState: (key: string, fallback: unknown) => (state[key] ??= vue.ref(fallback)) },
        "../lib/history-navigation": navigation,
        "../lib/format": formatting,
        "../lib/conversation-replies": replies,
        "../lib/conversation-record": recordDetails,
        "../components/ChatMarkdown.vue": { default: ChatMarkdown },
        "../components/ConversationRecordDialog.vue": { default: ConversationRecordDialog },
        "../shell/BrandMark.vue": { default: BrandMark },
        "./conversation-detail-model": detailModel,
      })[name] ?? ui(name),
  });
  const templateModule = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: "ConversationDetail.vue",
    id: "inline-reader",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  runInNewContext(ts.transpileModule(template.code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module: templateModule,
    exports: templateModule.exports,
    require: () => vue,
  });
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup(props, { expose: () => {} }))!;
  mount();
  return {
    render: () => {
      const app = vue.createSSRApp({ render: () => templateModule.exports.render({}, [], props, vue.proxyRefs(view)) });
      app.component("RouterLink", { render: () => null });
      return renderToString(app);
    },
    props,
    route,
    view,
    requests,
    state,
    poll: () => poll(),
    document,
    cleared: () => cleared,
    stop: () => {
      unmount();
      scope.stop();
    },
  };
}

it("uses explicit inline identity, rejects A→B→A replies, and keeps record filters separate", async () => {
  const r = reader();
  try {
    expect(r.requests[0].request.channel).toBe("A");
    expect(Object.keys(r.state)).toEqual(["recordQ", "recordType"]);
    r.props.channel = "B";
    r.props.channel = "A";
    expect(r.requests).toHaveLength(3);
    r.requests[0].resolve(payload("stale A"));
    r.requests[1].resolve(payload("stale B"));
    await flush();
    expect(r.view.detail.value).toBeUndefined();
    r.requests[2].resolve(payload("current A", true));
    await flush();
    expect(r.view.detail.value.entries[0].text).toBe("current A");
    r.props.session = "older.jsonl";
    expect(r.view.detail.value).toBeUndefined();
    expect(r.requests[3].request.session).toBe("older.jsonl");
  } finally {
    r.stop();
  }
});

it("loads older records, discards pagination races and cleans the sole polling loop", async () => {
  const r = reader();
  r.requests[0].resolve(payload("newest", true));
  await flush();
  await flush();
  const more = r.view.loadMore();
  expect(r.requests[1].request.cursor).toBe("older");
  r.requests[1].resolve(payload("old"));
  await more;
  expect(r.view.detail.value.entries.map((entry: { text: string }) => entry.text)).toEqual(["old", "newest"]);
  r.document.visibilityState = "hidden";
  r.poll();
  expect(r.requests).toHaveLength(2);
  r.document.visibilityState = "visible";
  r.poll();
  r.poll();
  expect(r.requests).toHaveLength(3);
  r.requests[2].resolve(payload("poll", true));
  await flush();
  await flush();
  // A new identity must invalidate an older-page response as well as a poll.
  r.props.session = "other.jsonl";
  r.requests[3].resolve(payload("other", true));
  await flush();
  await flush();
  const staleMore = r.view.loadMore();
  r.props.channel = "B";
  r.requests[4].resolve(payload("stale older"));
  await staleMore;
  expect(r.view.detail.value).toBeUndefined();
  r.stop();
  expect(r.cleared()).toBe(true);
  r.requests[5].resolve(payload("disposed"));
  await flush();
  expect(r.view.detail.value).toBeUndefined();
});

it("preserves standalone route identity and its existing query fields", async () => {
  const r = reader(false);
  try {
    expect(r.requests[0].request).toMatchObject({ channel: "QQ", session: "qq.jsonl" });
    expect(Object.keys(r.state)).toEqual(["q", "filter"]);
    r.route.params.session = "next.jsonl";
    expect(r.requests[1].request.session).toBe("next.jsonl");
  } finally {
    r.stop();
  }
});

it.each([true, false])("renders assistant Markdown through the page's own import (embedded=%s)", async (embedded) => {
  const r = reader(embedded);
  try {
    const data = payload("peer");
    data.entries.push({ id: "reply", kind: "assistant", timestamp: 2, text: "助手可见 **完整回复**" });
    r.requests[0].resolve(data);
    await flush();
    const html = await r.render();
    expect(html).toContain('class="chat-markdown"');
    expect(html).toContain("助手可见 <strong>完整回复</strong>");
  } finally {
    r.stop();
  }
});

it("retains a merged thought for its independent record dialog beside the assistant reply", async () => {
  const r = reader();
  try {
    const result = payload("user");
    result.entries.push(
      { id: "thought", kind: "thought", timestamp: 2, text: "private reasoning", groupKey: "turn" },
      { id: "reply", kind: "assistant", timestamp: 3, text: "visible reply", groupKey: "turn" },
    );
    r.requests[0].resolve(result);
    await flush();
    expect(r.view.visibleGroups.value[0].mainNodes[1]).toMatchObject({
      kind: "assistant",
      thought: "private reasoning",
      reply: "visible reply",
    });
    const source = readFileSync(new URL("../web/src/pages/ConversationDetail.vue", import.meta.url), "utf8");
    const assistant = source.split("v-else-if=\"node.kind === 'assistant'\"")[1].split("</template>")[0];
    expect(assistant).toContain('v-if="node.thought"');
    expect(assistant).toContain("openRecord(node, $event, true)");
    expect(assistant).not.toContain("{{ node.thought }}");
    const node = r.view.visibleGroups.value[0].mainNodes[1] as detailModel.MainNode;
    r.view.openRecord(node, { currentTarget: null } as unknown as MouseEvent, true);
    expect(r.view.recordDetail.value!.sections).toEqual([{ title: "思考内容", text: "private reasoning" }]);
  } finally {
    r.stop();
  }
});

it("shows compact tool event rows and reads full arguments and results through their shared detail", async () => {
  const r = reader();
  try {
    const data = payload("peer");
    data.entries.push(
      { id: "call", kind: "tool-call", timestamp: 2, toolCallId: "read-1", toolName: "read_file", args: { path: "private-notes.md" } },
      { id: "result", kind: "tool-result", timestamp: 3, toolCallId: "read-1", toolName: "read_file", result: { content: "完整文件结果" } },
    );
    r.requests[0]!.resolve(data);
    await flush();
    r.view.runtimeDetails.value = true;
    await vue.nextTick();
    const html = await r.render();
    expect(html).toContain("read_file");
    expect(html).toContain("查看详情");
    expect(html).not.toContain("private-notes.md");
    expect(html).not.toContain("完整文件结果");
    const call = r.view.visibleGroups.value.flatMap((group) => group.mainNodes).find((node) => node.kind === "tool-call") as detailModel.MainNode;
    r.view.openRecord(call, { currentTarget: null } as unknown as MouseEvent);
    expect(r.view.recordDetail.value!.sections.map((section) => section.text).join("\n")).toContain("private-notes.md");
    expect(r.view.recordDetail.value!.sections.map((section) => section.text).join("\n")).toContain("完整文件结果");
    r.props.channel = "another";
    expect(r.view.recordDetail.value).toBeUndefined();
  } finally {
    r.stop();
  }
});

for (const [result, status] of [
  [{ type: "json", value: JSON.stringify({ ok: true, messageIds: ["posted"] }) }, "已发送"],
  [{ ok: false }, "发送失败"],
  [undefined, "等待发送结果"],
  [{ type: "json", value: "malformed" }, "发送结果未知"],
] as const) {
  it(`projects production event/send_message/result into readable text: ${status}`, async () => {
    const r = reader();
    try {
      const data = payload("unused");
      data.entries = [
        { id: "event", kind: "event", eventType: "xiaoheihe.thread", timestamp: 1 },
        {
          id: "call",
          kind: "tool-call",
          toolName: "send_message",
          toolCallId: "send-1",
          timestamp: 2,
          args: {
            parts: [
              { kind: "text", text: '<script>alert("unsafe")</script>实际回复' },
              { kind: "unknown", url: "javascript:alert(1)" },
            ],
          },
        },
        ...(result === undefined ? [] : [{ id: "result", kind: "tool-result" as const, toolCallId: "send-1", timestamp: 3, result }]),
      ];
      r.requests[0].resolve(data);
      await flush();
      const nodes = r.view.visibleGroups.value.flatMap((group) => group.mainNodes);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ kind: "assistant", reply: '<script>alert("unsafe")</script>实际回复', delivery: status, unsupportedParts: true });
      const html = await r.render();
      expect(html).toContain("实际回复");
      expect(html).toContain(status);
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("调用 <code>");
      expect(html).not.toContain("已加载");
      expect(html).not.toContain("条消息");
      r.view.runtimeDetails.value = true;
      await vue.nextTick();
      expect(r.view.visibleGroups.value.flatMap((group) => group.mainNodes).map((node) => node.kind)).toEqual(
        result === undefined ? ["event", "tool-call"] : ["event", "tool-call", "tool-result"],
      );
    } finally {
      r.stop();
    }
  });
}

it("deduplicates only the same turn's assistant text and preserves unknown send payloads", () => {
  const entries = [
    { id: "assistant", kind: "assistant" as const, timestamp: 1, text: "reply" },
    { id: "call", kind: "tool-call" as const, timestamp: 2, toolName: "send_message", toolCallId: "id", args: { parts: [{ kind: "text", text: "reply" }] } },
    { id: "result", kind: "tool-result" as const, timestamp: 3, toolCallId: "id", error: { message: "failed" } },
    { id: "event", kind: "event" as const, timestamp: 4, eventType: "xiaoheihe.thread" },
    { id: "next", kind: "assistant" as const, timestamp: 5, text: "reply" },
    {
      id: "unknown",
      kind: "tool-call" as const,
      timestamp: 6,
      toolName: "send_message",
      args: { parts: [{ kind: "image", url: "https://external.example" }] },
    },
  ];
  expect(replies.readableReplies(entries)).toMatchObject([
    { id: "call", text: "reply", delivery: "发送失败" },
    { id: "next", text: "reply" },
    { id: "unknown", unsupportedParts: true, delivery: "等待发送结果" },
  ]);
});

it("reads a web chat send's Markdown messages and drops their delivered copies", () => {
  const entries = [
    { id: "user", kind: "user" as const, timestamp: 1, text: "给我一个表格" },
    {
      id: "call",
      kind: "tool-call" as const,
      timestamp: 2,
      toolName: "send_message",
      toolCallId: "id",
      args: { messages: ["下面是表格：\n\n| a | b |\n| --- | --- |\n| 1 | 2 |", "还有一句"] },
    },
    { id: "copy1", kind: "assistant" as const, timestamp: 3, text: "下面是表格：", messageId: "m1" },
    { id: "copy2", kind: "assistant" as const, timestamp: 3, text: "还有一句", messageId: "m2" },
    { id: "result", kind: "tool-result" as const, timestamp: 4, toolCallId: "id", result: { ok: true, messageIds: ["m1", "m2"], count: 2 } },
  ];
  expect(replies.readableReplies(entries)).toMatchObject([
    { id: "user" },
    { id: "call", kind: "assistant", text: "下面是表格：\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n还有一句", delivery: "已发送", unsupportedParts: false },
  ]);
});

it("retains repeated real replies in the same stored group and deduplicates one assistant per send", async () => {
  const r = reader();
  try {
    const data = payload("unused");
    data.entries = [
      { id: "a1", kind: "assistant", timestamp: 1, text: "repeated", groupKey: "group" },
      { id: "a2", kind: "assistant", timestamp: 2, text: "repeated", groupKey: "group" },
      { id: "call1", kind: "tool-call", timestamp: 3, toolName: "send_message", groupKey: "group", args: { parts: [{ kind: "text", text: "repeated" }] } },
      { id: "call2", kind: "tool-call", timestamp: 4, toolName: "send_message", groupKey: "group", args: { parts: [{ kind: "text", text: "different" }] } },
    ];
    r.requests[0].resolve(data);
    await flush();
    const html = await r.render();
    expect(html.match(/<p>repeated<\/p>/g)).toHaveLength(2);
    expect(html).toContain("<p>different</p>");
  } finally {
    r.stop();
  }
});

it("hides a send's platform copies by the message IDs in its result, including multi-part and attachment replies", () => {
  const sent = { type: "json", value: { ok: true, messageIds: ["m1", "m2", "m3"], count: 3 } };
  const entries = [
    { id: "user", kind: "user" as const, timestamp: 1, text: "hi", messageId: "u1" },
    {
      id: "call",
      kind: "tool-call" as const,
      timestamp: 2,
      toolName: "send_message",
      toolCallId: "c1",
      args: {
        parts: [
          { kind: "text", text: "first part" },
          { kind: "text", text: "second part" },
          { kind: "image", url: "file:///chart.png" },
        ],
      },
    },
    { id: "p1", kind: "assistant" as const, eventType: "platform-message", timestamp: 3, text: "first part", messageId: "m1" },
    { id: "p2", kind: "assistant" as const, eventType: "platform-message", timestamp: 4, text: "second part", messageId: "m2" },
    {
      id: "p3",
      kind: "assistant" as const,
      eventType: "platform-message",
      timestamp: 5,
      text: "",
      messageId: "m3",
      assets: [{ id: "", kind: "image" as const, title: "chart.png", size: 0 }],
    },
    { id: "result", kind: "tool-result" as const, timestamp: 6, toolCallId: "c1", result: sent },
    // Not produced by this send: still shown.
    { id: "other", kind: "assistant" as const, eventType: "platform-message", timestamp: 7, text: "notice", messageId: "m9" },
  ];
  expect(replies.readableReplies(entries).map((entry) => entry.id)).toEqual(["user", "call", "other"]);
  // A failed send proves no delivery, so its platform copies are not hidden by ID.
  const failed = entries.map((entry) => (entry.id === "result" ? { ...entry, result: { type: "json", value: { ok: false, messageIds: ["m1"] } } } : entry));
  expect(replies.readableReplies(failed).map((entry) => entry.id)).toContain("p1");
});

it("keeps identical text from explicitly different turns or source sessions", () => {
  const call = {
    id: "call",
    kind: "tool-call" as const,
    timestamp: 3,
    turnId: "turn2",
    sourceSession: "session2",
    toolName: "send_message",
    args: { parts: [{ kind: "text", text: "same" }] },
  };
  expect(
    replies.readableReplies([
      { id: "turn1", kind: "assistant", timestamp: 1, turnId: "turn1", sourceSession: "session2", text: "same" },
      { id: "session1", kind: "assistant", timestamp: 2, turnId: "turn2", sourceSession: "session1", text: "same" },
      call,
    ]),
  ).toHaveLength(3);
});

it("keeps the user's reading position when they scroll up while a poll is pending, then follows again at the bottom", async () => {
  const r = reader();
  try {
    r.requests[0]!.resolve(payload("initial", true));
    await flush();
    const scroller = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 } as HTMLElement;
    r.view.timelineScroller.value = scroller;
    r.poll();
    scroller.scrollTop = 200;
    r.requests[1]!.resolve(payload("new reply"));
    await flush();
    expect(scroller.scrollTop).toBe(200);
    r.poll();
    scroller.scrollTop = 800;
    r.requests[2]!.resolve(payload("another reply"));
    await flush();
    expect(scroller.scrollTop).toBe(1000);
  } finally {
    r.stop();
  }
});

it("does not treat reading a little above the bottom as following the latest messages", async () => {
  const r = reader();
  try {
    r.requests[0]!.resolve(payload("initial"));
    await flush();
    const scroller = { scrollTop: 760, scrollHeight: 1000, clientHeight: 200 } as HTMLElement;
    r.view.timelineScroller.value = scroller;
    r.poll();
    r.requests[1]!.resolve(payload("new reply"));
    await flush();
    expect(scroller.scrollTop).toBe(760);
  } finally {
    r.stop();
  }
});

it("anchors prepended history to the position reached while older records were loading", async () => {
  const r = reader();
  try {
    r.requests[0]!.resolve(payload("initial", true));
    await flush();
    let top = 100;
    const scroller = {
      get scrollTop() {
        return top;
      },
      set scrollTop(value: number) {
        top = value;
      },
      get scrollHeight() {
        return r.view.detail.value!.entries.length * 500;
      },
      clientHeight: 200,
    } as HTMLElement;
    r.view.timelineScroller.value = scroller;
    const pending = r.view.loadMore();
    top = 50;
    r.requests[1]!.resolve(payload("older"));
    await pending;
    expect(top).toBe(550);
  } finally {
    r.stop();
  }
});

it("shows confirmed send_message text in the standalone chat filter while keeping original tool traces", async () => {
  const r = reader(false);
  try {
    const data = payload("peer");
    data.entries.push(
      {
        id: "send",
        kind: "tool-call",
        timestamp: 2,
        toolName: "send_message",
        toolCallId: "s",
        args: {
          parts: [
            { kind: "text", text: "第一段" },
            { kind: "text", text: "第二段" },
          ],
        },
      },
      { id: "sent", kind: "tool-result", timestamp: 3, toolCallId: "s", result: { type: "json", value: { ok: true, count: 2 } } },
    );
    r.requests[0].resolve(data);
    await flush();
    expect(await r.render()).toContain("第一段");
    r.state.filter.value = "chat";
    await vue.nextTick();
    const html = await r.render();
    expect(html).toContain("第二段");
    expect(html).toContain("已发送");
    expect(html).not.toContain("调用 <code>");
    r.state.filter.value = "tool";
    await vue.nextTick();
    expect(await r.render()).toContain("send_message");
  } finally {
    r.stop();
  }
});

it("folds repeated policy decisions into one line in the 全部 view and keeps each under 事件", async () => {
  const r = reader(false);
  try {
    const data = payload("peer");
    data.entries.push(
      { id: "w1", kind: "will", timestamp: 2, decision: "wait", willDebug: { score: 1 } },
      { id: "w2", kind: "will", timestamp: 3, decision: "wait", willDebug: { score: 2 } },
      { id: "w3", kind: "will", timestamp: 4, decision: "trigger" },
    );
    r.requests[0].resolve(data);
    await flush();
    const nodes = r.view.visibleGroups.value[0].mainNodes as { kind: string; repeats?: unknown[] }[];
    expect(nodes.map((node) => [node.kind, node.repeats?.length])).toEqual([
      ["user", undefined],
      ["will", 2],
      ["will", undefined],
    ]);
    const html = await r.render();
    expect(html.match(/继续等待/g)).toHaveLength(1);
    expect(html).toContain("× 2");
    expect(html).toContain("决定回复");
    expect(html).toContain("策略参数");
    expect(nodes[1].repeats).toEqual(expect.arrayContaining([expect.objectContaining({ willDebug: { score: 2 } })]));
    r.state.filter.value = "event";
    await vue.nextTick();
    expect(r.view.visibleGroups.value[0].mainNodes).toHaveLength(3);
    expect((await r.render()).match(/继续等待/g)).toHaveLength(2);
  } finally {
    r.stop();
  }
});

it("shows mentions and stickers as a person saw them, and searches that text", async () => {
  const r = reader(false);
  try {
    const data = payload("unused");
    data.entries = [
      { id: "a", kind: "user", timestamp: 1, sender: "time killer (111222333)", text: "那我续费关一下?" },
      { id: "b", kind: "user", timestamp: 2, sender: "ZETA (1049700117)", text: '<at id="111222333"/> 苹果那边不用充了捏 &lt;3' },
      { id: "c", kind: "user", timestamp: 3, sender: "ZETA (1049700117)", text: `[动画表情: [动画表情] asset://${"c".repeat(32)}]` },
    ];
    r.requests[0].resolve(data);
    await flush();
    const html = await r.render();
    expect(html).toContain("@time killer 苹果那边不用充了捏 &lt;3");
    expect(html).toContain("<p>[动画表情]</p>");
    expect(html).not.toContain("asset://");
    expect(html).not.toContain("&lt;at");
    r.state.q.value = "@time killer";
    await vue.nextTick();
    expect(r.view.visibleGroups.value).toHaveLength(1);
  } finally {
    r.stop();
  }
});

it("turns Koishi markup and resource placeholders into readable text without producing markup", () => {
  const names = senderNames(["小明 (42)", undefined, "不是格式"]);
  expect(readableMessageText('<at id="42"/> <at id="7" name="小红"/> <at id="9"/> <at type="all"/>', names)).toBe("@小明 @小红 @9 @全体成员");
  expect(readableMessageText(`看 [图片：asset://${"a".repeat(32)}] 和 [文件：报告.pdf asset://${"b".repeat(32)}]`)).toBe("看 [图片] 和 [文件：报告.pdf]");
  expect(readableMessageText(`[动画表情: 哈哈 asset://${"d".repeat(32)}]`)).toBe("[动画表情: 哈哈]");
  expect(readableMessageText('<quote id="1"><author name="甲"/>原话</quote>回复<face id="1" name="微笑"/><audio url="x"/>')).toBe(
    "「原话」回复[表情：微笑][语音]",
  );
  expect(readableMessageText("a &amp;lt;script&amp;gt; b")).toBe("a &lt;script&gt; b");
  expect(readableMessageText("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>");
});
