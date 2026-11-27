import { type AgentPlugin, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { displayChannelId, ONEBOT_ACTIONS, oneBotActionName, type OneBotAction } from "@yesimbot/contracts/platforms";
import { AppError, errorFields, httpFetch, logger, toToolResult, type ToolFailure } from "@yesimbot/foundation";
import type { CoreService } from "koishi-plugin-yesimbot/kernel";
import { createToolPolicyHooks, extractToolAccessActorIds, guardToolPolicy } from "koishi-plugin-yesimbot/kernel";
import type { ChannelPluginSetupContext, ChannelResources, ChannelContext, ChatAccount, ToolDescriptor } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { projectAnimatedImages } from "./animated-image.js";
import type { Config } from "./config.js";
import { ONEBOT_ERRORS } from "./errors.js";
import { createForwardReader, FORWARD_TOOL_SCHEMA, type ForwardImageRequest, type ForwardResult } from "./forward.js";
import type { OneBotCalls, OneBotCQCode, OneBotForwardSendNode, OneBotSenderInfo } from "./onebot.js";

/**
 * Faces it may react with (QQ 表情回应). IDs and names are QQ's own face table (`face_config.json` sysface, the same
 * table NapCat's WebUI ships), as installed with the deployed NapCat: static, visible system faces only, no animated
 * stickers (比心, 庆祝, 打call) or hidden ones (爱你, 求求). NapCat sends IDs of up to three digits as QQ faces.
 */
export const REACTION_FACES = [
  { id: "76", name: "赞" },
  { id: "66", name: "爱心" },
  { id: "124", name: "OK" },
  { id: "13", name: "呲牙" },
  { id: "182", name: "笑哭" },
  { id: "271", name: "吃瓜" },
  { id: "118", name: "抱拳" },
  { id: "63", name: "玫瑰" },
  { id: "99", name: "鼓掌" },
  { id: "32", name: "疑问" },
  { id: "264", name: "捂脸" },
  { id: "179", name: "doge" },
  { id: "269", name: "暗中观察" },
  { id: "30", name: "奋斗" },
  { id: "106", name: "委屈" },
  { id: "282", name: "敬礼" },
] as const;

export const TOOLS = {
  GET_FORWARD_MESSAGE: "onebot_get_forward_message",
  SEND_FORWARD_MESSAGE: "onebot_send_forward_message",
  CREATE_REACTION: "onebot_create_reaction",
  SET_ESSENCE: "onebot_set_essence",
  GROUP_ADMIN: "onebot_group_admin",
  OCR_IMAGE: "onebot_ocr_image",
  SET_QQ_PROFILE: "onebot_set_qq_profile",
};

export const GROUP_TOOLS = [TOOLS.SET_ESSENCE, TOOLS.GROUP_ADMIN];

const MAX_FORWARD_IMAGE_BYTES = 5 * 1024 * 1024;

const FORWARD_IMAGE_TIMEOUT_MS = 10_000;

const MAX_FORWARD_IMAGES_PER_PERSIST_BATCH = 4;

const REACTION_MENU = REACTION_FACES.map(({ id, name }) => `${id} ${name}`).join("、");

const MODERATION_TOOLS = [TOOLS.GROUP_ADMIN];

const MODERATION_ROLES = new Set(["owner", "admin"]);

const log = logger("yesimbot.onebot-utils");

const SEND_FORWARD_SCHEMA = z.strictObject({ forwardId: z.string().describe("要原样发送的合并转发消息 ID") });

const CREATE_REACTION_SCHEMA = z.strictObject({
  messageId: z.string().describe("要表态的消息 ID"),
  emojiId: z.literal(REACTION_FACES.map(({ id }) => id)).describe(`表情 ID：${REACTION_MENU}`),
});

const SET_ESSENCE_SCHEMA = z.strictObject({ messageId: z.string().describe("要设置为精华的消息 ID") });

const OCR_IMAGE_SCHEMA = z.object({ image: z.string() });

const SET_QQ_PROFILE_SCHEMA = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("profile"), nickname: z.string().optional(), personal_note: z.string().optional(), sex: z.number().optional() }),
  z.strictObject({ action: z.literal("avatar"), file: z.string() }),
]);

