import type { PlatformDefinition } from "@yesimbot/contracts/platforms";

import type { PanelAdapter, PanelPayload } from "../../../src/shared/panel";
import type { PluginConfigEntry } from "../../../src/shared/plugin-config";
import type { WebUIFeatures } from "../../../src/shared/webui";
import { connectablePlatforms, platformOfPackage } from "../lib/web-platform";
import type { Tone } from "./overview-model";

export const ADAPTER_STATE: Record<PanelAdapter["state"], string> = {
  online: "在线",
  configured: "已配置，未连接",
  unconfigured: "未配置",
  disabled: "已关闭",
  error: "连接出错",
  offline: "已离线",
};

export interface PlatformState extends PlatformDefinition {
  /** The best state among the platform's accounts; absent when it has none. */
  state?: PanelAdapter["state"];
}

const RANK: PanelAdapter["state"][] = ["online", "error", "offline", "configured", "unconfigured", "disabled"];

/** One state for a platform with several accounts: any online account wins, then any error. */
export function platformState(adapters: readonly PanelAdapter[], platform: string): PanelAdapter["state"] | undefined {
  const states = adapters.filter((adapter) => adapter.platform === platform).map((adapter) => adapter.state);
  return RANK.find((state) => states.includes(state));
}

export function platformTone(state: PanelAdapter["state"] | undefined): Tone {
  // An account kicked offline cannot reply: as serious as a broken connection.
  return state === "online" ? "ok" : state === "error" || state === "offline" ? "danger" : state ? "warn" : "";
}

/**
 * The platforms this runtime has, in registry order: any with an adapter instance, and QQ where
 * the server offers QR login. `installable` (the 平台 page) adds the ones this account could still
 * connect, so each platform is always there to set up and nothing has to be "added" first.
 */
export function presentPlatforms(
  panel: PanelPayload | undefined,
  instances: readonly { name: string }[],
  features: Pick<WebUIFeatures, "napcat"> & Partial<Pick<WebUIFeatures, "wechat">>,
  installable: readonly { name: string }[] = [],
): PlatformState[] {
  const adapters = panel?.adapters ?? [];
  // The web chat is built in: it is not a platform people connect, so it gets no tab, status or summary.
  return connectablePlatforms()
    .filter(
      (platform) =>
        adapters.some((adapter) => adapter.platform === platform.id) ||
        instances.some((item) => item.name === platform.adapter) ||
        (platform.login === "napcat" && features.napcat) ||
        (platform.login === "wechat" && features.wechat === true) ||
        installable.some((item) => item.name === platform.adapter),
    )
    .map((platform) => ({ ...platform, state: platformState(adapters, platform.id) }));
}

/** Switched off by its owner, so not a problem: the adapter is turned off. */
export function platformOff(platform: Pick<PlatformState, "state" | "login">): boolean {
  return platform.state === "disabled";
}

/** Short status for the sidebar and the overview: "QQ 在线 · 微信已关闭". Platforms switched off are named but never count as a problem. */
export function platformSummary(platforms: readonly PlatformState[]): { tone: Tone; label: string } | undefined {
  const known = platforms.filter((platform) => platform.state);
  const chats = known.filter((platform) => !platformOff(platform));
  if (!chats.length) return undefined;
  const label = known
    .map(
      (platform) =>
        `${platform.label} ${platformOff(platform) ? "已关闭" : platform.state === "online" ? "在线" : platform.state === "offline" ? "离线" : platform.state === "error" ? "出错" : "未连接"}`,
    )
    .join(" · ");
  const tone: Tone = chats.every((platform) => platform.state === "online")
    ? "ok"
    : chats.some((platform) => platform.state === "error" || platform.state === "offline")
      ? "danger"
      : "warn";
  return { tone, label };
}

/** An adapter package for a platform the registry does not know (`adapter-telegram`); each instance gets a tab of its own. */
export function isCustomAdapter(name: string): boolean {
  return /^(?:@[^/]+\/)?adapter-/.test(name) && !platformOfPackage(name);
}

/** The platform ID an adapter package reports, as the panel derives it (`adapter-telegram` → `telegram`). */
export function adapterPlatformId(name: string): string {
  return name.replace(/^(?:@[^/]+\/)?adapter-/, "");
}

/** A readable name for an adapter package: the registry label, else its platform ID capitalised (`Telegram`). */
export function adapterLabel(name: string): string {
  const id = adapterPlatformId(name);
  return platformOfPackage(name)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export interface CustomPlatformTab {
  /** Route value: `plugin:<path>` with the enable marker dropped, so a tab survives turning the plugin on or off. */
  id: string;
  label: string;
  /** Platform ID used for 回复范围 and 聊天记录. */
  platform: string;
  entry: PluginConfigEntry;
  state?: PanelAdapter["state"];
}

/** Route value of a custom adapter tab for an instance path; the `~` (disabled) marker is dropped, it is the same instance. */
export const customTabId = (path: string) => `plugin:${path.replace(/(^|\/)~(?=[^/]*$)/, "$1")}`;

/** One tab per custom adapter instance, numbered when a package has several. */
export function customPlatformTabs(instances: readonly PluginConfigEntry[], adapters: readonly PanelAdapter[]): CustomPlatformTab[] {
  const custom = instances.filter((item) => !item.group && isCustomAdapter(item.name));
  return custom.map((entry) => {
    const same = custom.filter((item) => item.name === entry.name);
    const own = entry.label && entry.label !== entry.name ? entry.label : "";
    const label = own || (same.length > 1 ? `${adapterLabel(entry.name)} ${same.indexOf(entry) + 1}` : adapterLabel(entry.name));
    const key = entry.key.replace(/^~/, "");
    return {
      id: customTabId(entry.path),
      label,
      platform: adapterPlatformId(entry.name),
      entry,
      state: adapters.find((adapter) => adapter.key === key)?.state,
    };
  });
}
