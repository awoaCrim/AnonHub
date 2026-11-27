import { partsFromElements } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { mergeRequests, runMaintenance } from "../src/maintainer.js";
import { messageText } from "../src/visibility.js";

const harness = vi.hoisted(() => ({ prompt: "" }));
vi.mock("@yesimbot/agent-runtime", () => ({
  jsonSchema: (schema: unknown) => schema,
  createUserMessage: (text: string) => text,
  createAgent: () => ({
    init: async () => {},
    wait: async () => {},
    stop: async () => {},
    async *run(prompt: string) {
      harness.prompt = prompt;
      yield {};
    },
  }),
}));

const assetId = "0123456789abcdef0123456789abcdef";
// Shapes as read back from JSONL: plain objects, never live elements.
const persisted = [
  { type: "text", attrs: { content: "看这张图 " }, children: [] },
  { type: "img", attrs: { id: assetId }, children: [] },
  { type: "text", attrs: { content: " " }, children: [] },
  { type: "at", attrs: { id: "42", name: "小明" }, children: [] },
  { type: "text", attrs: { content: " 我长期偏好简洁中文回答" }, children: [] },
];
const context = { type: "direct", platform: "web", selfId: "bot", channelId: "owner", userId: "owner" } as const;
const record = (id: string, elements: unknown[]) => ({
  messageId: id,
  platform: "web",
  selfId: "bot",
  channel: { id: "owner", type: 1 },
  user: { id: "owner" },
  timestamp: 1,
  parts: partsFromElements(elements),
});

describe("evidence text from persisted parts", () => {
  it("renders text, image and mention nodes readably", () => {
    const text = messageText({ parts: partsFromElements(persisted) });
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("看这张图");
    expect(text).toContain(`asset://${assetId}`);
    expect(text).toContain("小明");
    expect(text).toContain("我长期偏好简洁中文回答");
  });

  it("keeps plain strings and does not throw on malformed nodes", () => {
    expect(messageText({ parts: partsFromElements(["hello", { type: "text", attrs: { content: "world" }, children: [] }]) })).toBe("helloworld");
    expect(() => messageText({ parts: [{}, null] } as never)).not.toThrow();
  });

  it("sends real text in the maintenance evidence lines", async () => {
    await runMaintenance({
      model: {} as never,
      context,
      messages: [record("m1", persisted)] as never,
      store: {} as never,
      evidence: {} as never,
      request: "x",
      allowShared: false,
    });
    expect(harness.prompt).not.toContain("[object Object]");
    expect(harness.prompt).toContain("我长期偏好简洁中文回答");
    expect(harness.prompt).toContain(assetId);
  });

  it("still detects credentials inside structured text nodes", async () => {
    await runMaintenance({
      model: {} as never,
      context,
      messages: [record("m2", [{ type: "text", attrs: { content: "password=private-secret" }, children: [] }])] as never,
      store: {} as never,
      evidence: {} as never,
      request: "x",
      allowShared: false,
    });
    expect(harness.prompt).not.toContain("private-secret");
  });
});

describe("maintenance request merging", () => {
  it("does not repeat the same candidate description across queued triggers", () => {
    const description = "自动筛选本轮候选：只保留稳定事实。";
    expect(mergeRequests([description, description, ` ${description}\n`])).toBe(description);
  });

  it("keeps genuinely different requests in order", () => {
    expect(mergeRequests(["a", "b", "a", "", "c"])).toBe("a\nb\nc");
  });
});
