import { partsFromElements } from "@yesimbot/contracts/parts";
import { parseConfig } from "@yesimbot/foundation";
import { expect, it, vi } from "vitest";

import { Agents } from "../src/agents";
import { fixedReplyEngine } from "../src/agents/will";
import { moduleConfig } from "../src/config.js";
import { h } from "./helpers/index.js";
const state = { activeTurnId: null };
const message = (elements: ReturnType<typeof h>[] = [], platform = "onebot", direct = false) =>
  ({
    role: "custom",
    type: "yesimbot.message",
    data: { platform, selfId: "bot", channel: { id: "room", type: direct ? 1 : 0 }, user: { id: "user" }, messageId: "m", parts: partsFromElements(elements) },
    timestamp: 0,
  }) as never;
it("defaults to no applied platforms and preserves the default private/mention trigger", async () => {
  const config = parseConfig(moduleConfig, {});
  expect(config.replyTriggers?.platforms).toEqual([]);
  const engine = fixedReplyEngine(config.replyTriggers!);
  expect(await engine.decide(message([], "onebot", true), state)).toBe("trigger");
  expect(await engine.decide(message([h("at", { id: "bot" })]), state)).toBe("trigger");
  expect(await engine.decide(message([h.text("hello")]), state)).toBe("wait");
});
it("ordinary-group fallback does not override a disabled specific rule; multiple matching rules use OR", async () => {
  const engine = fixedReplyEngine({ platforms: ["onebot"], rules: { mention: false, image: true, group: true, direct: false } });
  expect(await engine.decide(message([h("at", { id: "bot" })]), state)).toBe("wait");
  expect(await engine.decide(message([h("at", { id: "bot" }), h("img", { src: "x" })]), state)).toBe("trigger");
  expect(await engine.decide(message([h.text("ordinary")]), state)).toBe("trigger");
  expect(await engine.decide(message([], "onebot", true), state)).toBe("wait");
  expect(await engine.decide(message([], "web", true), state)).toBe("trigger");
});
it("does not inspect quoted content for mentions, and poke only targets this bot", async () => {
  const engine = fixedReplyEngine({ platforms: ["onebot"], rules: { quote: false, poke: true } });
  expect(await engine.decide(message([h("quote", {}, [h("at", { id: "bot" })])]), state)).toBe("wait");
  const poke = (targetId: string) => ({ type: "yesimbot.event", data: { platform: "onebot", selfId: "bot", eventType: "notice.poke", targetId } }) as never;
  expect(await engine.decide(poke("bot"), state)).toBe("trigger");
  expect(await engine.decide(poke("other"), state)).toBe("wait");
});
it("applies fixed rules only after the adapter admits a message", async () => {
  const agents = new Agents({ replyTriggers: { platforms: ["wechat-bridge"], rules: { direct: true } } });
  const gate = vi.fn(() => "wait" as "wait" | "trigger");
  agents.will({ priority: -1000, match: () => true, setup: () => ({ decide: gate }) });
  const engine = await agents.setupWill({ platform: "wechat-bridge" } as never);
  expect(await engine.decide(message([], "wechat-bridge", true), state)).toBe("wait");
  gate.mockReturnValue("trigger");
  expect(await engine.decide(message([], "wechat-bridge", true), state)).toBe("trigger");
});
it("recognizes all/online mentions without treating them as direct mentions", async () => {
  const engine = fixedReplyEngine({ platforms: ["onebot"], rules: { mention: false, all: true, online: true } });
  expect(await engine.decide(message([h("at", { type: "all" })]), state)).toBe("trigger");
  expect(await engine.decide(message([h("at", { type: "here" })]), state)).toBe("trigger");
});
