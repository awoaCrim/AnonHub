import type { AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { WEB_CHAT } from "@yesimbot/contracts/platforms";
import { z } from "zod/v4";

export const WEB_REACTION_TOOL = "web_create_reaction";

const WEB_REACTION_SCHEMA = z.strictObject({
  messageId: z.string().min(1).max(128).describe("对方消息的 id"),
  emoji: z.string().min(1).max(32).describe("一个表情"),
});

export interface WebReactionOptions {
  /** Whether this message ID is one the user sent in this conversation. */
  isUserMessage: (messageId: string) => Promise<boolean>;
  /** Shows the reaction next to that message (replacing an earlier one). */
  react: (messageId: string, emoji: string) => Promise<void>;
}

/** One emoji, as the web chat shows it next to a message: a single grapheme that is a pictograph or a flag. */
export function reactionEmoji(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 32) return undefined;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  if (graphemes.length !== 1) return undefined;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/u.test(text) ? text : undefined;
}

/**
 * The web chat's emoji reaction (user, 2026-11-18). Like `onebot_create_reaction` on QQ: a light response that can
 * replace a content-free acknowledgement. One reaction per message; a new one replaces the old.
 */
export function webReactionPlugin(options: WebReactionOptions): AgentPlugin {
  const tool: AgentTool<z.infer<typeof WEB_REACTION_SCHEMA>> = {
    name: WEB_REACTION_TOOL,
    description:
      "给对方在本网页对话里发来的某条消息贴一个表情（显示在那条消息旁）。对方的话值得回应、但用不着说一句话时（认同、好笑、感谢、收到），就贴一个表情轻轻表态，可以代替没有信息量的文字确认；需要回答的照常回复，不必每条都贴。messageId 用消息头里的 id，emoji 是一个 Unicode 表情，如 👍、😂、❤️、🙏、👀；同一条再贴会替换之前的。",
    inputSchema: WEB_REACTION_SCHEMA,
    execute: async ({ messageId, emoji }) => {
      const shown = reactionEmoji(emoji);
      if (!shown) return { ok: false, error: { name: "InvalidEmoji", message: "emoji 必须是一个表情" } };
      if (typeof messageId !== "string" || !(await options.isUserMessage(messageId)))
        return { ok: false, error: { name: "MessageNotFound", message: "这个对话里没有对方发的这条消息" } };
      await options.react(messageId, shown);
      return { ok: true, messageId, emoji: shown };
    },
  };
  return { name: "web-reaction", tools: [tool as unknown as AgentTool] };
}

/** The user's own messages in a web conversation are those not sent by the web bot. */
export const sentByUser = (record: { user?: { id?: string } }) => record.user?.id !== WEB_CHAT.selfId;
