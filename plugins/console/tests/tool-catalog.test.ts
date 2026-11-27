import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { toolCatalog } from "../src/webui/tool-catalog.js";

// User, 2026-11-18: 「你看你现在想知道各个平台都有哪些工具很费劲吧？」
it("shows in one table which built-in tool each platform's private and group chats get", () => {
  const catalog = toolCatalog();
  const column = (label: string) => catalog.columns.findIndex((item) => item.label === label);
  const tool = (name: string) => catalog.groups.flatMap((group) => group.tools).find((item) => item.name === name)!;
  expect(catalog.columns.map((item) => item.label)).toEqual(expect.arrayContaining(["网页", "QQ私聊", "QQ群聊", "微信私聊", "微信群聊"]));
  expect(catalog.columns.filter((item) => item.platform === "web")).toHaveLength(1);
  // User, 2026-11-18: every conversation has every tool; only an admin can have it call a sensitive one (checked at call time).
  expect(tool("computer_browser").allowed[column("QQ私聊")]).toBe(true);
  expect(tool("computer_browser").allowed[column("QQ群聊")]).toBe(true);
  // Group moderation: QQ groups only (each group still has to be enabled).
  expect(tool("onebot_group_admin").allowed[column("QQ群聊")]).toBe(true);
  expect(tool("onebot_group_admin").allowed[column("QQ私聊")]).toBe(false);
  expect(tool("onebot_group_admin").allowed[column("微信群聊")]).toBe(false);
  // Core reply tools everywhere; a name both Core and a plugin declare appears once.
  expect(tool("send_message").allowed.every(Boolean)).toBe(true);
  expect(catalog.groups.flatMap((group) => group.tools).filter((item) => item.name === "list_conversations")).toHaveLength(1);
  expect(catalog.groups.find((group) => group.plugin === "yesimbot-onebot-utils")?.label).toBe("QQ 专属动作");
});

it("offers the table on the abilities page", () => {
  expect(readFileSync(new URL("../web/src/pages/Features.vue", import.meta.url), "utf8")).toContain("<ToolCatalog />");
});
