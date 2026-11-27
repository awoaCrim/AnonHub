import { defineErrors } from "@yesimbot/foundation";

/** Main-Agent setup and reply delivery that cannot go on. */
export const AGENT_ERRORS = defineErrors({
  agent_role_conflict: { model: "有多个角色插件同时给出了这个会话的角色设定。", user: "有多个角色插件同时给出了这个会话的角色设定。", status: 500 },
  reply_invariant_broken: { model: "回复内容在投递前不一致。", user: "回复内容在投递前不一致。", status: 500 },
  image_preview_cancelled: { model: "看图已取消或超时。", user: "看图已取消或超时。", status: 504 },
});
