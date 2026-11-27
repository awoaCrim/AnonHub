import { z } from "zod/v4";

import { conversationKind, opaqueId, type ConversationIdentity } from "./identity.js";
import { PLATFORMS } from "./platforms.js";

export const toolExecutionKindSchema = z.enum(["communication", "read", "computer", "content", "service"]);

/** The kinds of background task; the main conversation is not one of them. */
export const taskWorkerKindSchema = z.enum(["computer", "content", "service"]);

export type ToolExecutionKind = z.infer<typeof toolExecutionKindSchema>;

export type TaskWorkerKind = z.infer<typeof taskWorkerKindSchema>;

/** A tool declaration is code/extension metadata, never a per-conversation grant. */
export const toolCapabilitySchema = z
  .object({
    platforms: z
      .array(opaqueId.refine((value) => value !== "*"))
      .min(1)
      .max(64),
    sensitive: z.boolean(),
    executionKind: toolExecutionKindSchema,
    contexts: z.array(conversationKind).min(1).max(2).optional(),
    workers: z.array(taskWorkerKindSchema).max(3).optional(),
  })
  .strict();

export interface ToolCapability {
  readonly platforms: readonly string[];
  readonly sensitive: boolean;
  readonly executionKind: ToolExecutionKind;
  readonly contexts?: readonly ("direct" | "group")[];
  /**
   * The background tasks that may use the tool. Absent, its execution kind decides: read tools go to every task,
   * computer tools to computer tasks, content tools to computer and content tasks, service tools to service tasks.
   */
  readonly workers?: readonly TaskWorkerKind[];
}

export type ToolCapabilityScope = Pick<ConversationIdentity, "platform" | "kind">;

export type CapabilityDecision =
  | { allowed: true }
  | { allowed: false; reason: "invalid-identity" | "undeclared-tool" | "unsupported-platform" | "unsupported-context" | "admin-only" };

/** Shared by projection and execution; no old policy, sender or task can widen this decision. */
/**
 * Every conversation has every tool its platform supports (user, 2026-11-18: 「所有会话都具有所有工具，但是只有系统维护的平台的那个管理员可以调用敏感工具」).
 * `admin` is whether the people behind this call are registered admins: absent when only deciding what to offer,
 * `false` refuses a sensitive tool. It replaces the 2026-11-13 rule that kept sensitive tools out of group chats.
 */
export function authorizeToolCapability(
  identity: { readonly conversation: ToolCapabilityScope; readonly admin?: boolean },
  capability: ToolCapability | undefined,
): CapabilityDecision {
  const scope = identity.conversation;
  if (!scope || !opaqueId.safeParse(scope.platform).success || !conversationKind.safeParse(scope.kind).success)
    return { allowed: false, reason: "invalid-identity" };
  const parsed = toolCapabilitySchema.safeParse(capability);
  if (!parsed.success) return { allowed: false, reason: "undeclared-tool" };
  const declared = parsed.data;
  if (!declared.platforms.includes(scope.platform)) return { allowed: false, reason: "unsupported-platform" };
  if (declared.contexts && !declared.contexts.includes(scope.kind)) return { allowed: false, reason: "unsupported-context" };
  if (declared.sensitive && identity.admin === false) return { allowed: false, reason: "admin-only" };
  return { allowed: true };
}

const platforms = PLATFORMS.map((platform) => platform.id);
const registry = new Map<string, Readonly<ToolCapability>>();
function register(
  plugin: string,
  names: readonly string[],
  executionKind: ToolExecutionKind,
  sensitive = false,
  adapted = platforms,
  contexts?: ToolCapability["contexts"],
) {
  for (const name of names)
    registry.set(
      `${plugin}\0${name}`,
      Object.freeze({ platforms: Object.freeze([...adapted]), sensitive, executionKind, ...(contexts ? { contexts: Object.freeze([...contexts]) } : {}) }),
    );
}

