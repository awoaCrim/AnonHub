import { AppError, defineErrors, type AppErrorOptions } from "@yesimbot/foundation";

/**
 * The codes keep the names they have always had: the console reads `google_*` codes from the connector's errors and the
 * system prompt tells the model what `google_result_unknown` means. The registered `model` text is all the model reads of
 * a failure; Google's own error text never leaves this plugin.
 */
export const GOOGLE_ERRORS = defineErrors({
  google_store_invalid: { model: "Google 授权数据文件无法使用，已停止加载。", user: "Google 授权数据文件无法使用，已停止加载，原文件已保留。", status: 500 },
  google_timeout: { model: "Google 请求超时或已取消。", user: "Google 请求超时或已取消。", status: 504, retryable: true },
  google_unavailable: { model: "Google 服务暂时连不上，请稍后再试。", user: "Google 服务暂时连不上，请稍后再试。", status: 503, retryable: true },
  google_response_too_large: { model: "Google 返回的内容超过大小上限。", user: "Google 返回的内容超过大小上限。", status: 502 },
  google_reconnect_required: {
    model: "Google 授权已失效，请让管理员在设置里重新连接。",
    user: "Google 授权已失效，请在设置 → 服务连接里重新连接。",
    status: 409,
  },
  google_app_invalid: {
    model: "Google 应用的 Client ID 或 Secret 不正确，请让管理员检查设置。",
    user: "Google 应用的 Client ID 或 Secret 不正确。",
    status: 409,
  },
  google_permission_denied: { model: "Google 拒绝了这次访问，当前授权没有这项权限。", user: "Google 拒绝了这次访问。", status: 403 },
  google_not_found: { model: "Google 里没有找到这个对象。", user: "Google 里没有找到这个对象。", status: 404 },
  google_rate_limited: { model: "Google 限制了请求频率，请稍后再试。", user: "Google 限制了请求频率，请稍后再试。", status: 429, retryable: true },
  google_request_rejected: { model: "Google 拒绝了这次请求，内容不符合要求。", user: "Google 拒绝了这次请求。", status: 502 },
  google_invalid_response: { model: "Google 返回的内容格式不对。", user: "Google 返回的内容格式不对。", status: 502 },
  google_redirect_invalid: { model: "Google 回调地址不合法。", user: "Google 回调地址不合法。", status: 400 },
  google_app_not_configured: { model: "Google 应用还没有配置，请让管理员先设置。", user: "Google 应用还没有配置。", status: 409 },
  google_account_not_found: { model: "没有这个 Google 连接，请核对 accountId，或省略它让系统选择。", user: "没有这个 Google 连接。", status: 404 },
  google_login_busy: { model: "Google 授权正在进行中的太多，请稍后再试。", user: "Google 授权正在进行中的太多，请稍后再试。", status: 409 },
  google_oauth_invalid: { model: "Google 授权没有完成，请重新连接。", user: "Google 授权没有完成，请重新连接。", status: 409 },
  google_consent_denied: { model: "Google 授权被拒绝了。", user: "Google 授权被拒绝了。", status: 409 },
  google_no_services_granted: { model: "Google 没有授予任何服务的权限。", user: "Google 没有授予任何服务的权限。", status: 409 },
  google_refresh_missing: {
    model: "Google 没有给出长期授权，请重新连接并同意离线访问。",
    user: "Google 没有给出长期授权，请重新连接并同意离线访问。",
    status: 409,
  },
  google_account_limit: { model: "Google 连接数量已到上限。", user: "Google 连接数量已到上限。", status: 409 },
  google_account_changed: { model: "Google 连接刚刚被改动，请重试。", user: "Google 连接刚刚被改动，请重试。", status: 409 },
  google_scope_required: { model: "当前授权没有这项权限，请让管理员在设置里调整。", user: "当前授权没有这项权限。", status: 403 },
  google_operation_id_required: { model: "这次写入缺少操作标识，没有执行。", user: "这次写入缺少操作标识，没有执行。", status: 400 },
  google_operation_already_attempted: {
    model: "这次写入已经尝试过一次，不会重复执行。请先查询实际状态。",
    user: "这次写入已经尝试过一次，不会重复执行。",
    status: 409,
  },
  google_operation_limit: { model: "Google 写入记录已满，没有执行。", user: "Google 写入记录已满。", status: 409 },
  google_result_unknown: {
    model: "写入结果不确定，可能已经生效。先查询实际状态，不要自动重复写入。",
    user: "Google 写入结果不确定，可能已经生效。",
    status: 502,
  },
  google_invalid_input: { model: "参数不符合要求，请修正后重试。", user: "填写的内容不符合要求。", status: 400 },
  google_cancelled: { model: "操作已取消。", user: "操作已取消。", status: 499 },
  google_operation_failed: { model: "Google 操作没有完成。", user: "Google 操作没有完成。", status: 500 },
});

/**
 * A registered failure. Only a failure of the transport or of the answer leaves `effect` at `unknown` (a write may have
 * gone through); every other code is found before anything is sent or after Google refused, so nothing happened.
 */
export function googleError(code: keyof typeof GOOGLE_ERRORS, options: AppErrorOptions = {}): AppError {
  const uncertain = ["google_timeout", "google_unavailable", "google_response_too_large", "google_invalid_response", "google_result_unknown"];
  return new AppError(code, { effect: uncertain.includes(code) ? "unknown" : "none", ...options });
}
