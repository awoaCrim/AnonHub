import type { Host } from "../host.js";
import { pluginBaseName } from "../shared/plugin-catalog.js";
import type { PluginConfigEntry, PluginSchemaNode, PluginSchemaSnapshot, PluginsSnapshot } from "../shared/plugin-config.js";
import { ConfigError, configPathKey } from "./error.js";
import { pluginConfigSource } from "./form.js";
import { memberSchema } from "./member-fields.js";
import { isObject } from "./secrets.js";
import { kRecord } from "./settle.js";
import type { ConfigStore } from "./store.js";

export class PluginCatalog {
  private cache = new Map<string, PluginSchemaSnapshot>();
  constructor(
    private ctx: Host,
    private store: ConfigStore,
  ) {}
  invalidate() {
    this.cache.clear();
  }
  async available(): Promise<{ name: string; label: string }[]> {
    // The host lists every module it runs in its config tree, those that are off too.
    const names = new Set<string>();
    const walk = (tree: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(tree)) {
        if (key.startsWith("$")) continue;
        const name = pluginBaseName(key);
        if (name === "group" && isObject(value)) walk(value);
        else names.add(name);
      }
    };
    walk(this.ctx.loader.config.plugins ?? {});
    return [...names]
      .filter((name) => this.store.listed(name))
      .sort()
      .map((name) => ({ name, label: name }));
  }
  async schema(name: string): Promise<PluginSchemaSnapshot> {
    if (!this.store.permitted(name)) throw new ConfigError(403, "not_permitted");
    if (!(await this.available()).some((entry) => entry.name === name)) throw new ConfigError(404, "not_found");
    const cached = this.cache.get(name);
    if (cached) return this.project(name, this.withDynamics(cached));
    let plugin: { moduleConfig?: unknown; Config?: unknown; schema?: unknown; usage?: unknown } | undefined;
    try {
      plugin = await this.ctx.loader.resolve(name);
    } catch {
      /* unavailable package has no editable schema */
    }
    const snapshot: PluginSchemaSnapshot = {
      schema: pluginConfigSource(plugin).form(),
      usage: typeof plugin?.usage === "string" ? plugin.usage : "",
      dynamics: {},
    };
    this.cache.set(name, snapshot);
    return this.project(name, this.withDynamics(snapshot));
  }
  private project(name: string, snapshot: PluginSchemaSnapshot): PluginSchemaSnapshot {
    const projection = this.store.projection(name);
    return projection ? { ...snapshot, schema: memberSchema(projection, snapshot.schema) } : snapshot;
  }
  private withDynamics(snapshot: PluginSchemaSnapshot): PluginSchemaSnapshot {
    const dynamics: PluginSchemaSnapshot["dynamics"] = {};
    const scan = (node: unknown, depth = 0) => {
      if (!isObject(node) || depth > 80) return;
      if (node.type === "dynamic") {
        const name = String(node.name ?? node.inner ?? "");
        if (!Object.hasOwn(dynamics, name)) {
          dynamics[name] = {};
          const schema = this.ctx.schema?.get(name);
          if (schema) {
            dynamics[name] = schema.toJSON() as PluginSchemaNode;
            scan(dynamics[name], depth + 1);
          }
        }
      }
      for (const [key, value] of Object.entries(node))
        if (key !== "meta") {
          if (Array.isArray(value)) value.forEach((child) => scan(child, depth + 1));
          else if (isObject(value)) {
            if (key === "dict") Object.values(value).forEach((child) => scan(child, depth + 1));
            else scan(value, depth + 1);
          }
        }
    };
    scan(snapshot.schema);
    return { ...snapshot, dynamics };
  }
  async snapshot(): Promise<PluginsSnapshot> {
    const revision = this.store.revision();
    const walk = async (
      tree: Record<string, unknown>,
      parent = "",
      enabled = true,
      context: Host | undefined = this.ctx.loader.entry,
    ): Promise<PluginConfigEntry[]> => {
      const result: PluginConfigEntry[] = [];
      for (const [key, value] of Object.entries(tree)) {
        if (key.startsWith("$") || !isObject(value) || !this.ctx.loader.isTruthyLike(value.$if)) continue;
        const name = pluginBaseName(key);
        if (!this.store.listed(name)) continue;
        const path = [parent, configPathKey(key)].filter(Boolean).join("/");
        const active = enabled && !key.startsWith("~");
        const fork = (
          context?.scope as unknown as Record<symbol, Record<string, { ctx: Host; error?: unknown; isActive?: boolean; runtime?: { error?: unknown } }>>
        )?.[kRecord]?.[key];
        let needsConfig = false;
        if (name !== "group")
          try {
            const plugin = await this.ctx.loader.resolve(name);
            needsConfig = pluginConfigSource(plugin).check(value) !== undefined;
          } catch {
            needsConfig = true;
          }
        result.push({
          path,
          key,
          name,
          label: typeof value.$label === "string" ? value.$label : name,
          enabled: active,
          group: name === "group",
          status: !active ? "disabled" : fork?.error || fork?.runtime?.error ? "failed" : fork?.isActive ? "active" : "loading",
          needsConfig,
          locked: this.store.locked(value, key),
          ...(name === "group" ? { children: await walk(value, path, active, fork?.ctx) } : {}),
        });
      }
      return result;
    };
    const tree = await walk(this.ctx.loader.config.plugins ?? {});
    return { revision, writable: !!this.ctx.loader.writable, tree, available: await this.available() };
  }
}
