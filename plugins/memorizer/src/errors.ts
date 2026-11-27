import { AppError, defineErrors, toToolResult, type ErrorEffect, type ToolFailure } from "@yesimbot/foundation";

/**
 * An AppError's `message` is its code. The codes `memory_not_found`, `memory_revision_conflict`, `invalid_memory_content`,
 * `invalid_memory_visibility` and `invalid_memory_page` keep the names the console's memory pages match on (`webui/memory.ts`).
 * The `model` texts are what the main model reads when a memory tool refuses; they keep the wording the spec fixed.
 */
export const MEMORY_ERRORS = defineErrors({
  // The owner management API (the console matches these codes by name).
  memory_not_found: { model: "找不到这条记忆。", user: "找不到这条记忆。", status: 404 },
  memory_revision_conflict: { model: "这条记忆已被修改，请重新读取后再改。", user: "这条记忆已被修改，请刷新后再试。", status: 409 },
  invalid_memory_content: { model: "记忆内容为空、过长或含有凭据。", user: "记忆内容为空、过长或含有凭据。", status: 400 },
  invalid_memory_visibility: { model: "记忆的可见范围不合法。", user: "记忆的可见范围不合法。", status: 400 },
  invalid_memory_page: { model: "分页参数不合法。", user: "分页参数不合法。", status: 400 },
  // Writing a memory.
  memory_content_empty: { model: "记忆内容不能为空", user: "记忆内容不能为空。", status: 400 },
  memory_credential: { model: "记忆内容里有密码、token 等凭据，不能记", user: "记忆内容里有凭据，不能记。", status: 400 },
  memory_importance_range: { model: "importance 要在 0.6 到 1 之间：不够重要的不记", user: "重要性要在 0.6 到 1 之间。", status: 400 },
  memory_confidence_range: { model: "confidence 要在 0.7 到 1 之间：推测、玩笑和传闻不记", user: "置信度要在 0.7 到 1 之间。", status: 400 },
  memory_user_required: { model: "scope=user 时要写明 userId（证据里说话的那个人）", user: "个人记忆要写明是谁。", status: 400 },
  memory_user_not_speaker: { model: "scope=user 的 userId 必须是证据消息里说话的人", user: "个人记忆的主人必须是证据里说话的人。", status: 400 },
  memory_publish_owner_only: {
    model: "私聊里只有主人能把内容记成公开的通用知识（scope=shared）",
    user: "私聊里只有主人能把内容记成公开的通用知识。",
    status: 403,
  },
  memory_edit_shared_owner_only: { model: "私聊里只有主人能修改公开的通用知识", user: "私聊里只有主人能修改公开的通用知识。", status: 403 },
  memory_shared_names_person: { model: "公开的通用知识不能写出证据里任何人的名字或 ID", user: "公开的通用知识不能写出任何人的名字或 ID。", status: 400 },
  memory_update_empty: { model: "没有要修改的内容", user: "没有要修改的内容。", status: 400 },
  memory_content_sources_required: {
    model: "修改记忆内容要给出支持新内容的消息（sources）",
    user: "修改记忆内容要给出支持新内容的消息。",
    status: 400,
  },
  memory_id_too_short: { model: "记忆 ID 至少写前 8 位", user: "记忆 ID 至少写前 8 位。", status: 400 },
  memory_id_ambiguous: { model: "这个 ID 前缀对应多条记忆，请写完整 ID", user: "这个 ID 前缀对应多条记忆。", status: 409 },
  memory_not_visible: {
    model: "当前对话里找不到这条记忆（ID 不对，或它不属于这里）",
    user: "当前对话里找不到这条记忆。",
    status: 404,
  },
  // Evidence.
  memory_sources_required: { model: "要给出至少一条证据消息（sources 填 messageId）", user: "要给出至少一条证据消息。", status: 400 },
  memory_sources_too_many: { model: "证据消息最多 50 条", user: "证据消息最多 50 条。", status: 400 },
  memory_source_missing: {
    model: "证据消息不存在或不唯一：sources 要逐字复制本对话消息的 messageId",
    user: "证据消息不存在或不唯一。",
    status: 404,
  },
  memory_source_foreign: { model: "证据消息不在本对话里", user: "证据消息不在本对话里。", status: 403 },
  memory_source_credential: { model: "证据消息里有凭据，不能作为记忆证据", user: "证据消息里有凭据，不能作为记忆证据。", status: 400 },
  // Attachments.
  memory_attachments_too_many: { model: "一条记忆最多带 4 个附件", user: "一条记忆最多带 4 个附件。", status: 400 },
  memory_attachments_unavailable: { model: "这里不能给记忆加附件", user: "这里不能给记忆加附件。", status: 400 },
  memory_attachment_source_required: { model: "加附件要给出图片或文件所在的消息（sources）", user: "加附件要给出图片或文件所在的消息。", status: 400 },
  memory_attachment_not_in_sources: {
    model: "附件不在证据消息里：attachments 写证据消息里图片或文件的 asset:// 地址，sources 要包含那条消息",
    user: "附件不在证据消息里。",
    status: 400,
  },
  memory_attachment_unreadable: { model: "附件读不到（可能已经过期，或超过 5 MB）", user: "附件读不到。", status: 404 },
  memory_attachment_credential: { model: "附件里有密码、token 等凭据，不能记", user: "附件里有凭据，不能记。", status: 400 },
  memory_attachment_index_invalid: { model: "附件序号不合法。", user: "附件序号不合法。", status: 400 },
  memory_id_invalid: { model: "记忆 ID 不合法。", user: "记忆 ID 不合法。", status: 400 },
  // Store invariants.
  memory_context_required: { model: "这条记忆需要一个所属的会话。", user: "这条记忆需要一个所属的会话。", status: 400 },
  memory_platform_mismatch: { model: "记忆的平台与会话不一致。", user: "记忆的平台与会话不一致。", status: 400 },
  memory_user_mismatch: { model: "记忆的用户与私聊会话不一致。", user: "记忆的用户与私聊会话不一致。", status: 400 },
  memory_platform_required: { model: "公开记忆需要写明平台。", user: "公开记忆需要写明平台。", status: 400 },
  memory_scope_targets_invalid: { model: "公开记忆不能带有会话或用户指向。", user: "公开记忆不能带有会话或用户指向。", status: 400 },
  memory_channel_context_required: { model: "会话记忆需要一个会话。", user: "会话记忆需要一个会话。", status: 400 },
  memory_user_scope_incomplete: { model: "个人记忆需要平台和用户 ID。", user: "个人记忆需要平台和用户 ID。", status: 400 },
  memory_score_range: { model: "重要性和置信度必须在 0 到 1 之间。", user: "重要性和置信度必须在 0 到 1 之间。", status: 400 },
  memory_ownership_immutable: { model: "记忆的归属不能改变。", user: "记忆的归属不能改变。", status: 409 },
  memory_merge_scope_mismatch: { model: "只能合并同一归属范围内的记忆。", user: "只能合并同一归属范围内的记忆。", status: 409 },
  // The background agents (daily consolidation, the legacy maintainer and the search agent).
  memory_not_authorized: { model: "这条记忆没有通过 query_memories 授权。", user: "这条记忆没有授权。", status: 403 },
  memory_not_in_group: { model: "这条记忆不在本次待整理的分组里", user: "这条记忆不在本次待整理的分组里。", status: 400 },
  memory_merge_other_group: { model: "只能合并同一组里的记忆", user: "只能合并同一组里的记忆。", status: 400 },
  memory_merge_content_invalid: { model: "合并后的内容为空或含凭据", user: "合并后的内容为空或含凭据。", status: 400 },
  memory_source_ambiguous: { model: "证据消息 ID 重复，无法确定来源。", user: "证据消息 ID 重复。", status: 400 },
  memory_duplicate_check_required: { model: "创建记忆前要先用 query_memories 检查重复。", user: "创建记忆前要先检查重复。", status: 409 },
  memory_source_not_in_batch: { model: "证据消息不在本批次里。", user: "证据消息不在本批次里。", status: 400 },
  memory_shared_not_requested: { model: "没有明确的公开请求，或来源是私聊，不能记成公开的通用知识。", user: "不能记成公开的通用知识。", status: 403 },
  memory_candidate_weak: { model: "候选记忆不够重要或不够可靠：importance 至少 0.6，confidence 至少 0.7。", user: "候选记忆不够重要或不够可靠。", status: 400 },
  memory_batch_evidence_required: { model: "修改内容要给出本批次里的证据消息。", user: "修改内容要给出本批次里的证据消息。", status: 400 },
  memory_id_required: { model: "要给出记忆 ID。", user: "要给出记忆 ID。", status: 400 },
  memory_report_unauthorized: { model: "报告里有没授权的记忆 ID。", user: "报告里有没授权的记忆 ID。", status: 403 },
  memory_search_timeout: { model: "记忆搜索超时。", user: "记忆搜索超时。", status: 504, retryable: true },
  memory_search_no_report: { model: "记忆搜索没有给出报告。", user: "记忆搜索没有给出报告。", status: 502, retryable: true },
  memory_search_changed: { model: "搜索期间记忆的授权发生了变化，请重试。", user: "搜索期间记忆的授权发生了变化。", status: 409, retryable: true },
});

export type MemoryErrorCode = keyof typeof MEMORY_ERRORS;

/** A refusal made before anything was written; `detail` goes to the logs only. */
export function refuse(code: MemoryErrorCode, detail?: string, effect: ErrorEffect = "none"): AppError {
  return new AppError(code, { effect, ...(detail === undefined ? {} : { detail }) });
}

/**
 * Wraps a tool's `execute` so a refusal reaches the model as `{ ok: false, error: { code, message, retryable }, effect }`
 * with the registered Chinese text; any other failure still throws.
 */
export function guarded<IN, OUT, CONTEXT = unknown>(
  execute: (input: IN, context: CONTEXT) => Promise<OUT> | OUT,
): (input: IN, context: CONTEXT) => Promise<OUT | ToolFailure> {
  return async (input, context) => {
    try {
      return await execute(input, context);
    } catch (cause) {
      if (cause instanceof AppError && cause.code in MEMORY_ERRORS) return toToolResult(cause);
      throw cause;
    }
  };
}
