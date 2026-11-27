import type { AgentTool } from "@yesimbot/agent-runtime";
import { roleCardPictureType, type RoleCardPicture } from "@yesimbot/character-cards";
import { ROLE_CARD_NAME_MAX, ROLE_CARD_TEXT_KEYS, ROLE_CARD_TEXT_MAX, type RoleCardPictureKey, type RoleCardText } from "@yesimbot/contracts/role-cards";
import { AppError, toToolResult, type ToolFailure } from "@yesimbot/foundation";
import type { ChannelResources } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { ROLE_CARD_ERRORS } from "./errors.js";

/**
 * The bot edits its own card (user, 2026-11-24: 「bot也可以修改自己的角色卡」): every box and both pictures. Declared
 * sensitive and direct-only in the capability table, so it runs only in the owner's private chat (the logged-in web
 * chat, or an admin's private chat).
 */
export const UPDATE_ROLE_CARD = "update_role_card";

const line = (description: string) => z.string().max(ROLE_CARD_NAME_MAX).describe(description).optional();

const text = (description: string) => z.string().max(ROLE_CARD_TEXT_MAX).describe(description).optional();

const picture = (description: string) => z.string().max(4096).nullable().describe(description).optional();

const UPDATE_ROLE_CARD_SCHEMA = z
  .strictObject({
    name: line("角色卡名字"),
    nickname: line("你称呼自己的名字；空字符串就用角色卡名字"),
    identity: text("身份：你是谁、多大、做什么"),
    looks: text("外貌"),
    personality: text("性格"),
    speech: text("说话方式：语气、口头禅、怎么称呼别人"),
    history: text("经历"),
    relationships: text("关系：你和主人、和其他人的关系"),
    rules: text("规矩：一定要做或一定不做的事"),
    examples: text("示例对话：几段你说话的样子"),
    reminder: text("回复前提醒：每次回复前都要遵守的简短要求"),
    reference: picture("形象参考图（也是你的头像）的图片地址；null 删除"),
    turnaround: picture("三视图（正面、侧面、背面）的图片地址；null 删除"),
  })
  .refine((input) => Object.keys(input).length >= 1, { message: "至少改一项" });

export type UpdateRoleCardResult = { readonly ok: true; readonly changed: readonly string[]; readonly note: string } | ToolFailure;

export type RoleCardErrorCode = (typeof ROLE_CARD_ERRORS)[keyof typeof ROLE_CARD_ERRORS];

type UpdateRoleCardInput = z.infer<typeof UPDATE_ROLE_CARD_SCHEMA>;

export interface OwnCardUpdate {
  readonly text: Partial<RoleCardText>;
  /** A new picture, `null` to remove it, absent to keep it. */
  readonly pictures: Partial<Record<RoleCardPictureKey, RoleCardPicture | null>>;
}

/** A refusal before anything was written. */
export function updateRoleCardFailure(code: RoleCardErrorCode, cause?: unknown): UpdateRoleCardResult {
  return toToolResult(new AppError(code, { effect: "none", cause }));
}

export function createUpdateRoleCardTool(options: {
  readonly resources: Pick<ChannelResources, "openStrict">;
  readonly update: (change: OwnCardUpdate) => Promise<UpdateRoleCardResult>;
}): AgentTool<UpdateRoleCardInput, UpdateRoleCardResult> {
  return {
    name: UPDATE_ROLE_CARD,
    description:
      "改你自己的角色卡：设定、示例对话、回复前提醒和两张图。只在主人明确要你改时用，不要自己决定改。只给要改的项，没给的保持不变；空字符串就是清空那一项。" +
      "图片写图片地址（对话里的 asset://、你生成的 artifact://），写 null 删掉。改完从下一条消息起生效。",
    inputSchema: UPDATE_ROLE_CARD_SCHEMA,
    execute: async (input, execution) => {
      const text: Partial<RoleCardText> = {};
      for (const key of ROLE_CARD_TEXT_KEYS) if (input[key] !== undefined) text[key] = input[key];
      const pictures: OwnCardUpdate["pictures"] = {};
      for (const key of ["reference", "turnaround"] as const) {
        const uri = input[key];
        if (uri === null) pictures[key] = null;
        else if (typeof uri === "string") {
          let bytes: Uint8Array;
          try {
            bytes = (await options.resources.openStrict(uri.trim(), execution.abortSignal)).bytes;
          } catch (cause) {
            return updateRoleCardFailure(ROLE_CARD_ERRORS.role_card_picture_unavailable, cause);
          }
          const mediaType = roleCardPictureType(bytes);
          if (!mediaType) return updateRoleCardFailure(ROLE_CARD_ERRORS.role_card_picture_unsupported);
          pictures[key] = { bytes, mediaType };
        }
      }
      return options.update({ text, pictures });
    },
  };
}
