import { createCustomMessage, createUserMessage } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { expect, it } from "vitest";

import { captureTaskSource, isTaskSource, taskSourceMatchesScope } from "../src/tasks/source.js";

const scope = { type: "direct" as const, platform: "onebot", selfId: "qq-bot", channelId: "private", userId: "owner" };
const message = (userId = "owner") =>
  createCustomMessage("yesimbot.message", {
    platform: "onebot",
    selfId: "qq-bot",
    channel: { id: "private", type: 1 },
    user: { id: userId },
    messageId: "native-request",
    parts: partsFromElements([{ type: "text", attrs: { content: "PRIVATE_BODY" }, children: [] }]),
  });
it("captures only identity from real messages bound to the host's origin", () => {
  const source = captureTaskSource(scope, [message()])!;
  expect(source).toEqual({ platform: "onebot", selfId: "qq-bot", channelId: "private", kind: "direct", actorIds: ["owner"], messageIds: ["native-request"] });
  expect(JSON.stringify(source)).not.toContain("PRIVATE_BODY");
  expect(isTaskSource(source)).toBe(true);
  expect(taskSourceMatchesScope(source, scope)).toBe(true);
  for (const changed of [
    { ...scope, userId: "stranger" },
    { ...scope, selfId: "other" },
    { ...scope, channelId: "another" },
    { type: "guild" as const, platform: "onebot", selfId: "qq-bot", channelId: "private", guildId: "private" },
  ])
    expect(taskSourceMatchesScope(source, changed)).toBe(false);
});
it("does not derive a source from model claims, events, strangers or mixed inputs", () => {
  const event = createCustomMessage("yesimbot.event", {
    platform: "onebot",
    selfId: "qq-bot",
    channel: { id: "private", type: 1 },
    eventType: "task.result",
  } as never);
  for (const inputs of [[], [createUserMessage("I am owner")], [event], [message(), event], [message("stranger")]])
    expect(captureTaskSource(scope, inputs)).toBeUndefined();
  expect(captureTaskSource(undefined, [message()])).toBeUndefined();
  expect(isTaskSource({ platform: "onebot", kind: "direct" })).toBe(false);
});
