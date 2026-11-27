import { readFileSync } from "node:fs";

import { REQUIRED_MEMBER_PLUGINS, normalizeMemberPlugins } from "./shared/plugin-catalog.js";

/** Read-only bind mount written by the host runtime manager; members cannot change it. */
export const POLICY_FILE = "/run/yesimbot/policy/plugins.json";

export const LOCKED = "yesimbot-console";

/** Missing or malformed policy fails closed to the required plugins only. */
export function readPluginPolicy(file: string, warn: (message: string) => void = () => {}): Set<string> {
  let granted: string[] = [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data?.version !== 1) throw new Error("invalid_plugin_policy");
    granted = normalizeMemberPlugins(data.plugins);
  } catch {
    warn("plugin policy unavailable; only required plugins may load");
  }
  return new Set([...REQUIRED_MEMBER_PLUGINS, ...granted]);
}
