import { defineErrors } from "@yesimbot/foundation";

export const ONEBOT_ERRORS = defineErrors({
  onebot_action_unavailable: { model: "这个 QQ 账号不支持这个操作。", user: "这个 QQ 账号不支持这个操作。", status: 501 },
  onebot_request_failed: {
    model: "QQ 没有完成这个操作，可能已经部分生效；群管理操作常见原因是自己不是本群管理员或对象不在群里。",
    user: "QQ 没有完成这个操作。",
    status: 502,
  },
  onebot_user_id_invalid: { model: "用户 ID 不是有效的 QQ 号。", user: "用户 ID 不是有效的 QQ 号。", status: 400 },
  onebot_reaction_face_unsupported: { model: "这个表情 ID 不在可用列表里，只能用工具说明里列出的表情。", user: "不支持这个表情。", status: 400 },
  onebot_forward_not_found: { model: "没有找到这条合并转发消息。", user: "没有找到这条合并转发消息。", status: 404 },
  onebot_forward_image_invalid: { model: "转发里的图片下载失败。", user: "转发里的图片下载失败。", status: 502 },
  onebot_moderation_no_sender: {
    model: "群管理只执行群主或管理员在本轮提出的要求；本轮没有可核实的发送者。",
    user: "群管理只执行群主或管理员的要求。",
    status: 403,
  },
  onebot_moderation_check_failed: { model: "无法核实发送者的群身份，没有执行群管理操作。", user: "无法核实发送者的群身份。", status: 502 },
  onebot_moderation_not_admin: {
    model: "本轮有发送者不是本群群主或管理员，不能要求群管理操作。",
    user: "只有群主或管理员能要求群管理操作。",
    status: 403,
  },
});
