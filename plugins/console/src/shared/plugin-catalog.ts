import { OPTIONAL_MEMBER_PLUGIN_NAMES } from "@yesimbot/contracts/catalog";

/** Loader keys look like `~name:ident`; packages may be spelled with their full npm name. */
export function pluginBaseName(key: string): string {
  return key
    .replace(/^~/, "")
    .split(":", 1)[0]
    .replace(/^@koishijs\/plugin-/, "")
    .replace(/^koishi-plugin-/, "");
}

/** Validates an owner-supplied grant. Returns a de-duplicated list in catalog order. */
export function normalizeMemberPlugins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > OPTIONAL_MEMBER_PLUGIN_NAMES.length * 2) throw new Error("invalid_plugins");
  const granted = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !OPTIONAL_MEMBER_PLUGIN_NAMES.includes(name)) throw new Error("invalid_plugins");
    granted.add(name);
  }
  return OPTIONAL_MEMBER_PLUGIN_NAMES.filter((name) => granted.has(name));
}

export { REQUIRED_MEMBER_PLUGINS, OPTIONAL_MEMBER_PLUGINS, OPTIONAL_MEMBER_PLUGIN_NAMES, type PluginCatalogItem } from "@yesimbot/contracts/catalog";
