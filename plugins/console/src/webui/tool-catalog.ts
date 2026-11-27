import { authorizeToolCapability, builtinToolDeclarations, OPTIONAL_MEMBER_PLUGINS } from "@yesimbot/contracts";
import { PLATFORMS } from "@yesimbot/contracts/platforms";

import type { AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { ToolCatalog } from "../shared/tool-catalog.js";
import { authorizeOwner } from "./plugins.js";

const LABELS: Record<string, string> = {
  core: "核心",
  "yesimbot-console": "控制台",
  "yesimbot-web-chat": "网页对话",
  "yesimbot-instance-management": "实例管理",
  provider: "模型自带",
  "yesimbot-workspace": "工作区与电脑",
  "yesimbot-onebot-utils": "QQ 专属动作",
};

/**
 * The same central declarations that decide tools at runtime (user, 2026-11-18: 「想知道各个平台都有哪些工具很费劲」).
 * Extension and MCP tools declare their own capability and are not in this table.
 */
export function toolCatalog(): ToolCatalog {
  // The web chat first: it is the baseline every other platform is adapted from.
  const columns = [...PLATFORMS]
    .sort((left, right) => Number(right.id === "web") - Number(left.id === "web"))
    .flatMap((platform) =>
      (platform.id === "web" ? (["direct"] as const) : (["direct", "group"] as const)).map((kind) => ({
        platform: platform.id,
        kind,
        label: platform.id === "web" ? platform.label : `${platform.label}${kind === "direct" ? "私聊" : "群聊"}`,
      })),
    );
  const rows = new Map<string, { plugin: string; name: string; sensitive: boolean; allowed: boolean[] }>();
  columns.forEach((column, index) => {
    for (const item of builtinToolDeclarations(column.platform)) {
      // A name declared by Core and by a plugin is shown once, under the plugin.
      const row = rows.get(item.name) ?? { plugin: item.pluginId, name: item.name, sensitive: item.capability.sensitive, allowed: columns.map(() => false) };
      if (row.plugin === "core" && item.pluginId !== "core") row.plugin = item.pluginId;
      row.allowed[index] ||= authorizeToolCapability({ conversation: { platform: column.platform, kind: column.kind } }, item.capability).allowed;
      rows.set(item.name, row);
    }
  });
  const label = (plugin: string) => LABELS[plugin] ?? OPTIONAL_MEMBER_PLUGINS.find((item) => item.name === plugin)?.label ?? plugin;
  const groups = new Map<string, ToolCatalog["groups"][number]>();
  for (const { plugin, ...tool } of rows.values()) {
    const group = groups.get(plugin) ?? { plugin, label: label(plugin), tools: [] };
    group.tools.push(tool);
    groups.set(plugin, group);
  }
  // Core's reply and context tools are everywhere; the groups that differ come first.
  return { columns, groups: [...groups.values()].sort((left, right) => Number(left.plugin === "core") - Number(right.plugin === "core")) };
}

export function installToolCatalog(ctx: Host, auth: AdminAuth) {
  ctx.server.get("/yesimbot/api/v1/tools/catalog", (http) => {
    if (!authorizeOwner(http, auth)) return;
    http.body = toolCatalog();
  });
}
