import { defineErrors } from "@yesimbot/foundation";

/** Refusals of the tool boundary: a tool this conversation may not use, or a sensitive one asked for by a non-admin. */
export const TOOL_ERRORS = defineErrors({
  tool_capability_denied: { model: "这个工具在当前会话不可用。", user: "这个工具在当前会话不可用。", status: 403 },
  tool_admin_only: { model: "这是敏感操作，只有管理员能让你执行。", user: "只有管理员能让机器人做这件事。", status: 403 },
});
