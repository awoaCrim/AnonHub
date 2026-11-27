import type { AgentMessage } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { describe, expect, it } from "vitest";

import type { ChannelContext } from "../src/channels/index.js";
import { adminSource, adminTurn } from "../src/tools/admins.js";

const admins = [
  { platform: "onebot", userId: "admin" },
  { platform: "onebot", userId: "admin-2" },
];
const group: ChannelContext = { type: "guild", platform: "onebot", guildId: "room", channelId: "room", selfId: "bot" };
const privateWith = (userId: string): ChannelContext => ({ type: "direct", platform: "onebot", channelId: userId, userId, selfId: "bot" });
const chat = (userId: string | undefined, extra: object = {}): AgentMessage =>
  ({
    id: `m-${userId}`,
    role: "custom",
    type: "yesimbot.message",
    data: { ...(userId === undefined ? {} : { user: { id: userId } }), parts: partsFromElements([]), ...extra },
  }) as never;
const event = { id: "e", role: "custom", type: "yesimbot.event", data: {} } as never as AgentMessage;

describe("adminTurn", () => {
  it("always treats the web chat as admin, even with no admins registered", () => {
    expect(adminTurn({ type: "direct", platform: "web", channelId: "u", userId: "u" }, undefined, [chat("anyone")])).toBe(true);
    expect(adminTurn({ type: "direct", platform: "web", channelId: "u", userId: "u" }, [], [])).toBe(true);
  });

  it("is true only when every speaker of the turn is a registered admin", () => {
    expect(adminTurn(group, admins, [chat("admin")])).toBe(true);
    expect(adminTurn(group, admins, [chat("admin"), chat("admin-2")])).toBe(true);
    expect(adminTurn(group, admins, [chat("admin"), chat("stranger")])).toBe(false);
    expect(adminTurn(group, admins, [chat("stranger")])).toBe(false);
    expect(adminTurn(group, undefined, [chat("admin")])).toBe(false);
    expect(adminTurn(group, [], [chat("admin")])).toBe(false);
  });

  it("fails closed on a message without a sender, even beside an admin", () => {
    expect(adminTurn(group, admins, [chat(undefined)])).toBe(false);
    expect(adminTurn(group, admins, [chat("admin"), chat(undefined)])).toBe(false);
    expect(adminTurn(privateWith("admin"), admins, [chat("")])).toBe(false);
  });

  it("counts the account holder's private word as admin, but never lets it hide a stranger", () => {
    expect(adminTurn(group, admins, [chat("owner", { whisper: true })])).toBe(true);
    expect(adminTurn(group, admins, [chat(undefined, { whisper: true })])).toBe(true);
    expect(adminTurn(group, admins, [chat("owner", { whisper: true }), chat("stranger")])).toBe(false);
    expect(adminTurn(group, admins, [chat("owner", { whisper: true }), chat("admin")])).toBe(true);
  });

  it("decides an actor-less event by the conversation: an admin's private chat yes, a group no", () => {
    expect(adminTurn(privateWith("admin"), admins, [event])).toBe(true);
    expect(adminTurn(privateWith("admin"), admins, [])).toBe(true);
    expect(adminTurn(privateWith("stranger"), admins, [event])).toBe(false);
    expect(adminTurn(group, admins, [event])).toBe(false);
    expect(adminTurn(group, admins, [])).toBe(false);
  });

  it("only counts admins registered for the same platform", () => {
    const elsewhere = [{ platform: "wechat-bridge", userId: "admin" }];
    expect(adminTurn(group, elsewhere, [chat("admin")])).toBe(false);
    expect(adminTurn(privateWith("admin"), elsewhere, [event])).toBe(false);
    expect(adminTurn({ ...group, platform: "wechat-bridge" }, elsewhere, [chat("admin")])).toBe(true);
  });
});

describe("adminSource", () => {
  it("is admin on the web chat", () => {
    expect(adminSource({ type: "direct", platform: "web", channelId: "u", userId: "u" }, undefined, undefined)).toBe(true);
  });

  it("requires every actor of the task's source to be an admin", () => {
    expect(adminSource(group, admins, { actorIds: ["admin"] })).toBe(true);
    expect(adminSource(group, admins, { actorIds: ["admin", "admin-2"] })).toBe(true);
    expect(adminSource(group, admins, { actorIds: ["admin", "stranger"] })).toBe(false);
    expect(adminSource(group, [{ platform: "other", userId: "admin" }], { actorIds: ["admin"] })).toBe(false);
  });

  it("falls back to the conversation when the task has no source actors", () => {
    expect(adminSource(group, admins, undefined)).toBe(false);
    expect(adminSource(group, admins, { actorIds: [] })).toBe(false);
    expect(adminSource(privateWith("admin"), admins, undefined)).toBe(true);
    expect(adminSource(privateWith("stranger"), admins, undefined)).toBe(false);
  });
});
