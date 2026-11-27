import { defineErrors } from "@yesimbot/foundation";

export const WECHAT_ERRORS = defineErrors({
  wechat_target_not_allowed: { model: "这个微信会话不在允许范围内，不能发送或查看。", user: "这个微信会话不在允许范围内。", status: 403 },
  wechat_not_logged_in: { model: "微信没有登录，暂时无法操作。", user: "微信没有登录。", status: 503, retryable: true },
  wechat_empty_message: { model: "消息里没有可发送的内容。", user: "消息里没有可发送的内容。", status: 400 },
  wechat_media_source_missing: { model: "图片、视频或文件没有给出来源地址。", user: "图片、视频或文件没有给出来源地址。", status: 400 },
  wechat_media_source_unsupported: {
    model: "这个媒体来源不支持，只能用 https 网址（不带端口和账号）或 data 地址。",
    user: "这个媒体来源不支持。",
    status: 400,
  },
  wechat_media_source_not_public: { model: "这个媒体网址不是公网地址，已拒绝下载。", user: "这个媒体网址不是公网地址。", status: 403 },
  wechat_media_fetch_failed: { model: "媒体下载失败。", user: "媒体下载失败。", status: 502, retryable: true },
  wechat_media_too_large: { model: "媒体文件超过微信允许的大小。", user: "媒体文件超过微信允许的大小。", status: 413 },
  wechat_unsupported_element: { model: "微信不支持这种消息内容。", user: "微信不支持这种消息内容。", status: 400 },
  wechat_send_failed: { model: "微信拒绝了这条消息，没有发出。", user: "微信拒绝了这条消息。", status: 502 },
  wechat_send_unknown: {
    model: "微信没有确认这条消息是否发出，不要重发，先看会话里有没有。",
    user: "微信没有确认这条消息是否发出。",
    status: 502,
  },
  wechat_roster_unavailable: { model: "微信服务暂时查不到群成员。", user: "微信服务暂时查不到群成员。", status: 502, retryable: true },
});