const GROUP_ADMIN_SCHEMA = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("ban"), userId: z.string(), duration: z.number().min(0) }),
  z.strictObject({ action: z.literal("unban"), userId: z.string() }),
  z.strictObject({ action: z.literal("kick"), userId: z.string(), rejectAddRequest: z.boolean().optional() }),
]);

/** What the plugin needs from Core's service: conversation identity and channel resources. */
export type OnebotUtilsHost = Pick<CoreService, "identity" | "resource">;

type GroupToolResult = { success: true } | (ToolFailure & { userId?: string });

type GroupAdminInput = z.infer<typeof GROUP_ADMIN_SCHEMA>;

type SetQqProfileInput = z.infer<typeof SET_QQ_PROFILE_SCHEMA>;

type ForwardSendResult = { ok: true; messageId: string } | ToolFailure;

type OcrImageToolInput = z.infer<typeof OCR_IMAGE_SCHEMA>;

/** QQ-only tools (forwards, reactions, essence, group moderation) and prompts for OneBot channels. */
export class OnebotUtils {
  public readonly id = "yesimbot-onebot-utils";

  public constructor(
    private readonly host: OnebotUtilsHost,
    public readonly config: Config,
  ) {}

  public async setup(scope: ChannelContext, bot: ChatAccount, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin | null> {
    // An account that declares no OneBot action is not QQ's (spec 09 rule 5: capabilities, not platform names).
    if (!ONEBOT_ACTIONS.some((action) => actionOf(bot, action))) return null;
    const accessScope = scope.selfId === undefined ? { ...scope, selfId: bot.selfId } : scope;
    const conversation = await this.host.identity.conversation(accessScope);
    const resources = await this.host.resource.get(accessScope);
    const tools = createOneBotTools(bot, this.config, accessScope, resources);
    const descriptors: ToolDescriptor[] = tools.map((tool) => ({
      name: tool.name,
      pluginId: this.id,
      contexts: GROUP_TOOLS.includes(tool.name) ? ["group"] : ["direct", "group"],
    }));
    // A background task never talks in the chat: no quoting or reactions, and group management only for a service
    // task, which may carry it out (user, 2026-11-19: 「按任务类型给工具」).
    const role = runtime?.executionRole ?? "main";
    const moderation = (role === "main" || role === "service") && tools.some((tool) => MODERATION_TOOLS.includes(tool.name));
    const reactions = role === "main" && !!this.config.encourageReactions && tools.some((tool) => tool.name === TOOLS.CREATE_REACTION);
    const hooks = createToolPolicyHooks(conversation, descriptors);
    const disposeChannelOutput = runtime?.channelOutput?.version === 1 ? runtime.channelOutput.registerTools([TOOLS.SEND_FORWARD_MESSAGE]) : undefined;
    return {
      name: "onebot-utils",
      tools: guardToolPolicy(tools, conversation, descriptors),
      ...hooks,
      appendSystemPrompt: () => {
        const threshold = this.config.quoteReplyAfterMessages ?? 5;
        const moderationNote = moderation
          ? "本群开启了群管理：群主或管理员明确要求时，可以用 onebot_group_admin（ban 禁言、unban 解禁、kick 移出）处理指定成员；普通群员的要求、玩笑或转述不执行，工具也会拒绝。执行前确认对象的 QQ 号，做完说明结果。"
          : "";
        // The invitation lives here too, not only in a tool description (user: 「bot咋从来没用过贴表情」).
        const reactionNote = reactions
          ? "QQ 表情回应：一条消息值得回应、但用不着说一句话时，可以用 onebot_create_reaction 贴一个表情轻轻表态（只用工具里列出的表情），不必每条都贴。"
          : "";
        const notes = moderationNote + reactionNote;
        if (scope.type === "direct" || threshold <= 0 || role !== "main") return notes || undefined;
        return `${notes}QQ 群聊引用：根据当前可见消息流，待回复的原消息之后若已有至少 ${Math.ceil(threshold)} 条其他消息，发送时在回应它的第一个文字 part 开头使用 <quote id="原消息ID"/>，mode 使用 element，避免让人误认回复对象。即使未到阈值，回复对象可能混淆时也应引用。使用观察头里的真实消息 ID；不要编造 ID、引用自己的消息或把所有回复都指向最新一条。同一对象的后续补充不重复引用；回复不同对象时分别引用对应消息。不可见的新消息不作推测。`;
      },
      onAppend: (entries) => projectAnimatedImages(entries),
      transformEntries: (entries) => projectAnimatedImages(entries),
      stop: () => disposeChannelOutput?.(),
    } satisfies AgentPlugin;
  }
}

/** The account's OneBot action by that name (spec 09 rule 6), when it declares one. */
function actionOf(bot: ChatAccount, action: OneBotAction) {
  return bot.actions?.[oneBotActionName(action)];
}

/** One OneBot action's `data`. Whatever QQ refuses or leaves unanswered becomes `onebot_request_failed`, its text kept for the log only. */
async function requestOneBot(bot: ChatAccount, action: OneBotAction, params: Record<string, unknown>): Promise<unknown> {
  const run = actionOf(bot, action);
  if (!run) throw new AppError(ONEBOT_ERRORS.onebot_action_unavailable, { effect: "none", detail: action });
  try {
    return await run(params);
  } catch (cause) {
    throw new AppError(ONEBOT_ERRORS.onebot_request_failed, { effect: "unknown", detail: action, cause });
  }
}

/** The forward calls, over the account's actions. */
function oneBotCalls(bot: ChatAccount): OneBotCalls {
  return {
    getForwardMsg: async (forwardId) => ((await requestOneBot(bot, "get_forward_msg", { message_id: forwardId })) as { messages?: unknown } | null)?.messages,
    getImage: async (file) => (await requestOneBot(bot, "get_image", { file })) as { readonly url?: string } | undefined,
  };
}

async function loadForwardSendNodes(internal: OneBotCalls, forwardId: string): Promise<readonly OneBotForwardSendNode[] | undefined> {
  const response = await internal.getForwardMsg(forwardId);
  if (!Array.isArray(response)) return undefined;
  const nodes = response as unknown as readonly { readonly sender: OneBotSenderInfo; readonly time: number; readonly message: readonly OneBotCQCode[] }[];
  return Promise.all(
    nodes.map(async (node) => ({
      type: "node" as const,
      data: {
        name: node.sender.card || node.sender.nickname || String(node.sender.user_id),
        uin: String(node.sender.user_id),
        content: await resolveForwardSendContent(internal, node.message),
        time: String(node.time),
      },
    })),
  );
}

async function resolveForwardSendContent(internal: OneBotCalls, segments: readonly OneBotCQCode[]): Promise<readonly OneBotCQCode[]> {
  return Promise.all(
    segments.map(async (segment) => {
      if (segment.type !== "image") return { ...segment, data: { ...segment.data } };
      const data = { ...segment.data };
      const source = data.src ?? data.url ?? data.file;
      if (source) {
        data.file = source;
      } else {
        try {
          const resolved = await internal.getImage(typeof data.file === "string" ? data.file : "");
          if (resolved?.url) data.file = resolved.url;
        } catch (cause) {
          // Keep the original file reference when the adapter cannot resolve it.
          log.debug("onebot.forward_image_unresolved", { ...errorFields(cause) });
        }
      }
      delete data.src;
      delete data.url;
      delete data.summary;
      delete data.sub_type;
      delete data.subType;
      delete data.file_size;
      return { ...segment, data };
    }),
  );
}

async function persistForwardImages(
  internal: OneBotCalls,
  resources: ChannelResources,
  images: readonly ForwardImageRequest[],
): Promise<ReadonlyMap<string, string>> {
  const resolved = await Promise.all(
    images.map(async ({ file, url }) => {
      try {
        const imageUrl = url ?? (await internal.getImage(file))?.url;
        return imageUrl ? { file, url: imageUrl } : undefined;
      } catch (cause) {
        log.debug("onebot.forward_image_unresolved", { ...errorFields(cause) });
        return undefined;
      }
    }),
  );
  const assetIds = new Map<string, string>();
  for (let offset = 0; offset < resolved.length; offset += MAX_FORWARD_IMAGES_PER_PERSIST_BATCH) {
    const batch = resolved.slice(offset, offset + MAX_FORWARD_IMAGES_PER_PERSIST_BATCH);
    await Promise.all(
      batch.map(async (item) => {
        if (!item) return;
        try {
          assetIds.set(item.file, await resources.assets.put(await downloadForwardImage(item.url)));
        } catch (cause) {
          // The image stays a plain [图片] placeholder.
          log.debug("onebot.forward_image_failed", { ...errorFields(cause) });
        }
      }),
    );
  }
  return assetIds;
}

/** A forward's picture from QQ's own media servers, known public services (convention 05). */
async function downloadForwardImage(url: string): Promise<Uint8Array> {
  const response = await httpFetch(url, { purpose: "public", timeoutMs: FORWARD_IMAGE_TIMEOUT_MS, maxBytes: MAX_FORWARD_IMAGE_BYTES });
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || (type && !type.startsWith("image/") && type !== "application/octet-stream")) {
    await response.cancel();
    throw new AppError(ONEBOT_ERRORS.onebot_forward_image_invalid, { effect: "none", detail: `status ${response.status}, type ${type ?? "none"}` });
  }
  return response.bytes();
}

