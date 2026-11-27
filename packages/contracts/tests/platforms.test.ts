import { describe, expect, it } from "vitest";

import {
  directChannelId,
  displayChannelId,
  isOwnerChat,
  isRetiredPlatform,
  oneBotArgs,
  platformLabel,
  platformOfAdapter,
  PLATFORMS,
  pluginAppliesTo,
  replyChannelId,
  supportsHeartbeat,
} from "../src/platforms.js";

describe("platform registry", () => {
  it("lists each platform once with its adapter", () => {
    expect(new Set(PLATFORMS.map((item) => item.id)).size).toBe(PLATFORMS.length);
    expect(platformOfAdapter("adapter-onebot")?.id).toBe("onebot");
    expect(platformOfAdapter("adapter-wechat-bridge")?.label).toBe("微信");
    expect(platformOfAdapter("yesimbot-memorizer")).toBeUndefined();
  });

  it("lists the chat platforms and no longer treats Xiaoheihe as one", () => {
    expect(PLATFORMS.map((item) => item.id)).toEqual(["onebot", "wechat-bridge", "web"]);
    expect(platformLabel("web")).toBe("网页");
    expect(isRetiredPlatform("xiaoheihe")).toBe(true);
    expect(isRetiredPlatform("onebot")).toBe(false);
    expect(isRetiredPlatform("constructor")).toBe(false);
    expect(platformLabel("xiaoheihe")).toBe("小黑盒（旧记录）");
    expect(platformLabel("discord")).toBe("discord");
  });

  it("scopes platform-only plugins to their platform", () => {
    expect(pluginAppliesTo("yesimbot-onebot-utils", "onebot")).toBe(true);
    expect(pluginAppliesTo("yesimbot-onebot-utils", "wechat-bridge")).toBe(false);
    expect(pluginAppliesTo("yesimbot-search-service", "wechat-bridge")).toBe(true);
  });

  it("formats direct channel IDs per platform", () => {
    expect(directChannelId("onebot", "10001")).toBe("private:10001");
    expect(directChannelId("wechat-bridge", "wxid_a")).toBe("wxid_a");
    expect(displayChannelId("onebot", "private:10001")).toBe("10001");
    expect(displayChannelId("wechat-bridge", "private:x")).toBe("private:x");
  });

  // What modules ask of a platform is declared here (spec 09 rule 5), never decided by comparing its ID.
  it("takes the group prefix the model may write off a reply's channel, on the platform that has one", () => {
    expect(replyChannelId("onebot", "group:300")).toBe("300");
    expect(replyChannelId("onebot", "300")).toBe("300");
    expect(replyChannelId("wechat-bridge", "group:300")).toBe("group:300");
    expect(replyChannelId(undefined, "group:300")).toBe("group:300");
  });

  it("knows the owner's own chat and where schedules may run heartbeats", () => {
    expect(isOwnerChat("web", "direct")).toBe(true);
    expect(isOwnerChat("web", "guild")).toBe(false);
    expect(isOwnerChat("onebot", "direct")).toBe(false);
    expect(
      ["onebot:guild", "onebot:direct", "web:direct", "web:guild", "wechat-bridge:direct", "discord:direct"].filter((chat) =>
        supportsHeartbeat(...(chat.split(":") as [string, string])),
      ),
    ).toEqual(["onebot:guild", "onebot:direct", "web:direct"]);
  });

  it("converts OneBot IDs as adapter-onebot did: numbers below 2³², never for guild actions", () => {
    expect(oneBotArgs("set_group_ban", { group_id: "300", user_id: 200, duration: 60 })).toEqual({ group_id: 300, user_id: 200, duration: 60 });
    expect(oneBotArgs("get_forward_msg", { message_id: "7437000000000000001" })).toEqual({ message_id: "7437000000000000001" });
    expect(oneBotArgs("get_guild_msg", { message_id: "12" })).toEqual({ message_id: "12" });
    expect(oneBotArgs("get_image", { file: "12" })).toEqual({ file: "12" });
  });
});
