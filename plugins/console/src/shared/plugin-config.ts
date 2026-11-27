export type PluginConfigErrorCode = "config_changed" | "not_found" | "locked" | "not_permitted" | "invalid_config" | "apply_failed";

/** A form node: what the console renders a config field from. */
export interface PluginSchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, PluginSchemaNode>;
  list?: PluginSchemaNode[];
  inner?: PluginSchemaNode;
  name?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface PluginSchemaSnapshot {
  schema: PluginSchemaNode | null;
  usage: string;
  dynamics: Record<string, PluginSchemaNode>;
}

export interface PluginConfigEntry {
  path: string;
  key: string;
  name: string;
  label: string;
  enabled: boolean;
  group: boolean;
  status: "active" | "failed" | "disabled" | "loading";
  needsConfig: boolean;
  locked: boolean;
  children?: PluginConfigEntry[];
}

export interface PluginsSnapshot {
  revision: string;
  writable: boolean;
  tree: PluginConfigEntry[];
  available: { name: string; label: string }[];
}

export interface PluginConfigSnapshot {
  revision: string;
  config: Record<string, unknown>;
}

export interface SecretMarker {
  $secret: true;
  sourcePath?: string[];
}
