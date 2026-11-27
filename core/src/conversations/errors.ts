import { AppError, defineErrors, type ErrorEffect } from "@yesimbot/foundation";

/** A conversation's history, its context reads and regions, and the reply journal. */
export const CONVERSATION_ERRORS = defineErrors({
  conversation_not_initialized: { model: "会话还没有初始化。", user: "会话还没有初始化。", status: 500 },
  conversation_changed: { model: "会话已经换成新的了。", user: "会话已经变了，请刷新后再试。", status: 409 },
  conversation_empty: { model: "这个会话还没有内容。", user: "这个会话还没有内容。", status: 409 },
  conversation_session_invalid: { model: "会话编号格式不对。", user: "会话编号格式不对。", status: 400 },
  conversation_message_identity_invalid: { model: "消息的身份信息不完整。", user: "消息的身份信息不完整。", status: 500 },
  conversation_admission_not_persisted: { model: "入站消息还没有写入历史。", user: "入站消息还没有写入历史。", status: 500 },
  conversation_retained_entry_conflict: { model: "保留的历史条目和记录冲突。", user: "保留的历史条目和记录冲突。", status: 409 },
  conversation_source_message_invalid: { model: "来源消息编号缺失或重复。", user: "来源消息编号缺失或重复。", status: 500 },
  conversation_read_range_invalid: { model: "读取范围参数无效。", user: "读取范围参数无效。", status: 400 },
  context_query_too_long: { model: "搜索词太长。", user: "搜索词太长。", status: 400 },
  context_cursor_invalid: { model: "这个游标无效或已经过期，重新搜索。", user: "游标无效。", status: 400 },
  context_block_not_accessible: { model: "这个上下文块现在读不到。", user: "这个上下文块现在读不到。", status: 404 },
  context_block_id_invalid: { model: "上下文块编号格式不对。", user: "上下文块编号格式不对。", status: 400 },
  context_read_cancelled: { model: "读取已取消。", user: "读取已取消。", status: 499 },
  context_read_stale: { model: "会话已经变了，重新搜索后再读。", user: "会话已经变了。", status: 409, retryable: true },
  context_read_failed: { model: "读取上下文失败。", user: "读取上下文失败。", status: 500 },
  context_raw_source_unavailable: { model: "这段原文现在读不到。", user: "这段原文现在读不到。", status: 404 },
  context_raw_source_missing: { model: "找不到这段原文。", user: "找不到这段原文。", status: 404 },
  context_raw_source_ambiguous: { model: "这段原文对应不到唯一的位置。", user: "这段原文对应不到唯一的位置。", status: 409 },
  context_raw_page_empty: { model: "这一页原文是空的。", user: "这一页原文是空的。", status: 404 },
  context_source_active_turn: { model: "这段内容属于正在进行的这一轮，不能当作历史读取。", user: "这段内容属于正在进行的这一轮。", status: 409 },
  context_source_session_invalid: { model: "来源会话不对。", user: "来源会话不对。", status: 400 },
  context_source_conflict: { model: "来源内容和记录不一致。", user: "来源内容和记录不一致。", status: 409 },
  context_source_bounds_missing: { model: "缺少来源范围。", user: "缺少来源范围。", status: 400 },
  context_source_bounds_invalid: { model: "来源范围无效。", user: "来源范围无效。", status: 400 },
  context_source_id_invalid: { model: "来源编号格式不对。", user: "来源编号格式不对。", status: 400 },
  context_limit_invalid: { model: "limit 参数无效。", user: "limit 参数无效。", status: 400 },
  context_budget_denied: { model: "上下文预算不够，没有读取。", user: "上下文预算不够。", status: 413 },
  context_stopped: { model: "上下文服务已经停止。", user: "服务正在重启，稍后再试。", status: 503, retryable: true },
  context_not_active: { model: "上下文工作区现在没有启用。", user: "上下文工作区现在没有启用。", status: 409 },
  context_event_history_isolated: { model: "事件会话的历史和主会话隔离，不能读取。", user: "事件会话的历史和主会话隔离。", status: 403 },
  context_region_stale: { model: "这段整理结果已经过期。", user: "这段整理结果已经过期。", status: 409 },
  context_region_source_unavailable: { model: "这段历史原文现在读不到。", user: "这段历史原文现在读不到。", status: 404 },
  context_region_source_conflict: { model: "这段历史原文和记录不一致。", user: "这段历史原文和记录不一致。", status: 409 },
  context_region_source_too_large: { model: "这段历史原文太长。", user: "这段历史原文太长。", status: 413 },
  context_region_output_invalid: { model: "整理模型的输出格式不对。", user: "整理模型的输出格式不对。", status: 502 },
  context_region_data_invalid: { model: "整理结果的数据无效。", user: "整理结果的数据无效。", status: 500 },
  context_region_model_limit_invalid: { model: "整理模型的输出上限配置无效。", user: "整理模型的输出上限配置无效。", status: 500 },
  context_region_model_failed: { model: "整理模型调用失败。", user: "整理模型调用失败。", status: 502 },
  reply_journal_closed: { model: "回复记录已经关闭。", user: "回复记录已经关闭。", status: 500 },
  reply_journal_sequence_conflict: { model: "回复记录的顺序冲突。", user: "回复记录的顺序冲突。", status: 409 },
  reply_journal_write_unsettled: { model: "回复记录还有没写完的内容。", user: "回复记录还有没写完的内容。", status: 500 },
  reply_journal_write_in_progress: { model: "回复记录正在写入。", user: "回复记录正在写入。", status: 409 },
  reply_proof_write_timeout: { model: "写入投递证明超时。", user: "写入投递证明超时。", status: 504 },
  reply_proof_generation_changed: { model: "投递证明所属的会话已经更换。", user: "投递证明所属的会话已经更换。", status: 409 },
});

export type ConversationErrorCode = (typeof CONVERSATION_ERRORS)[keyof typeof CONVERSATION_ERRORS];

/** A conversation error; by default nothing was written. */
export function conversationError(
  code: ConversationErrorCode,
  options: { readonly detail?: string; readonly cause?: unknown; readonly effect?: ErrorEffect } = {},
): AppError {
  return new AppError(code, { effect: "none", ...options });
}

/** Whether `cause` is the conversation error `code`. */
export function isConversationError(cause: unknown, ...codes: readonly ConversationErrorCode[]): cause is AppError {
  return cause instanceof AppError && (codes as readonly string[]).includes(cause.code);
}