/** @internal Native construction; apply guardToolPolicy before publishing these tools. */
function createOneBotTools(bot: ChatAccount, config: Readonly<Config>, scope: ChannelContext, resources: ChannelResources): AgentTool[] {
  let forwardReader: ReturnType<typeof createForwardReader> | undefined;

  const isGroupScope = scope.type !== "direct";

  const getForwardMessageTool: AgentTool<z.infer<typeof FORWARD_TOOL_SCHEMA>, ForwardResult> = {
    name: TOOLS.GET_FORWARD_MESSAGE,
    description: "分页获取合并转发消息的紧凑元组。使用 forwardId；若返回 tips，表示还有剩余内容，可按其中的 nextOffset 使用相同 forwardId 继续读取。",
    inputSchema: FORWARD_TOOL_SCHEMA,
    execute: async (input) => {
      const calls = oneBotCalls(bot);
      forwardReader ??= createForwardReader(calls, { ...config, persistImages: (images) => persistForwardImages(calls, resources, images) });
      return forwardReader(input);
    },
  };

  const sendForwardMessageTool: AgentTool<{ forwardId: string }, ForwardSendResult> = {
    name: TOOLS.SEND_FORWARD_MESSAGE,
    description: "将合并转发消息原样发送到当前频道。传入与 onebot_get_forward_message 相同的 forwardId；不要根据摘要逐条粘贴或重建消息。",
    inputSchema: SEND_FORWARD_SCHEMA,
    execute: async ({ forwardId }) => {
      try {
        const nodes = await loadForwardSendNodes(oneBotCalls(bot), forwardId);
        if (!nodes) return toToolResult(new AppError(ONEBOT_ERRORS.onebot_forward_not_found, { effect: "none", detail: forwardId }));
        const target = displayChannelId(scope.platform, scope.channelId);
        const sent = (await (scope.type === "direct"
          ? requestOneBot(bot, "send_private_forward_msg", { user_id: target, messages: nodes })
          : requestOneBot(bot, "send_group_forward_msg", { group_id: target, messages: nodes }))) as { message_id?: unknown } | null;
        return { ok: true, messageId: String(sent?.message_id) };
      } catch (cause) {
        return failed(TOOLS.SEND_FORWARD_MESSAGE, cause);
      }
    },
  };

  const createReactionTool: AgentTool<{ messageId: string; emojiId: string }, { success: true }> = {
    name: TOOLS.CREATE_REACTION,
    // The model gets the faces by name; asked to use "known valid IDs" with none listed, it never reacted at all.
    description: config.encourageReactions
      ? `给收到的 QQ 消息贴表情（表情回应）。鼓励按消息语境使用：一条消息值得回应、但用不着说一句话时（认同、好笑、感谢、收到、围观），贴一个表情轻轻表态，可以代替没有信息量的文字确认；需要回答的照常回复，不必每条都贴，同一条消息只贴一次。messageId 使用观察头中的真实消息 ID；emojiId 只能从这些里选：${REACTION_MENU}。工具失败不表示贴成功。`
      : `给 QQ 消息贴表情（表情回应）。messageId 使用真实消息 ID；emojiId 只能从这些里选：${REACTION_MENU}。`,

    inputSchema: CREATE_REACTION_SCHEMA,
    execute: async ({ messageId, emojiId }) => {
      // Checked here as well: a model may ignore the enum, and any other ID would reach QQ as an unknown face or an emoji.
      const face = REACTION_FACES.find(({ id }) => id === String(emojiId ?? "").trim());
      if (!face) throw new AppError(ONEBOT_ERRORS.onebot_reaction_face_unsupported, { effect: "none", detail: String(emojiId ?? "").slice(0, 16) });
      await requestOneBot(bot, "set_msg_emoji_like", { message_id: messageId, emoji_id: face.id });
      return { success: true };
    },
  };

  const setEssenceTool: AgentTool<{ messageId: string }, { success: true }> = {
    name: TOOLS.SET_ESSENCE,
    description: "将消息设置为精华",
    inputSchema: SET_ESSENCE_SCHEMA,
    execute: async ({ messageId }) => {
      await requestOneBot(bot, "set_essence_msg", { message_id: messageId });
      return { success: true };
    },
  };

  const ocrImageTool: AgentTool<OcrImageToolInput, unknown> = {
    name: TOOLS.OCR_IMAGE,
    description: "对图片进行 OCR 识别",
    inputSchema: OCR_IMAGE_SCHEMA,
    // QQ's recognition result as NapCat gives it.
    execute: async (input) => requestOneBot(bot, "ocr_image", { ...input }),
  };

  const setQqProfileTool: AgentTool<SetQqProfileInput, { success: true }> = {
    name: TOOLS.SET_QQ_PROFILE,
    description: "设置机器人自己的 QQ 资料。action=profile 修改个人资料，可选 nickname、personal_note、sex；action=avatar 设置头像，需要 file。",
    inputSchema: SET_QQ_PROFILE_SCHEMA,
    execute: async ({ action, ...params }) => {
      await requestOneBot(bot, action === "profile" ? "set_qq_profile" : "set_qq_avatar", params);
      return { success: true };
    },
  };

  const groupAdminTool: AgentTool<GroupAdminInput, GroupToolResult> = {
    name: TOOLS.GROUP_ADMIN,
    description:
      "管理当前群的成员。action=ban 禁言指定成员，需要 userId 和 duration（单位秒）；action=unban 解除禁言，需要 userId；action=kick 将成员移出本群，需要 userId，可选 rejectAddRequest（不再接受其入群申请）。",
    inputSchema: GROUP_ADMIN_SCHEMA,
    execute: async (input) => {
      try {
        const base = { group_id: Number(scope.channelId), user_id: toOneBotUserId(input.userId) };
        if (input.action === "kick") await requestOneBot(bot, "set_group_kick", { ...base, reject_add_request: input.rejectAddRequest ?? false });
        else await requestOneBot(bot, "set_group_ban", { ...base, duration: input.action === "ban" ? Math.floor(input.duration) : 0 });
        return { success: true };
      } catch (cause) {
        return failed(TOOLS.GROUP_ADMIN, cause);
      }
    },
  };

  // A tool is offered where the account declares the actions it calls; old per-chat matrices are inert.
  const has = (...actions: OneBotAction[]) => actions.every((action) => actionOf(bot, action));
  const tools: AgentTool[] = [];
  // Group moderation is opt-in per group, and runs only for the group's owner or admins (user, 2026-11-18).
  const moderated = isGroupScope && has("get_group_member_info") && (config.moderationGroups ?? []).some((group) => String(group).trim() === scope.channelId);
  if (isGroupScope) {
    if (has("set_essence_msg")) tools.push(setEssenceTool);
    if (moderated && (has("set_group_ban") || has("set_group_kick"))) tools.push(moderatorOnly(bot, scope, groupAdminTool));
  }
  if (has("get_forward_msg")) tools.push(getForwardMessageTool);
  if (has("get_forward_msg", isGroupScope ? "send_group_forward_msg" : "send_private_forward_msg")) tools.push(sendForwardMessageTool);
  if (has("set_msg_emoji_like")) tools.push(createReactionTool);
  if (has("ocr_image")) tools.push(ocrImageTool);
  if (has("set_qq_profile") || has("set_qq_avatar")) tools.push(setQqProfileTool);
  return tools;
}

