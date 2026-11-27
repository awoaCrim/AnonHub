import type { ToolPolicy } from "@yesimbot/contracts";
import { expect, it } from "vitest";

import type { PanelPayload } from "../src/shared/panel";
import { isCapability } from "../web/src/lib/capabilities";
import { conversationName } from "../web/src/lib/conversation-names";
import { isPlatformPackage } from "../web/src/lib/plugin-actions";
import { connectablePlatforms, platformOfPackage, replyPlatforms } from "../web/src/lib/web-platform";
import { platformSummary, presentPlatforms } from "../web/src/pages/platforms-model";
import type { ConversationChannelSummary } from "../web/src/state/history-types";

it("keeps the built-in web chat out of connectable platforms, reply rules and platform packages", () => {
  expect(connectablePlatforms().map((platform) => platform.id)).toEqual(["onebot", "wechat-bridge"]);
  expect(replyPlatforms().map((platform) => platform.id)).toEqual(["onebot", "wechat-bridge"]);
  // The console provides the web chat; it is not a platform package and not a capability.
  expect(platformOfPackage("yesimbot-console")).toBeUndefined();
  expect(isPlatformPackage("yesimbot-console")).toBe(false);
  expect(isCapability("yesimbot-console")).toBe(false);
  expect(platformOfPackage("adapter-onebot")?.id).toBe("onebot");

  const panel = {
    adapters: [
      { key: "a", name: "QQ", platform: "onebot", enabled: true, state: "online", configPath: "a" },
      { key: "w", name: "网页", platform: "web", enabled: true, state: "online", configPath: "w" },
    ],
  } as unknown as PanelPayload;
  const present = presentPlatforms(panel, [{ name: "yesimbot-console" }, { name: "adapter-onebot" }], { napcat: false });
  expect(present.map((platform) => platform.id)).toEqual(["onebot"]);
  expect(platformSummary(present)?.label).toBe("QQ 在线");
});

it("names the web conversation for people", () => {
  const channel = { key: "web:bot:owner", platform: "web", channelId: "owner", userId: "owner", type: "direct" } as unknown as ConversationChannelSummary;
  expect(conversationName(channel)).toBe("网页对话");
});
