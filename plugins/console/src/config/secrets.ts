import { isSecretRef } from "@yesimbot/foundation";

import type { PluginSchemaNode } from "../shared/plugin-config.js";

export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export const isSecretMarker = (value: unknown): boolean =>
  isObject(value) && value.$secret === true && Object.keys(value).every((key) => key === "$secret" || key === "sourcePath");

export function redactSecrets(value: unknown, schema: PluginSchemaNode | null, dynamics: Record<string, PluginSchemaNode> = {}): unknown {
  return transform(value, undefined, secretPaths(schema, value, dynamics), false);
}

export function restoreSecrets(value: unknown, original: unknown, schema: PluginSchemaNode | null, dynamics: Record<string, PluginSchemaNode> = {}): unknown {
  const paths = secretPaths(schema, value, dynamics);
  const originalPaths = secretPaths(schema, original, dynamics);
  const unsafe = new Set(["__proto__", "prototype", "constructor"]);
  // Markers are accepted only where the schema establishes a secret role.
  const restore = (item: unknown, old: unknown, path: string[] = []): unknown => {
    if (isSecretMarker(item)) {
      if (path.some((key) => unsafe.has(key)) || !paths.has(JSON.stringify(path))) throw new Error("invalid_secret_marker");
      if (isObject(item) && Object.hasOwn(item, "sourcePath")) {
        const source = item.sourcePath;
        if (!Array.isArray(source) || source.some((key) => typeof key !== "string" || unsafe.has(key)) || !originalPaths.has(JSON.stringify(source)))
          throw new Error("invalid_secret_marker");
        let stored = original;
        for (const key of source) {
          if ((!isObject(stored) && !Array.isArray(stored)) || !Object.hasOwn(stored, key)) throw new Error("invalid_secret_marker");
          stored = (stored as Record<string, unknown>)[key];
        }
        return structuredClone(stored ?? "");
      }
      return structuredClone(old ?? "");
    }
    if (Array.isArray(item)) return item.map((child, index) => restore(child, Array.isArray(old) ? old[index] : undefined, [...path, String(index)]));
    if (isObject(item))
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, restore(child, isObject(old) ? old[key] : undefined, [...path, key])]));
    return item;
  };
  return restore(value, original);
}

/** Server-only collection for scrubbing log output; never return these values in an API. */
export function collectSecretValues(value: unknown, schema: PluginSchemaNode | null, dynamics: Record<string, PluginSchemaNode> = {}): string[] {
  const result: string[] = [];
  const visit = (original: unknown, redacted: unknown) => {
    if (isSecretMarker(redacted)) {
      // A secret may be a whole object (a union of a dictionary and a string): every string inside it counts.
      const strings = (item: unknown): void => {
        if (typeof item === "string" && item) result.push(item);
        else if (Array.isArray(item)) item.forEach(strings);
        else if (isObject(item)) Object.values(item).forEach(strings);
      };
      strings(original);
      return;
    }
    if (Array.isArray(redacted)) redacted.forEach((item, index) => visit(Array.isArray(original) ? original[index] : undefined, item));
    else if (isObject(redacted)) for (const [key, item] of Object.entries(redacted)) visit(isObject(original) ? original[key] : undefined, item);
  };
  visit(value, redactSecrets(value, schema, dynamics));
  return result;
}

/**
 * A module config as `config/<id>.json` stores it (convention 02 rule 4): each non-empty value the form marks secret
 * becomes `{ $secret: "<JSON pointer>" }`, and the secrets file maps the pointer to the value. Found the way the console
 * redacts them, so what a form hides is what goes to the secrets file. The input is not changed.
 */
export function splitSecrets(
  config: Record<string, unknown>,
  schema: PluginSchemaNode | null,
  dynamics: Record<string, PluginSchemaNode> = {},
): { stored: Record<string, unknown>; secrets: Record<string, unknown> } {
  const pointers: string[] = [];
  const visit = (value: unknown) => {
    if (isSecretMarker(value)) {
      pointers.push(jsonPointer((value as { sourcePath: string[] }).sourcePath));
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (isObject(value)) Object.values(value).forEach(visit);
  };
  visit(redactSecrets(config, schema, dynamics));
  return splitAt(config, pointers);
}

/** The config with the values at `pointers` replaced by references, and the secrets file. */
export function splitAt(config: Record<string, unknown>, pointers: readonly string[]): { stored: Record<string, unknown>; secrets: Record<string, unknown> } {
  const stored = structuredClone(config);
  const secrets: Record<string, unknown> = {};
  for (const ref of pointers) {
    const path = ref
      .split("/")
      .slice(1)
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    const value = valueAt(config, path);
    if (value === undefined || isSecretRef(value)) continue;
    secrets[ref] = structuredClone(value);
    let parent: unknown = stored;
    for (const key of path.slice(0, -1)) parent = (parent as Record<string, unknown>)[key];
    (parent as Record<string, unknown>)[path.at(-1)!] = { $secret: ref };
  }
  return { stored, secrets };
}

export function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function jsonPointer(path: readonly string[]): string {
  return path.map((part) => "/" + part.replaceAll("~", "~0").replaceAll("/", "~1")).join("");
}

/** Collect every applicable branch: selecting only one union can expose a secret. */
function secretPaths(
  schema: PluginSchemaNode | null,
  value: unknown,
  dynamics: Record<string, PluginSchemaNode>,
  prefix: string[] = [],
  result = new Set<string>(),
  depth = 0,
): Set<string> {
  if (!schema || depth > 80) return result;
  if (schema.meta?.role === "secret") result.add(JSON.stringify(prefix));
  if (schema.type === "dynamic") {
    const name = String(schema.name ?? schema.inner ?? "");
    secretPaths(dynamics[name], value, dynamics, prefix, result, depth + 1);
  }
  if (schema.type === "transform" && schema.inner) secretPaths(schema.inner, value, dynamics, prefix, result, depth + 1);
  for (const branch of schema.list ?? []) secretPaths(branch, value, dynamics, prefix, result, depth + 1);
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const child = schema.dict?.[key] ?? (schema.type === "dict" ? schema.inner : undefined);
      if (child) secretPaths(child, item, dynamics, [...prefix, key], result, depth + 1);
    }
  }
  if (Array.isArray(value) && schema.inner)
    value.forEach((item, index) => secretPaths(schema.inner!, item, dynamics, [...prefix, String(index)], result, depth + 1));
  return result;
}

function transform(value: unknown, original: unknown, paths: Set<string>, restore: boolean, path: string[] = []): unknown {
  if (isSecretMarker(value)) return restore ? structuredClone(original ?? "") : { $secret: true, sourcePath: [...path] };
  if (paths.has(JSON.stringify(path)) && !restore)
    return value === undefined || value === null || value === "" ? value : { $secret: true, sourcePath: [...path] };
  if (Array.isArray(value))
    return value.map((item, index) => transform(item, Array.isArray(original) ? original[index] : undefined, paths, restore, [...path, String(index)]));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, transform(item, isObject(original) ? original[key] : undefined, paths, restore, [...path, key])]),
    );
  return value;
}
