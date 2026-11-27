import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { newId } from "@yesimbot/foundation";

import type { Host } from "../host.js";
import { OPTIONAL_MEMBER_PLUGIN_NAMES, REQUIRED_MEMBER_PLUGINS, normalizeMemberPlugins, pluginBaseName } from "../shared/plugin-catalog.js";
import { PluginCatalog } from "./catalog.js";
import { ConfigError, configPathKey, decodeKey } from "./error.js";
import { pluginConfigSource } from "./form.js";
import { MEMBER_INFRASTRUCTURE, memberConfig, restoreMemberFields } from "./member-fields.js";
import { isObject, redactSecrets, restoreSecrets } from "./secrets.js";
import { kRecord, settleReload } from "./settle.js";

const locks = new WeakMap<object, Promise<unknown>>();

type Tree = Record<string, unknown>;

interface Scope {
  ctx: Host;
  [kRecord]: Record<string, Fork>;
}

interface Fork {
  ctx: Host & { scope: Scope };
  error?: unknown;
  isActive?: boolean;
  runtime?: { error?: unknown; isReusable?: boolean; isActive?: boolean };
}

export class ConfigStore {
  readonly catalog: PluginCatalog;
  constructor(
    readonly ctx: Host,
    private readonly options: { selfService?: boolean } = {},
  ) {
    this.catalog = new PluginCatalog(ctx, this);
  }
  revision(): string {
    return createHash("sha256").update(JSON.stringify(this.ctx.loader.config)).digest("hex");
  }
  projection(name: string): string | undefined {
    if (this.options.selfService && ["yesimbot", "yesimbot-google", "yesimbot-mcp-client"].includes(name)) return `self-service:${name}`;
    if (this.options.selfService) return name;
    if (this.allowed()) return name;
    if (name === "yesimbot" && process.env.YESIMBOT_MANAGED_CONTEXT === "1") return "managed-context";
  }
  allowed(): Set<string> | undefined {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(process.env.YESIMBOT_TENANT_ID ?? "")) return;
    try {
      const data = JSON.parse(readFileSync("/run/yesimbot/policy/plugins.json", "utf8"));
      if (data.version !== 1) throw new Error();
      return new Set([...REQUIRED_MEMBER_PLUGINS, ...normalizeMemberPlugins(data.plugins)]);
    } catch {
      return new Set(REQUIRED_MEMBER_PLUGINS);
    }
  }
  permitted(name: string): boolean {
    // What this instance installed from npm is its owner's own: editable whatever the catalog or the grant says.
    if (this.installed().has(pluginBaseName(name))) return true;
    if (this.options.selfService && name !== "group" && ![...REQUIRED_MEMBER_PLUGINS, ...OPTIONAL_MEMBER_PLUGIN_NAMES].includes(pluginBaseName(name)))
      return false;
    const allowed = this.allowed();
    return !allowed || name === "group" || allowed.has(pluginBaseName(name));
  }
  listed(name: string): boolean {
    return this.permitted(name) && (!(this.options.selfService || this.allowed()) || !MEMBER_INFRASTRUCTURE.has(pluginBaseName(name)));
  }
  /** Module IDs of the extensions this instance installed (`Host.extensions`). */
  private installed(): Set<string> {
    return new Set((this.ctx.extensions?.list() ?? []).flatMap((item) => (item.module ? [item.module] : [])));
  }
  private assertMemberEditor(name: string): void {
    if ((this.options.selfService || this.allowed()) && (!this.listed(name) || name === "yesimbot-model-provider")) throw new ConfigError(403, "locked");
  }
  resolve(path: string): { parent: Tree; key: string; value: Tree; parentPath: string; active: boolean; ctx?: Host } {
    if (
      typeof path !== "string" ||
      !path ||
      path.split("/").some((part) => !part || part.startsWith("$") || ["__proto__", "constructor", "prototype"].includes(part))
    )
      throw new ConfigError(404, "not_found");
    const parts = path.split("/");
    const key = decodeKey(parts.pop()!);
    const group = this.group(parts.join("/"));
    if (!Object.hasOwn(group.value, key) || !isObject(group.value[key])) throw new ConfigError(404, "not_found");
    const value = group.value[key] as Tree;
    if (!this.ctx.loader.isTruthyLike(value.$if)) throw new ConfigError(404, "not_found");
    if (!this.permitted(pluginBaseName(key))) throw new ConfigError(403, "not_permitted");
    return { parent: group.value, key, value, parentPath: parts.join("/"), active: group.active && !key.startsWith("~"), ctx: group.ctx };
  }
  group(path: string): { value: Tree; active: boolean; ctx?: Host } {
    let value = (this.ctx.loader.config.plugins ?? {}) as Tree;
    let parent = this.ctx.loader.entry as Host | undefined;
    let active = true;
    for (const segment of path ? path.split("/") : []) {
      const key = decodeKey(segment);
      if (pluginBaseName(key) !== "group" || !Object.hasOwn(value, key) || !isObject(value[key])) throw new ConfigError(404, "not_found");
      value = value[key] as Tree;
      if (!this.ctx.loader.isTruthyLike(value.$if)) throw new ConfigError(404, "not_found");
      active = active && !key.startsWith("~");
      parent = (parent?.scope as unknown as Scope)?.[kRecord]?.[key]?.ctx;
    }
    return { value, active, ctx: parent };
  }
  locked(value: Tree, key: string): boolean {
    const name = pluginBaseName(key);
    return (
      name === "yesimbot-console" ||
      (!!(this.options.selfService || this.allowed()) && (MEMBER_INFRASTRUCTURE.has(name) || name === "yesimbot-model-provider")) ||
      (name === "group" && Object.entries(value).some(([child, config]) => isObject(config) && this.locked(config, child)))
    );
  }
  private assertMutable(path: string): ReturnType<ConfigStore["resolve"]> {
    const entry = this.resolve(path);
    this.assertMemberEditor(pluginBaseName(entry.key));
    if (this.locked(entry.value, entry.key)) throw new ConfigError(403, "locked");
    // Group replacement cannot smuggle in an unauthorized plugin or a second console.
    return entry;
  }
  private assertSubtreePermitted(key: string, value: Tree): void {
    if (!this.permitted(pluginBaseName(key))) throw new ConfigError(403, "not_permitted");
    if (pluginBaseName(key) === "group")
      for (const [child, config] of Object.entries(value)) {
        if (!child.startsWith("$") && !child.startsWith("~") && isObject(config)) this.assertSubtreePermitted(child, config);
      }
  }
  async read(path: string) {
    const entry = this.resolve(path);
    this.assertMemberEditor(pluginBaseName(entry.key));
    if (pluginBaseName(entry.key) === "group") throw new ConfigError(403, "locked");
    const revision = this.revision();
    const schema = await this.catalog.schema(pluginBaseName(entry.key));
    if (revision !== this.revision()) throw new ConfigError(409, "config_changed");
    const config = structuredClone(entry.value);
    return {
      revision,
      config: redactSecrets(
        this.projection(pluginBaseName(entry.key)) ? memberConfig(this.projection(pluginBaseName(entry.key))!, config) : config,
        schema.schema,
        schema.dynamics,
      ) as Tree,
    };
  }
  async transaction<T>(revision: string, action: () => Promise<T>, authorize?: () => void): Promise<T> {
    const previous = locks.get(this.ctx.loader) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        authorize?.();
        if (revision !== this.revision()) throw new ConfigError(409, "config_changed");
        if (!this.ctx.loader.writable) throw new ConfigError(403, "not_permitted");
        return action();
      });
    locks.set(this.ctx.loader, current);
    try {
      return await current;
    } finally {
      if (locks.get(this.ctx.loader) === current) locks.delete(this.ctx.loader);
    }
  }
  /** Internal batch adapter: caller must own transaction and handle reverse rollback. */
  async updateRaw(path: string, config: Tree): Promise<void> {
    const entry = this.resolve(path);
    if (entry.active) {
      if (!entry.ctx) throw new Error("scope_unavailable");
      entry.parent[entry.key] = structuredClone(config);
      const fork = await this.ctx.loader.reload(entry.ctx, entry.key, structuredClone(config));
      if (!fork) throw new Error("scope_missing");
      await settleReload(this.ctx, fork);
    } else entry.parent[entry.key] = structuredClone(config);
    await this.ctx.loader.writeConfig();
  }
  private async mutation(revision: string, path: string, apply: () => Promise<string | void>, authorize?: () => void) {
    return this.transaction(
      revision,
      async () => {
        const before = structuredClone(this.ctx.loader.config.plugins ?? {});
        try {
          const next = await apply();
          return { revision: this.revision(), ...(next ? { path: next } : {}) };
        } catch (error) {
          if (error instanceof ConfigError && error.code !== "apply_failed") throw error;
          let restored = true;
          try {
            const restore = async (current: Tree, prior: Tree, parent?: Host): Promise<void> => {
              for (const key of new Set([...Object.keys(current), ...Object.keys(prior)])) {
                if (JSON.stringify(current[key]) === JSON.stringify(prior[key])) continue;
                if (pluginBaseName(key) === "group" && isObject(current[key]) && isObject(prior[key])) {
                  const fork = (parent?.scope as unknown as Scope)?.[kRecord]?.[key];
                  await restore(current[key] as Tree, prior[key] as Tree, fork?.ctx);
                } else {
                  const exists = Object.hasOwn(prior, key);
                  try {
                    if (parent && !key.startsWith("$") && !key.startsWith("~")) this.ctx.loader.unload(parent, key);
                  } catch {
                    restored = false;
                  }
                  if (exists) current[key] = structuredClone(prior[key]);
                  else delete current[key];
                  try {
                    if (exists && parent && !key.startsWith("$") && !key.startsWith("~"))
                      await settleReload(this.ctx, await this.ctx.loader.reload(parent, key, structuredClone(prior[key])));
                  } catch {
                    restored = false;
                  }
                }
              }
              // Keep the object identities used by Loader group scopes, restoring native key order.
              const ordered = Object.fromEntries(Object.keys(prior).map((key) => [key, current[key]]));
              for (const key of Object.keys(current)) delete current[key];
              Object.assign(current, ordered);
            };
            await restore(this.ctx.loader.config.plugins as Tree, before, this.ctx.loader.entry);
            await this.ctx.loader.writeConfig();
          } catch {
            restored = false;
          }
          throw new ConfigError(503, "apply_failed", path, restored);
        }
      },
      authorize,
    );
  }
  async update(revision: string, path: string, config: unknown, authorize?: () => void) {
    return this.mutation(
      revision,
      path,
      async () => {
        const entry = this.assertMutable(path);
        if (pluginBaseName(entry.key) === "group") throw new ConfigError(403, "locked");
        if (!isObject(config)) throw new ConfigError(400, "invalid_config", path);
        if (this.projection(pluginBaseName(entry.key)))
          config = restoreMemberFields(this.projection(pluginBaseName(entry.key))!, config, entry.value, (field) => {
            throw new ConfigError(403, "locked", field);
          });
        const schema = await this.catalog.schema(pluginBaseName(entry.key));
        let merged: Tree;
        try {
          merged = restoreSecrets(structuredClone(config), entry.value, schema.schema, schema.dynamics) as Tree;
        } catch (error) {
          const options = isObject(error) && isObject(error.options) ? error.options : undefined;
          const field =
            Array.isArray(options?.path) &&
            options.path.every((part) => typeof part === "number" || (typeof part === "string" && /^[A-Za-z_$][\w$-]{0,127}$/.test(part)))
              ? options.path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${part}`)).join("")
              : undefined;
          throw new ConfigError(400, "invalid_config", field || path);
        }
        if (revision !== this.revision()) throw new ConfigError(409, "config_changed");
        if (JSON.stringify(merged) === JSON.stringify(entry.value)) return;
        const plugin = await this.ctx.loader.resolve(pluginBaseName(entry.key));
        const field = pluginConfigSource(plugin).check(merged);
        if (field !== undefined) throw new ConfigError(400, "invalid_config", field || path);
        if (revision !== this.revision()) throw new ConfigError(409, "config_changed");
        authorize?.();
        if (JSON.stringify(merged) !== JSON.stringify(entry.value)) await this.updateRaw(path, merged);
      },
      authorize,
    );
  }
  async setEnabled(revision: string, path: string, enabled: boolean, authorize?: () => void) {
    return this.mutation(
      revision,
      path,
      async () => {
        const entry = this.assertMutable(path);
        if (typeof enabled !== "boolean") throw new ConfigError(400, "invalid_config");
        const next = (enabled ? "" : "~") + entry.key.replace(/^~/, "");
        if (next === entry.key) return path;
        if (enabled) this.assertSubtreePermitted(entry.key, entry.value);
        if (enabled) rename(entry.parent, entry.key, next);
        if (entry.ctx && this.group(entry.parentPath).active) {
          if (enabled) {
            const fork = await this.ctx.loader.reload(entry.ctx, next, structuredClone(entry.value));
            if (!fork) throw new Error("scope_missing");
            await settleReload(this.ctx, fork);
          } else {
            this.ctx.loader.unload(entry.ctx, entry.key);
            await settleReload(this.ctx);
          }
        }
        if (!enabled) {
          // Loader's disposal listener reads the active key and may rename it itself.
          // Keep that value available until disposal settles, then preserve the config
          // even when no runtime fork existed (for example inside a disabled group).
          rename(entry.parent, entry.key, next);
          entry.parent[next] = entry.value;
        }
        await this.ctx.loader.writeConfig();
        return [entry.parentPath, configPathKey(next)].filter(Boolean).join("/");
      },
      authorize,
    );
  }
  async add(revision: string, parent: string, name: string) {
    return this.mutation(revision, parent, async () => {
      if (typeof name !== "string" || !/^(?:@[\w-]+\/)?[\w-]+$/.test(name) || name === "group") throw new ConfigError(400, "invalid_config");
      if (pluginBaseName(name) === "yesimbot-console") throw new ConfigError(403, "locked");
      if (!this.permitted(name)) throw new ConfigError(403, "not_permitted");
      this.assertMemberEditor(pluginBaseName(name));
      const group = this.group(parent);
      const available = await this.catalog.available();
      if (!available.some((item) => item.name === name)) throw new ConfigError(404, "not_found");
      if (revision !== this.revision()) throw new ConfigError(409, "config_changed");
      let key: string;
      do {
        key = `~${name}:${newId().slice(0, 6)}`;
      } while (Object.hasOwn(group.value, key));
      group.value[key] = {};
      await this.ctx.loader.writeConfig();
      return [parent, configPathKey(key)].filter(Boolean).join("/");
    });
  }
  async remove(revision: string, path: string) {
    return this.mutation(revision, path, async () => {
      const entry = this.assertMutable(path);
      if (entry.active && entry.ctx) this.ctx.loader.unload(entry.ctx, entry.key);
      delete entry.parent[entry.key];
      await settleReload(this.ctx);
      await this.ctx.loader.writeConfig();
    });
  }
  async move(revision: string, path: string, target: string, index: number) {
    return this.mutation(revision, path, async () => {
      const entry = this.assertMutable(path);
      if (!Number.isSafeInteger(index) || index < 0 || target === path || target.startsWith(path + "/")) throw new ConfigError(400, "invalid_config");
      const destination = this.group(target);
      if (destination.active && !entry.key.startsWith("~")) this.assertSubtreePermitted(entry.key, entry.value);
      if (destination.value !== entry.parent && Object.hasOwn(destination.value, entry.key)) throw new ConfigError(400, "invalid_config");
      // Restart through public Loader APIs so inherited filters/injection follow the destination.
      if (entry.active && entry.ctx) this.ctx.loader.unload(entry.ctx, entry.key);
      delete entry.parent[entry.key];
      const rest = Object.entries(destination.value);
      rest.splice(Math.min(index, rest.length), 0, [entry.key, entry.value]);
      for (const key of Object.keys(destination.value)) delete destination.value[key];
      Object.assign(destination.value, Object.fromEntries(rest));
      if (destination.active && !entry.key.startsWith("~") && destination.ctx) {
        const fork = await this.ctx.loader.reload(destination.ctx, entry.key, structuredClone(entry.value));
        if (!fork) throw new Error("scope_missing");
        await settleReload(this.ctx, fork);
      }
      await this.ctx.loader.writeConfig();
      return [target, configPathKey(entry.key)].filter(Boolean).join("/");
    });
  }
}

function rename(tree: Tree, from: string, to: string) {
  const entries = Object.entries(tree);
  for (const key of Object.keys(tree)) delete tree[key];
  for (const [key, value] of entries) tree[key === from ? to : key] = value;
}

export { ConfigError, configPathKey } from "./error.js";
