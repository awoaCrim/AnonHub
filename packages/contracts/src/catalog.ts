import catalog from "./plugin-catalog.json";
export interface PluginCatalogItem {
  name: string;
  label: string;
  description: string;
}

export const REQUIRED_MEMBER_PLUGINS: readonly string[] = Object.freeze(catalog.required);

export const OPTIONAL_MEMBER_PLUGINS: readonly PluginCatalogItem[] = Object.freeze(catalog.optional.map((item) => Object.freeze(item)));

export const OPTIONAL_MEMBER_PLUGIN_NAMES: readonly string[] = Object.freeze(OPTIONAL_MEMBER_PLUGINS.map((item) => item.name));
