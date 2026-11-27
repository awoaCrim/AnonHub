import { defineErrors } from "@yesimbot/foundation";

/** Input or posts the messenger refuses before any conversation runs. */
export const MESSENGER_ERRORS = defineErrors({
  messenger_closed: { model: "消息服务正在关闭，这条消息没有处理。", user: "服务正在重启，稍后再发。", status: 503, retryable: true },
  messenger_account_unavailable: { model: "这个账号现在不在线，消息发不出去。", user: "这个账号现在不在线。", status: 503, retryable: true },
  messenger_assignee_denied: { model: "这个群分配给了别的账号，本账号不处理。", user: "这个群分配给了别的账号。", status: 403 },
  web_chat_target_denied: { model: "网页对话只能发到主人自己的网页会话。", user: "网页对话只能发到主人自己的网页会话。", status: 403 },
  whisper_target_denied: { model: "悄悄话只能发到 QQ、微信等聊天里，不能发到网页对话。", user: "悄悄话不能发到网页对话。", status: 403 },
  whisper_empty: { model: "悄悄话是空的。", user: "悄悄话是空的。", status: 400 },
});
