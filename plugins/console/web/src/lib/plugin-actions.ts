import { PLATFORMS } from "@yesimbot/contracts/platforms";

import { api } from "./api";
import { platformOfPackage } from "./web-platform";

/** Result of a plugin tree mutation: the new configuration revision and, for `add`, the new instance path. */
export interface PluginMutation {
  revision: string;
  path?: string;
}

/**
 * Adds a new instance of an installed package. The server creates it disabled (`~name:xxxxxx`) so
 * the user can fill in its settings before turning it on. `parent` is a group path; "" is the root.
 */
export const addPluginInstance = (revision: string, name: string, parent = "") =>
  api<PluginMutation>("/yesimbot/api/v1/plugins/add", { revision, parent, name });

/** Removes one instance and its configuration. Protected instances answer `locked`. */
export const removePluginInstance = (revision: string, path: string) => api<PluginMutation>("/yesimbot/api/v1/plugins/remove", { revision, path });

/**
 * A package that connects a chat platform: a known platform's adapter or platform-only plugin, or
 * any Koishi adapter package (`adapter-*`, `@scope/adapter-*`). These are added from the 平台 page;
 * everything else is built in.
 */
export function isPlatformPackage(name: string): boolean {
  return !!platformOfPackage(name) || PLATFORMS.some((platform) => platform.plugins.includes(name)) || /^(?:@[^/]+\/)?adapter-/.test(name);
}
