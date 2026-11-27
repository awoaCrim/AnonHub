import { z } from "zod/v4";

import type { ToolCapability } from "./capabilities.js";
import {
  actorSchema,
  conversationKind,
  conversationSchema,
  opaqueId,
  type ActorIdentity,
  type ConversationIdentity,
  type ConversationKind,
} from "./identity.js";
import { allowedUsers } from "./platforms.js";
import { isComputerTool, grantsTool } from "./tools.js";

export const scopeRuleSchema = z
  .object({
    kind: z.enum(["direct", "group", "any"]),
    platform: opaqueId,
    conversationId: opaqueId,
    botId: opaqueId.optional(),
    userId: opaqueId.optional(),
  })
  .strict();

export type ScopeRule = z.infer<typeof scopeRuleSchema>;

const toolsSchema = z.object({ enabled: z.boolean(), tools: z.array(opaqueId).max(512) }).strict();
const platformPolicySchema = z
  .object({
    direct: toolsSchema,
    group: toolsSchema,
    actors: z.array(scopeRuleSchema).max(512),
  })
  .strict();
export type PlatformToolPolicy = z.infer<typeof platformPolicySchema>;

export const toolPolicySchema = z
  .object({
    version: z.literal(1),
    appliedPlatforms: z.array(opaqueId).max(64).optional(),
    computerPlatforms: z.array(opaqueId).max(64).optional(),
    direct: toolsSchema,
    group: toolsSchema,
    actors: z.array(scopeRuleSchema).max(512),
    platforms: z
      .record(
        opaqueId.refine((name) => !["*", "__proto__", "constructor", "prototype"].includes(name)),
        platformPolicySchema,
      )
      .refine((platforms) => Object.keys(platforms).length <= 64)
      .optional(),
  })
  .strict();

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

/** Exact platform overrides replace both tool selection and actor grants; old policies retain their behavior. */
export function toolPolicyForPlatform(policy: ToolPolicy, platform: string): PlatformToolPolicy {
  return policy.platforms && Object.hasOwn(policy.platforms, platform) ? policy.platforms[platform]! : policy;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly pluginId: string;
  readonly contexts: readonly ConversationKind[];
  readonly capability?: ToolCapability;
}

export interface InvocationIdentity {
  readonly conversation: ConversationIdentity;
  /** Trusted transport identities of all actors in this turn; never model arguments. */
  readonly actors: readonly ActorIdentity[];
}

export type AccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "invalid-identity" | "unsupported-context" | "context-disabled" | "tool-disabled" | "actor-denied";
    };

export function denyToolPolicy(): ToolPolicy {
  return { version: 1, direct: { enabled: false, tools: [] }, group: { enabled: false, tools: [] }, actors: [] };
}

/** One decision function is shared by tool projection, execution and device dispatch. */
export function authorizeTool(identity: InvocationIdentity, tool: ToolDescriptor, policy: ToolPolicy): AccessDecision {
  if (
    !conversationSchema.safeParse(identity.conversation).success ||
    identity.actors.length > 128 ||
    identity.actors.some((actor) => !actorSchema.safeParse(actor).success || actor.platform !== identity.conversation.platform) ||
    !toolPolicySchema.safeParse(policy).success ||
    !opaqueId.safeParse(tool.name).success ||
    !opaqueId.safeParse(tool.pluginId).success ||
    tool.contexts.some((kind) => !conversationKind.safeParse(kind).success)
  ) {
    return { allowed: false, reason: "invalid-identity" };
  }
  const context = identity.conversation;
  if (!tool.contexts.includes(context.kind)) return { allowed: false, reason: "unsupported-context" };
  const applications = isComputerTool(tool.name) ? policy.computerPlatforms : policy.appliedPlatforms;
  if (applications && !applications.includes(context.platform)) return { allowed: false, reason: "context-disabled" };
  const selected = toolPolicyForPlatform(policy, context.platform);
  const entry = selected[context.kind];
  if (!entry?.enabled) return { allowed: false, reason: "context-disabled" };
  if (!grantsTool(entry.tools, tool.name)) return { allowed: false, reason: "tool-disabled" };
  // Who may chat privately is decided by the bot's channel allowlist; only group chats take a sender limit.
  const users = context.kind === "group" ? allowedUsers(selected.actors, context.platform, "group") : undefined;
  if (!users) return { allowed: true };
  // Every current sender must be allowed; an actor-less turn cannot satisfy a sender restriction.
  const actors = [...new Set(identity.actors.map((actor) => actor.userId))];
  return actors.length && actors.every((actor) => users.includes(actor)) ? { allowed: true } : { allowed: false, reason: "actor-denied" };
}

function matches(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === value;
}
