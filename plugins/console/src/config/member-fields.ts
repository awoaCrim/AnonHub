import type { PluginSchemaNode } from "../shared/plugin-config.js";
import { isObject } from "./secrets.js";

/** These runtime services are installed and maintained by the host, not member forms. */
export const MEMBER_INFRASTRUCTURE = new Set([
  "database-sqlite",
  "http",
  "server",
  "proxy-agent",
  "console",
  "config",
  "logger",
  "status",
  "assets-local",
  "adapter-onebot",
  "yesimbot-console",
  "yesimbot-device-connection",
]);

const fields: Record<string, string[][]> = {
  "managed-context": [["session"]],
  yesimbot: [["basePath"], ["logLevel"], ["session"]],
  // The bot never reads or changes 管理员 (`admins`): only the account holder sets it, in the 平台 page.
  "self-service:yesimbot": [["basePath"], ["logLevel"], ["session"], ["admins"]],
  "yesimbot-workspace": [
    ["bash", "mounts"],
    ["storage", "path"],
  ],
  "self-service:yesimbot-google": [["clientId"], ["clientSecret"], ["redirectUri"]],
};

/**
 * Values the bot may set but never reads back: they are treated as secrets (redacted on read, kept on save).
 * MCP servers are the bot's to manage, stdio commands included (user, 2026-11-18: 「全部放开」); their env and
 * header values usually hold credentials. `*` stands for any key of a dictionary.
 */
const secretFields: Record<string, string[][]> = {
  "self-service:yesimbot-mcp-client": [
    ["mcpServers", "*", "env"],
    ["mcpServers", "*", "headers"],
  ],
};

/** Project only the small, explicit set of host-managed fields out of member forms. */
export function memberSchema(name: string, schema: PluginSchemaNode | null): PluginSchemaNode | null {
  if (!schema || (!fields[name] && !secretFields[name])) return schema;
  const result = structuredClone(schema);
  for (const path of secretFields[name] ?? []) markSecret(result, path);
  const remove = (node: PluginSchemaNode, paths: string[][]) => {
    for (const [key, ...rest] of paths) {
      if (!node.dict?.[key]) continue;
      if (rest.length) remove(node.dict[key], [rest]);
      else delete node.dict[key];
    }
    node.list?.forEach((child) => remove(child, paths));
    if (node.inner) remove(node.inner, paths);
  };
  remove(result, fields[name] ?? []);
  return result;
}

export function memberConfig(name: string, config: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(config);
  for (const path of fields[name] ?? []) {
    let parent = result;
    for (const key of path.slice(0, -1)) {
      if (!isObject(parent[key])) break;
      parent = parent[key];
    }
    if (path.length === 1 || parent !== result) delete parent[path.at(-1)!];
  }
  return result;
}

/** Omission retains exact native values/default absence; a submitted change is rejected. */
export function restoreMemberFields(
  name: string,
  config: Record<string, unknown>,
  original: Record<string, unknown>,
  deny: (path: string) => never,
): Record<string, unknown> {
  const merge = (input: Record<string, unknown>, before: Record<string, unknown>, paths: string[][], prefix = ""): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(input)])) {
      const selected = paths.filter((path) => path[0] === key);
      if (selected.some((path) => path.length === 1)) {
        if (Object.hasOwn(input, key) && JSON.stringify(input[key]) !== JSON.stringify(before[key])) deny(prefix + key);
        if (Object.hasOwn(before, key)) result[key] = structuredClone(before[key]);
      } else if (selected.length && (isObject(before[key]) || isObject(input[key]))) {
        if (Object.hasOwn(input, key) && !isObject(input[key])) deny(prefix + key);
        const child = merge(
          isObject(input[key]) ? input[key] : {},
          isObject(before[key]) ? before[key] : {},
          selected.map((path) => path.slice(1)),
          `${prefix}${key}.`,
        );
        if (Object.hasOwn(input, key) || Object.keys(child).length) result[key] = child;
      } else if (Object.hasOwn(input, key)) result[key] = structuredClone(input[key]);
    }
    return result;
  };
  return fields[name] ? merge(config, original, fields[name]) : config;
}

/** At the end of `path`, a string becomes a secret, and so does each value of a dictionary of strings. */
function markSecret(node: PluginSchemaNode, path: string[]): void {
  node.list?.forEach((branch) => markSecret(branch, path));
  if (node.type === "transform" && node.inner) markSecret(node.inner, path);
  if (!path.length) {
    if (node.type === "string") node.meta = { ...node.meta, role: "secret" };
    if (node.type === "dict" && node.inner) markSecret(node.inner, []);
    return;
  }
  const [key, ...rest] = path;
  const child = key === "*" ? (node.type === "dict" ? node.inner : undefined) : node.dict?.[key];
  if (child) markSecret(child, rest);
}
