import type { AgentEntry } from "@yesimbot/agent-runtime";
import { createMessageEntry } from "@yesimbot/agent-runtime";
import { CHANNEL_TYPE, partsFromElements, type Message, type Part } from "koishi-plugin-yesimbot";
import { describe, expect, it } from "vitest";

import { projectAnimatedImages } from "../src/animated-image.js";

const ID = "00000000000000000000000000000000";

function messageEntry(parts: readonly Part[]): AgentEntry {
  const message: Message = {
    id: "m-1",
    timestamp: 1,
    role: "custom",
    type: "yesimbot.message",
    data: {
      platform: "onebot",
      selfId: "bot-1",
      channel: { id: "group", type: CHANNEL_TYPE.text },
      user: { id: "user-1", name: "User" },
      messageId: "m-1",
      parts,
    },
  };
  return createMessageEntry(message);
}

function projectedParts(entry: AgentEntry): readonly Part[] {
  const [projected] = projectAnimatedImages([entry]);
  return (projected!.data as { data: { parts: readonly Part[] } }).data.parts;
}

describe("animated image projection", () => {
  it("replaces persisted subtype-one images with an animated emoji text part", () => {
    expect(projectedParts(messageEntry([{ type: "image", asset: ID, subtype: 1, summary: "大笑" }]))).toEqual([
      { type: "text", text: `[动画表情: 大笑 asset://${ID}]` },
    ]);
  });

  it("treats images with non-empty summary as animated without subtype metadata", () => {
    expect(projectedParts(messageEntry([{ type: "image", asset: ID, summary: "大笑" }]))).toEqual([{ type: "text", text: `[动画表情: 大笑 asset://${ID}]` }]);
  });

  it("keeps ordinary images unchanged for Core projection", () => {
    const entry = messageEntry([{ type: "image", asset: ID }]);
    expect(projectAnimatedImages([entry])[0]).toBe(entry);
  });

  it("supports snake_case subtype metadata from stored elements", () => {
    const parts = partsFromElements([{ type: "img", attrs: { id: ID, sub_type: "1" }, children: [] }]);
    expect(projectedParts(messageEntry(parts))).toEqual([{ type: "text", text: `[动画表情: asset://${ID}]` }]);
  });

  it("projects an animated image inside a quote", () => {
    const parts: Part[] = [{ type: "quote", messageId: "q", parts: [{ type: "image", asset: ID, subtype: "1" }] }];
    expect(projectedParts(messageEntry(parts))).toEqual([{ type: "quote", messageId: "q", parts: [{ type: "text", text: `[动画表情: asset://${ID}]` }] }]);
  });
});
