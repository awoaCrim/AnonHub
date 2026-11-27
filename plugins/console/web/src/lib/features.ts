import { PLATFORMS } from "@yesimbot/contracts/platforms";

import type { PluginConfigEntry } from "../../../src/shared/plugin-config";
import { pages, settingsPages } from "../nav";
import { api } from "./api";
import { isCapability } from "./capabilities";
import { platformOfPackage } from "./web-platform";

/** Feature configuration has one home; platform access is derived from tool declarations. */
export const SCHEDULE = "yesimbot-schedule";

type Link = { path: string; query?: Record<string, string> };

/** Each built-in feature has one editor; configuration never varies by platform. */
export const FEATURE_HOMES: Record<string, string> = {
  "reply-triggers": settingsPages.reply.path,
  "yesimbot-roleplay": pages.home.path,
  "yesimbot-memorizer": settingsPages.extensions.path,
  "yesimbot-message-debounce": settingsPages.reply.path,
  "yesimbot-sticker-manager": settingsPages.extensions.path,
  "yesimbot-onebot-utils": settingsPages.extensions.path,
  "yesimbot-workspace": settingsPages.extensions.path,
  "yesimbot-device-connection": settingsPages.extensions.path,
  "yesimbot-google": settingsPages.extensions.path,
  "yesimbot-search-service": settingsPages.extensions.path,
  "yesimbot-xiaoheihe": settingsPages.extensions.path,
  "yesimbot-mcp-client": settingsPages.extensions.path,
  "yesimbot-model-provider": settingsPages.models.path,
  "yesimbot-image-tools": settingsPages.extensions.path,
  "yesimbot-schedule": pages.home.path,
  "yesimbot-usage": settingsPages.system.path,
};

/** Resolve bookmarks and contextual links to the actual configuration editor. */
export function featureLink(name: string): Link | undefined {
  const home = FEATURE_HOMES[name];
  if (name === "yesimbot-roleplay") return { path: pages.home.path, query: { panel: "files", document: "role" } };
  if (name === SCHEDULE) return { path: pages.home.path, query: { panel: "tasks" } };
  if (home) {
    if (name === "yesimbot-usage") return { path: home, query: { tab: "usage" } };
    if (name === "yesimbot-model-provider") return { path: home };
    // The computer is the workspace capability's card.
    return { path: home, query: { section: name === "yesimbot-device-connection" ? "yesimbot-workspace" : name } };
  }
  const platform = platformOfPackage(name) ?? PLATFORMS.find((item) => item.plugins.includes(name));
  if (platform) return { path: settingsPages.platforms.path, query: { platform: platform.id } };
  if (isCapability(name)) return { path: settingsPages.extensions.path };
  return undefined;
}

/** Turns a built-in feature on or off. */
export const setFeatureEnabled = (revision: string | undefined, entry: Pick<PluginConfigEntry, "path">, enabled: boolean) =>
  api<{ revision: string; path?: string }>("/yesimbot/api/v1/plugins/enabled", { revision, path: entry.path, enabled });
