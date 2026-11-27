import { AppError, defineErrors } from "@yesimbot/foundation";

/**
 * The codes keep the names they have always had: the model-facing texts in `tools.ts`, the account state on disk
 * (`errorCode` of activities) and the console's Chinese reasons read them by name, so none carries a domain prefix.
 * Network failures (`network_failed`, `network_timeout`, ...) are the foundation's own codes.
 */
export const XIAOHEIHE_ERRORS = defineErrors({
  xiaoheihe_login_required: {
    model: "小黑盒还没有登录或登录已失效，请让管理员在控制台「服务连接」里扫码登录。",
    user: "小黑盒还没有登录或登录已失效，请让管理员在控制台「服务连接」里扫码登录。",
    status: 401,
  },
  xiaoheihe_upstream_failed: { model: "小黑盒接口请求失败，请稍后再试。", user: "小黑盒接口请求失败，请稍后再试。", status: 502 },
  authentication_required: { model: "小黑盒登录已失效，请重新扫码登录。", user: "小黑盒登录已失效，请重新扫码登录。", status: 401 },
  captcha_required: { model: "小黑盒要求验证，账号已暂停，请在小黑盒里处理。", user: "小黑盒要求验证，账号已暂停，请在小黑盒里处理。", status: 403 },
  rate_limited: { model: "小黑盒限制了请求频率，请稍后再试。", user: "小黑盒限制了请求频率，请稍后再试。", status: 429 },
  upstream_rejected: { model: "小黑盒拒绝了这次请求。", user: "小黑盒拒绝了这次请求。", status: 502 },
  upstream_http_error: { model: "小黑盒返回了错误状态。", user: "小黑盒返回了错误状态。", status: 502 },
  invalid_upstream_response: { model: "小黑盒返回的内容格式不对。", user: "小黑盒返回的内容格式不对。", status: 502 },
  invalid_api_path: { model: "接口路径不合法。", user: "接口路径不合法。", status: 500 },
  session_invalid: { model: "小黑盒登录文件的格式不对。", user: "小黑盒登录文件的格式不对。", status: 500 },
  session_unreadable: { model: "小黑盒登录文件无法读取。", user: "小黑盒登录文件无法读取。", status: 500 },
  session_file_symlink: { model: "小黑盒登录文件是符号链接，已拒绝使用。", user: "小黑盒登录文件是符号链接，已拒绝使用。", status: 500 },
  account_identity_mismatch: { model: "登录的小黑盒账号和配置的账号不一致。", user: "登录的小黑盒账号和配置的账号不一致。", status: 403 },
  account_paused: { model: "小黑盒账号目前处于暂停状态，不能操作。", user: "小黑盒账号目前处于暂停状态，不能操作。", status: 409 },
  account_closed: { model: "小黑盒连接已关闭。", user: "小黑盒连接已关闭。", status: 503 },
  reconnect_required: { model: "小黑盒连接需要重新建立。", user: "小黑盒连接需要重新建立。", status: 503 },
  read_only: { model: "小黑盒当前只读，不能发布。", user: "小黑盒当前只读，不能发布。", status: 403 },
  daily_limit: { model: "今天的额度已经用完。", user: "今天的额度已经用完。", status: 429 },
  duplicate_action: { model: "这次操作已经做过一次，不会重复执行。", user: "这次操作已经做过一次，不会重复执行。", status: 409 },
  target_quarantined: {
    model: "这个帖子里有一次结果不确定的评论，已隔离，不能再发。",
    user: "这个帖子里有一次结果不确定的评论，已隔离，不能再发。",
    status: 409,
  },
  new_post_quarantined: {
    model: "有一次新帖发布结果不确定，已隔离，暂时不能再发新帖。",
    user: "有一次新帖发布结果不确定，已隔离，暂时不能再发新帖。",
    status: 409,
  },
  already_commented: { model: "这个帖子里已经有一条顶层评论。", user: "这个帖子里已经有一条顶层评论。", status: 409 },
  read_post_first: { model: "要先读过这个帖子，才能在里面评论或回复。", user: "要先读过这个帖子，才能在里面评论或回复。", status: 409 },
  unknown_comment: { model: "这个帖子里没有这条评论。", user: "这个帖子里没有这条评论。", status: 404 },
  unknown_reply_target: { model: "不能回复这条评论。", user: "不能回复这条评论。", status: 400 },
  ambiguous_reply_target: { model: "回复目标已变化或无法唯一确认，没有发出。", user: "回复目标已变化或无法唯一确认，没有发出。", status: 409 },
  reply_target_unavailable: { model: "回复目标已经不可用，没有发出。", user: "回复目标已经不可用，没有发出。", status: 409 },
  reply_target_changed: { model: "回复目标已变化，没有发出。", user: "回复目标已变化，没有发出。", status: 409 },
  reply_preflight_failed: { model: "回复前的检查失败，没有发出。", user: "回复前的检查失败，没有发出。", status: 502 },
  invalid_publication_text: { model: "内容为空或过长。", user: "内容为空或过长。", status: 400 },
  invalid_post_title_or_body: { model: "标题或正文不符合要求。", user: "标题或正文不符合要求。", status: 400 },
  invalid_keyword: { model: "关键词不能为空且不能太长。", user: "关键词不能为空且不能太长。", status: 400 },
  unknown_native_emoji: { model: "内容里有不认识的小黑盒表情代码。", user: "内容里有不认识的小黑盒表情代码。", status: 400 },
  uncertain_delivery: { model: "发布结果不确定，已记录并隔离，不要重试。", user: "发布结果不确定，已记录并隔离，不要重试。", status: 502 },
  publication_receipt_missing: { model: "发布后没有拿到回执。", user: "发布后没有拿到回执。", status: 502 },
  publication_verification_pending: { model: "发布后暂时无法确认结果。", user: "发布后暂时无法确认结果。", status: 502 },
  reservation_changed: { model: "发布前的预留记录已被改动。", user: "发布前的预留记录已被改动。", status: 409 },
  inspect_uncertain_delivery_first: { model: "需要先确认之前结果不确定的发布。", user: "需要先确认之前结果不确定的发布。", status: 409 },
  account_state_write_failed: { model: "小黑盒账号状态写入失败。", user: "小黑盒账号状态写入失败。", status: 500 },
  account_state_mismatch: { model: "账号状态文件属于另一个账号。", user: "账号状态文件属于另一个账号。", status: 500 },
  account_state_guard_failed: { model: "账号状态文件正在变化或格式过旧，已拒绝。", user: "账号状态文件正在变化或格式过旧，已拒绝。", status: 500 },
  invalid_account_state: { model: "账号状态文件无法读取。", user: "账号状态文件无法读取。", status: 500 },
  account_store_owned: { model: "账号状态正被另一个进程使用。", user: "账号状态正被另一个进程使用。", status: 409 },
  account_store_lock_changed: { model: "账号状态的锁文件在检查时被改动。", user: "账号状态的锁文件在检查时被改动。", status: 409 },
  account_store_closed: { model: "账号状态已关闭。", user: "账号状态已关闭。", status: 503 },
  post_identity_mismatch: { model: "返回的帖子和请求的不是同一个。", user: "返回的帖子和请求的不是同一个。", status: 502 },
  reply_root_mismatch: { model: "返回的楼层和请求的不是同一个。", user: "返回的楼层和请求的不是同一个。", status: 502 },
  reply_root_unavailable: { model: "这个楼层暂时读不到。", user: "这个楼层暂时读不到。", status: 404 },
  reply_target_mismatch: { model: "评论的回复关系前后不一致。", user: "评论的回复关系前后不一致。", status: 502 },
  reply_cursor_not_advanced: { model: "翻页游标没有前进。", user: "翻页游标没有前进。", status: 502 },
  comment_author_mismatch: { model: "评论的作者信息前后不一致。", user: "评论的作者信息前后不一致。", status: 502 },
  conflicting_comment: { model: "同一条评论出现了相互矛盾的内容。", user: "同一条评论出现了相互矛盾的内容。", status: 502 },
  invalid_identifier: { model: "ID 格式不对。", user: "ID 格式不对。", status: 400 },
  invalid_identity: { model: "账号信息格式不对。", user: "账号信息格式不对。", status: 502 },
  invalid_post_list: { model: "帖子列表的格式不对。", user: "帖子列表的格式不对。", status: 502 },
  invalid_comment_list: { model: "评论列表的格式不对。", user: "评论列表的格式不对。", status: 502 },
  invalid_reply_context: { model: "楼中楼的格式不对。", user: "楼中楼的格式不对。", status: 502 },
  invalid_community_search: { model: "社区搜索结果的格式不对。", user: "社区搜索结果的格式不对。", status: 502 },
  invalid_community_feed: { model: "社区帖子列表的格式不对。", user: "社区帖子列表的格式不对。", status: 502 },
  community_not_found: { model: "没有找到这个社区，或有多个同名社区。", user: "没有找到这个社区，或有多个同名社区。", status: 404 },
  invalid_emoji_catalog: { model: "表情目录的格式不对。", user: "表情目录的格式不对。", status: 502 },
  emoji_catalog_unavailable: { model: "表情目录暂时不可用。", user: "表情目录暂时不可用。", status: 503 },
});

/** The code of a registered failure; anything else (a foreign error, a non-error) has none. */
export function errorCodeOf(error: unknown): string {
  return error instanceof AppError ? error.code : "";
}