/** Narrows which background tasks get already registered tools; see `ToolCapability.workers`. */
function onlyFor(plugin: string, names: readonly string[], workers: readonly TaskWorkerKind[]) {
  for (const name of names) {
    const key = `${plugin}\0${name}`;
    const declared = registry.get(key);
    if (!declared) throw new Error(`undeclared_tool: ${plugin}/${name}`);
    registry.set(key, Object.freeze({ ...declared, workers: Object.freeze([...workers]) }));
  }
}

// Platform-independent Core mechanics adapt to the current transport; extensions cannot claim a
// built-in merely by using its name because every lookup also requires its owning plugin ID.
register("core", ["send_message", "finish", "reply_owner", "task_create", "task_status", "task_control", "task_report"], "communication");
register("core", ["read", "read_tool_output", "describe_image", "ctx_search", "ctx_expand", "ctx_reduce"], "read");
register("core", ["list_conversations", "read_conversation"], "read", true);
register("provider", ["web_search", "google_search", "google_search_retrieval"], "read");
register("yesimbot-search-service", ["search_web", "search_images", "read_webpage", "import_image_reference"], "read");
register("yesimbot-workspace", ["readFile", "listFiles"], "read", true);
register("yesimbot-workspace", ["bash", "writeFile", "editFile", "git"], "content", true);
// Static HTML rendering uses an isolated service, without device/filesystem access.
register("yesimbot-workspace", ["render_html"], "content");
register("yesimbot-workspace", ["computer_exec", "computer_job", "computer_use", "computer_browser", "computer_ui", "computer_switch"], "computer", true);
register("yesimbot-google", ["gmail", "google_calendar", "google_drive"], "read", true);
register("yesimbot-google", ["gmail_draft", "gmail_send", "gmail_modify", "google_calendar_write", "google_drive_write"], "service", true);
register("yesimbot-image-tools", ["generate_image", "edit_image"], "content");
register("yesimbot-schedule", ["schedule_list"], "read");
register("yesimbot-schedule", ["schedule_create", "schedule_update"], "service");
register("yesimbot-sticker-manager", ["sticker_preview", "sticker_search"], "read");
register("yesimbot-sticker-manager", ["sticker_send"], "communication");
register("yesimbot-sticker-manager", ["sticker_steal"], "service");
register("yesimbot-sticker-manager", ["sticker_manage"], "service", true);
register("yesimbot-memorizer", ["recall", "query_memories", "read_evidence"], "read");
register("yesimbot-memorizer", ["remember"], "service");
// The bot edits its own card only in the owner's private chat (user, 2026-11-24: 「只有主人私聊」).
register("yesimbot-roleplay", ["update_role_card"], "service", true, platforms, ["direct"]);
register("yesimbot-console", ["list_conversations", "read_conversation"], "read", true, ["web"], ["direct"]);
register("yesimbot-console", ["relay_to_conversation"], "service", true, ["web"], ["direct"]);
register("yesimbot-console", ["reply_owner"], "communication");
register("yesimbot-web-chat", ["web_create_reaction"], "communication", false, ["web"], ["direct"]);
register("yesimbot-instance-management", ["instance_memory_read"], "read", true, ["web"], ["direct"]);
register("yesimbot-instance-management", ["instance_memory_write"], "service", true, ["web"], ["direct"]);
register("yesimbot-onebot-utils", ["onebot_get_forward_message", "onebot_ocr_image"], "read", false, ["onebot"]);
register("yesimbot-onebot-utils", ["onebot_send_forward_message", "onebot_create_reaction"], "communication", false, ["onebot"]);
register("yesimbot-onebot-utils", ["onebot_set_essence"], "service", false, ["onebot"], ["group"]);
// Not "sensitive" (sensitive tools never run in groups): onebot-utils offers them only in groups the owner enabled
// and runs them only for that group's owner or admins (user, 2026-11-18: 「按群开启，只听管理员」).
register("yesimbot-onebot-utils", ["onebot_group_admin"], "service", false, ["onebot"], ["group"]);
register("yesimbot-onebot-utils", ["onebot_set_qq_profile"], "service", true, ["onebot"]);
// WeChat group rosters, WeChat only (user, 2026-11-23: 「只加微信的」).
register("adapter-wechat-bridge", ["wechat_group_members"], "read", false, ["wechat-bridge"], ["group"]);
// Xiaoheihe is an extension for every platform (user, 2026-11-18: 「读取给全平台，发帖仅私聊」): reading is open
// to everyone; publishing is sensitive, so it runs only for admins (since the admin rule of the same day, in any chat).
register("yesimbot-xiaoheihe", ["xiaoheihe"], "read");
register("yesimbot-xiaoheihe", ["xiaoheihe_publish"], "service", true);

