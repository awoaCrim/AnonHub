import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { isObject } from "./config/secrets.js";
import definition from "./shared/context-policy.json";

export const CONTEXT_POLICY_FILE = process.env.YESIMBOT_CONTEXT_POLICY_FILE || "/run/yesimbot/policy/context.json";

export type Tree = Record<string, unknown>;

/** Only the keys listed in `shared/context-policy.json` enter the shared policy. */
export function contextPolicy(session: unknown): { version: 1; session: Tree } {
  const project = (shape: Tree, value: Tree): Tree =>
    Object.fromEntries(
      Object.entries(shape).flatMap(([key, rule]): [string, unknown][] => {
        if (!Array.isArray(rule)) return [[key, project(rule as Tree, isObject(value[key]) ? value[key] : {})]];
        const item = value[key] ?? rule[1];
        if (item === null) return [];
        if (typeof item !== "number" || !Number.isFinite(item) || item < rule[2] || (rule[0] === "integer" && !Number.isSafeInteger(item)))
          throw new Error("invalid_context_policy");
        return [[key, item]];
      }),
    );
  const result = project(definition, isObject(session) ? session : {});
  return { version: 1, session: result };
}

export function readContextPolicy(file = CONTEXT_POLICY_FILE): Tree {
  const text = readFileSync(file, "utf8");
  if (text.length > 8192) throw new Error("invalid_context_policy");
  const parsed = JSON.parse(text);
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.session)) throw new Error("invalid_context_policy");
  const normalized = contextPolicy(parsed.session);
  if (!isDeepStrictEqual(parsed, normalized)) throw new Error("invalid_context_policy");
  return normalized.session;
}
