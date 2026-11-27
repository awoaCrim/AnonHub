import { z } from "zod/v4";

/** Opaque provider IDs are never used as filesystem paths or colon-joined keys. */
export const opaqueId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u0020\u007f]+$/);
export const uuid = z.string().uuid();
export const conversationKind = z.enum(["direct", "group"]);

export const conversationSchema = z
  .object({
    tenantId: uuid,
    botId: opaqueId,
    platform: opaqueId,
    kind: conversationKind,
    conversationId: opaqueId,
    parentId: opaqueId.optional(),
  })
  .strict();

export type ConversationIdentity = z.infer<typeof conversationSchema>;
export type ConversationKind = z.infer<typeof conversationKind>;

export const actorSchema = z.object({ platform: opaqueId, userId: opaqueId }).strict();
export type ActorIdentity = z.infer<typeof actorSchema>;

export const workspaceOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal"), tenantId: uuid, platform: opaqueId, userId: opaqueId }).strict(),
  z.object({ kind: z.literal("conversation"), conversation: conversationSchema }).strict(),
  z.object({ kind: z.literal("shared"), tenantId: uuid, spaceId: uuid }).strict(),
]);
export type WorkspaceOwner = z.infer<typeof workspaceOwnerSchema>;

export function conversationKey(value: ConversationIdentity): string {
  const c = conversationSchema.parse(value);
  return JSON.stringify(["conversation", 1, c.tenantId, c.botId, c.platform, c.kind, c.parentId ?? null, c.conversationId]);
}

export function workspaceOwnerKey(value: WorkspaceOwner): string {
  const owner = workspaceOwnerSchema.parse(value);
  switch (owner.kind) {
    case "personal":
      return JSON.stringify(["personal", 1, owner.tenantId, owner.platform, owner.userId]);
    case "conversation":
      return conversationKey(owner.conversation);
    case "shared":
      return JSON.stringify(["shared", 1, owner.tenantId, owner.spaceId]);
  }
}

/** Ownership is derived from the authenticated binding, never a device's claimed tenant. */
export const deviceIdentitySchema = z.object({ tenantId: uuid, deviceId: uuid }).strict();
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;
