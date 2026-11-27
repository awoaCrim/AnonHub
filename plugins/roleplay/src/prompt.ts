import { ROLE_SETTINGS, type RoleCardText } from "@yesimbot/contracts/role-cards";
import type { MainAgentRoleProfile } from "koishi-plugin-yesimbot/kernel";

/**
 * The card as Core places it: 角色设定 box by box in the leading role section, then 示例对话; 回复前提醒 after the
 * history on every step. Empty boxes are left out.
 */
export function assembleRoleProfile(card: RoleCardText): MainAgentRoleProfile {
  const name = card.name.trim();
  const nickname = card.nickname.trim();
  const definition = [
    [name ? `名字：${name}` : "", nickname && nickname !== name ? `自称：${nickname}` : ""].filter(Boolean).join("\n"),
    ...ROLE_SETTINGS.map(({ key, label }) => (card[key].trim() ? `## ${label}\n${card[key].trim()}` : "")),
  ]
    .filter(Boolean)
    .join("\n\n");
  const examples = card.examples.trim();
  const reminder = card.reminder.trim();
  return {
    ...(definition ? { characterDefinition: definition } : {}),
    ...(examples ? { roleInstructions: `<example_dialogues>\n以下是说话方式的示例，不是这段对话里发生过的事。\n${examples}\n</example_dialogues>` } : {}),
    ...(reminder ? { postHistoryInstructions: reminder } : {}),
  };
}
