import { OPTIONAL_MEMBER_PLUGINS } from "../../../src/shared/plugin-catalog";
import type { PluginConfigEntry } from "../../../src/shared/plugin-config";
import { ApiError } from "./api";

/** Names for plugins the member catalog does not describe: the runtime's own and the always-on ones. */
const BUILT_IN_NAMES: Record<string, string> = {
  yesimbot: "核心",
  "yesimbot-console": "控制台",
  "yesimbot-model-provider": "模型接入",
  "yesimbot-device-connection": "电脑连接",
  "adapter-onebot": "QQ 接入",
  "adapter-wechat-bridge": "微信接入",
  "yesimbot-xiaoheihe": "小黑盒",
  server: "网页服务",
  http: "网络请求",
  "proxy-agent": "网络代理",
  "database-sqlite": "数据库",
  console: "Koishi 控制台",
  config: "配置管理",
  logger: "日志",
  status: "运行状态",
  "assets-local": "本地资源",
};

/**
 * What to call a plugin: its own label when it has one, else the catalog's or a built-in name.
 * A bare label equal to a package name (`yesimbot-device-connection`) is translated the same way.
 */
export function pluginName(entry: { name: string; label?: string }): string {
  if (entry.label && entry.label !== entry.name && !BUILT_IN_NAMES[entry.label]) return entry.label;
  const name = entry.label && BUILT_IN_NAMES[entry.label] ? entry.label : entry.name;
  return OPTIONAL_MEMBER_PLUGINS.find((item) => item.name === name)?.label ?? BUILT_IN_NAMES[name] ?? entry.label ?? name;
}

export function flattenPlugins(tree: PluginConfigEntry[]): PluginConfigEntry[] {
  return tree.flatMap((item) => [item, ...flattenPlugins(item.children ?? [])]);
}

export function pluginStatus(entry: PluginConfigEntry): string {
  return entry.needsConfig
    ? "需要配置"
    : {
        active: "运行中",
        failed: "出错",
        disabled: "已停用",
        loading: "加载中",
      }[entry.status];
}

/** Status dot colour for a plugin row: one mapping for the abilities list and the advanced editor. */
export function pluginTone(entry: Pick<PluginConfigEntry, "status" | "needsConfig" | "enabled">): "ok" | "warn" | "danger" | "idle" {
  if (entry.status === "failed") return "danger";
  if (entry.needsConfig || (entry.enabled && entry.status === "loading")) return "warn";
  return entry.enabled && entry.status === "active" ? "ok" : "idle";
}

/** Enabling or disabling renames a key to or from `~name`; it is still the same instance. */
export const pluginIdentity = (path: string) => path.replace(/(^|\/)~(?=[^/]*$)/, "$1");

export function pluginError(error: unknown): string {
  if (!(error instanceof ApiError)) return "无法连接服务，请稍后重试。";
  return (
    {
      write_unknown: "保存超时，服务器结果尚未确认。草稿仍保留；请检查服务器状态后再保存。",
      read_timeout: "读取超时，请重试。",
      config_changed: "这项设置刚被其他页面改过。你的修改还在；点「放弃」读取最新设置后再改。",
      not_found: "这项功能已不存在，请刷新页面。",
      locked: "此配置由服务器管理，无法在这里修改。",
      not_permitted: "当前账号没有这项功能的管理权限。",
      invalid_config: "配置校验未通过，请检查标记的字段。",
      apply_failed: "配置未能生效，服务端已尝试恢复原配置。",
    }[error.code] ?? "操作失败，请稍后重试。"
  );
}
