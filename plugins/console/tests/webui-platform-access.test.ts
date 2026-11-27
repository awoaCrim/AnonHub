import { readFileSync } from "node:fs";

import { builtinToolDeclarations } from "@yesimbot/contracts";
import { expect, it } from "vitest";

import { ABILITIES } from "../web/src/lib/abilities";
import { featureLink } from "../web/src/lib/features";

it("assigns every capability one settings home without platform permission drawers", () => {
  expect(featureLink("yesimbot-message-debounce")).toEqual({ path: "/settings/reply", query: { section: "yesimbot-message-debounce" } });
  // 电脑 and 服务连接 became cards in 能力 (user, 2026-11-21): each capability opens its own card.
  for (const name of [
    "yesimbot-onebot-utils",
    "yesimbot-sticker-manager",
    "yesimbot-search-service",
    "yesimbot-mcp-client",
    "yesimbot-google",
    "yesimbot-workspace",
    "yesimbot-image-tools",
  ])
    expect(featureLink(name)).toEqual({ path: "/settings/extensions", query: { section: name } });
  expect(featureLink("yesimbot-device-connection")).toEqual({ path: "/settings/extensions", query: { section: "yesimbot-workspace" } });
  expect(featureLink("yesimbot-roleplay")).toEqual({ path: "/", query: { panel: "files", document: "role" } });
});

it("keeps account settings focused on connections and shared reply preferences", () => {
  const platforms = readFileSync(new URL("../web/src/pages/Platforms.vue", import.meta.url), "utf8");
  const extensions = readFileSync(new URL("../web/src/pages/Features.vue", import.meta.url), "utf8");
  expect(platforms).not.toContain("CapabilityDrawer");
  expect(extensions).not.toContain("CapabilityDrawer");
  expect(extensions).not.toContain("ReplyTriggersDrawer");
  expect(extensions).not.toContain('name="yesimbot-google"');
  expect(extensions).not.toContain('name="yesimbot-workspace"');
});

it("keeps each settings page to its own kind of setting", () => {
  const read = (file: string) => readFileSync(new URL(`../web/src/pages/${file}`, import.meta.url), "utf8");
  const reply = read("ReplyPreferences.vue"),
    abilities = read("Features.vue"),
    models = read("BotModels.vue"),
    system = read("SystemSettings.vue");
  // 对话: when and how it replies and how long chats are kept; 模型: models with their inputs; 系统 only looks.
  expect(reply).toContain('<BotBehavior part="speaking" />');
  expect(reply).toContain('<BotBehavior part="memory" />');
  expect(reply).not.toContain("FeatureSettings");
  expect(models).toContain('<BotBehavior part="input" />');
  expect(system).not.toContain("BotBehavior");
  expect(system).toContain("<PromptOverview />");
  expect(abilities).not.toContain("FeatureSettings");
  expect(ABILITIES.map((ability) => ability.plugin)).toEqual([
    "yesimbot-memorizer",
    "yesimbot-search-service",
    "yesimbot-schedule",
    "yesimbot-image-tools",
    "yesimbot-sticker-manager",
    "yesimbot-onebot-utils",
    "yesimbot-xiaoheihe",
    "yesimbot-workspace",
    "yesimbot-google",
    "yesimbot-mcp-client",
  ]);
});

it("shows who may use a capability exactly as its tools declare it", () => {
  const declarations = builtinToolDeclarations();
  for (const ability of ABILITIES) {
    const tools = declarations.filter((item) => item.pluginId === ability.plugin);
    // MCP tools are declared when a server connects, always sensitive (plugins/mcp-client).
    if (ability.plugin === "yesimbot-mcp-client") {
      expect(tools).toEqual([]);
      expect(ability.level).toBe("admin");
      continue;
    }
    expect(tools.length, ability.plugin).toBeGreaterThan(0);
    // Open when anything in it is open to everyone (e.g. reading 小黑盒); admin when every tool is sensitive.
    const open = tools.some((item) => !item.capability.sensitive && item.name !== "render_html");
    expect(ability.level, ability.plugin).toBe(open ? "all" : "admin");
  }
});