// Each kind of background task gets the tools of its own work, not every read tool of the conversation (user,
// 2026-11-19: 「按任务类型给工具」, after workers were seen with stickers, Xiaoheihe and memory tools they never needed).
// Reading other conversations, mail and communities is material for content and service tasks; rendering and image
// generation are content work; chat itself (stickers, long-term memory) stays with the main conversation.
onlyFor("core", ["list_conversations", "read_conversation"], ["content", "service"]);
onlyFor("yesimbot-console", ["list_conversations", "read_conversation"], ["content", "service"]);
onlyFor("yesimbot-search-service", ["import_image_reference"], ["content"]);
onlyFor("yesimbot-workspace", ["render_html"], ["content"]);
onlyFor("yesimbot-image-tools", ["generate_image", "edit_image"], ["content"]);
onlyFor("yesimbot-google", ["gmail", "google_calendar", "google_drive"], ["content", "service"]);
onlyFor("yesimbot-schedule", ["schedule_list"], ["service"]);
onlyFor("yesimbot-xiaoheihe", ["xiaoheihe"], ["content", "service"]);
onlyFor("yesimbot-onebot-utils", ["onebot_get_forward_message", "onebot_ocr_image"], ["content"]);
onlyFor("yesimbot-instance-management", ["instance_memory_read"], ["service"]);
onlyFor("yesimbot-sticker-manager", ["sticker_preview", "sticker_search", "sticker_steal", "sticker_manage"], []);
onlyFor("yesimbot-memorizer", ["recall", "query_memories", "read_evidence", "remember"], []);
onlyFor("adapter-wechat-bridge", ["wechat_group_members"], []);
onlyFor("yesimbot-roleplay", ["update_role_card"], []);

/** Every built-in tool declaration (fresh copies): the one table of which tool runs where. */
export function builtinToolDeclarations(currentPlatform?: string): { pluginId: string; name: string; capability: ToolCapability }[] {
  return [...registry.keys()].map((key) => {
    const [pluginId, name] = key.split("\0") as [string, string];
    return { pluginId, name, capability: builtinToolCapability(pluginId, name, currentPlatform)! };
  });
}

/** A fresh declaration prevents callers from mutating another runtime's built-in metadata. */
export function builtinToolCapability(pluginId: string, name: string, currentPlatform?: string): ToolCapability | undefined {
  const declared = registry.get(`${pluginId}\0${name}`);
  if (!declared) return;
  return {
    ...declared,
    platforms: pluginId === "core" && currentPlatform ? [currentPlatform] : [...declared.platforms],
    ...(declared.contexts ? { contexts: [...declared.contexts] } : {}),
    ...(declared.workers ? { workers: [...declared.workers] } : {}),
  };
}

/** Device transport names remain separate from model-facing tool names and local consent. */
export function deviceToolCapability(capability: string, method: string, currentPlatform: string): ToolCapability | undefined {
  if (capability === "workspace.files" && ["read", "write", "list", "mkdir"].includes(method))
    return { platforms: [currentPlatform], sensitive: true, executionKind: ["read", "list"].includes(method) ? "read" : "content" };
  if (capability.startsWith("computer.")) return { platforms: [currentPlatform], sensitive: true, executionKind: "computer" };
}
