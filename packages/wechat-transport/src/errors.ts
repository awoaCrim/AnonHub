import { defineErrors } from "@yesimbot/foundation";

/** The client's own refusals. A daemon refusal stays an `AgentWechatError` with the daemon's code. */
export const AGENT_WECHAT_ERRORS = defineErrors({
  agent_wechat_endpoint_invalid: { model: "微信服务的地址配置不对。", user: "微信服务的地址配置不对。", status: 500 },
  agent_wechat_endpoint_not_loopback: {
    model: "微信服务的地址只能是本机（127.0.0.1），否则令牌会明文发出去。",
    user: "微信服务的地址只能是本机。",
    status: 500,
  },
  agent_wechat_token_file_invalid: { model: "微信服务的令牌文件读不出有效令牌。", user: "微信服务的令牌文件无效。", status: 500 },
  agent_wechat_path_segment_invalid: { model: "微信账号、会话或消息的 ID 格式不对。", user: "微信 ID 格式不对。", status: 400 },
  agent_wechat_cursor_invalid: { model: "微信事件游标格式不对。", user: "微信事件游标格式不对。", status: 400 },
  agent_wechat_idempotency_key_invalid: { model: "发送去重键格式不对。", user: "发送去重键格式不对。", status: 400 },
});