/**
 * Every sender of the current turn must be the group's owner or an admin, checked live with QQ. A turn with no
 * sender (a schedule or heartbeat) or with an ordinary member's message among its inputs does not qualify.
 */
function moderatorOnly(bot: ChatAccount, scope: ChannelContext, tool: AgentTool): AgentTool {
  const execute = tool.execute;
  return {
    ...tool,
    description: `${tool.description}。仅在本群的群主或管理员本轮明确要求时使用；本轮有普通群员的消息时会被拒绝。`,
    execute: async (input: unknown, execution: AgentToolExecuteContext) => {
      const actors = extractToolAccessActorIds(execution?.messages ?? []);
      if (!actors.length) return toToolResult(new AppError(ONEBOT_ERRORS.onebot_moderation_no_sender, { effect: "none" }));
      for (const userId of actors) {
        let role: unknown;
        try {
          const info = (await requestOneBot(bot, "get_group_member_info", {
            group_id: Number(scope.channelId),
            user_id: toOneBotUserId(userId),
            no_cache: true,
          })) as { role?: unknown; data?: { role?: unknown } } | undefined;
          role = info?.role ?? info?.data?.role;
        } catch (cause) {
          log.warn("onebot.moderator_check_failed", { tool: tool.name, userId, ...errorFields(cause) });
          return { ...toToolResult(new AppError(ONEBOT_ERRORS.onebot_moderation_check_failed, { effect: "none", cause })), userId };
        }
        if (typeof role !== "string" || !MODERATION_ROLES.has(role))
          return { ...toToolResult(new AppError(ONEBOT_ERRORS.onebot_moderation_not_admin, { effect: "none" })), userId };
      }
      return execute(input, execution);
    },
  } as AgentTool;
}

function toOneBotUserId(userId: string): number {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(ONEBOT_ERRORS.onebot_user_id_invalid, { effect: "none", detail: String(userId).slice(0, 32) });
  return id;
}

/** A tool's failure result: the registered sentence for the model, the cause chain for the log. */
function failed(tool: string, cause: unknown): ToolFailure {
  log.warn("onebot.tool_failed", { tool, ...errorFields(cause) });
  return toToolResult(cause);
}

export { createOneBotTools };
