import { defineErrors } from "@yesimbot/foundation";

/** A conversation's runtime refusing work, and context budgets that cannot hold a request. */
export const RUNTIME_ERRORS = defineErrors({
  runtime_stopped: { model: "这个会话的运行时已经停止。", user: "服务正在重启，稍后再试。", status: 503, retryable: true },
  runtime_unavailable: { model: "这个会话现在没有运行时。", user: "这个会话现在没有在运行，稍后再试。", status: 409 },
  runtime_setup_conflict: { model: "运行时的插件登记冲突。", user: "运行时的插件登记冲突。", status: 500 },
  context_budget_invalid: { model: "上下文预算配置无效。", user: "上下文预算配置无效。", status: 500 },
  context_budget_exceeded: { model: "内容超出了上下文预算。", user: "内容超出了上下文预算。", status: 413 },
  context_budget_media_unsupported: { model: "无法估算这种内容占用的上下文。", user: "无法估算这种内容占用的上下文。", status: 500 },
  context_deadline_reached: { model: "整理上下文超时，按已有结果继续。", user: "整理上下文超时。", status: 504, retryable: true },
  context_trigger_invalid: { model: "上下文压缩阈值配置无效。", user: "上下文压缩阈值配置无效。", status: 500 },
  region_review_timeout: { model: "局部历史复核超时。", user: "局部历史复核超时。", status: 504, retryable: true },
});
