import { AppError, defineErrors, toToolResult, type ErrorEffect, type ToolFailure } from "@yesimbot/foundation";

export const STICKER_ERRORS = defineErrors({
  sticker_capability_retired: { model: "表情包能力已停用，本轮不能再使用。", user: "表情包能力已停用。", status: 409 },
  sticker_not_found: { model: "没有找到这个表情包，请重新查询当前库。", user: "没有找到这个表情包。", status: 404 },
  sticker_too_large: { model: "表情包文件超过大小上限。", user: "表情包文件超过大小上限。", status: 413 },
  sticker_asset_id_invalid: { model: "asset_id 必须是完整的 32 位十六进制 id。", user: "素材 ID 格式不对。", status: 400 },
  sticker_id_invalid: { model: "sticker_id 必须是完整的 64 位十六进制 id。", user: "表情包 ID 格式不对。", status: 400 },
  sticker_classification_required: {
    model: "分类不能为空，也不能是“未分类”，请按画面选一个具体分类。",
    user: "分类不能为空，也不能是“未分类”。",
    status: 400,
  },
  sticker_category_invalid: { model: "分类名不能为空。", user: "分类名不能为空。", status: 400 },
  sticker_category_unchanged: { model: "新分类名与原分类相同。", user: "新分类名与原分类相同。", status: 400 },
  sticker_category_not_found: { model: "没有找到这个分类。", user: "没有找到这个分类。", status: 404 },
  sticker_asset_not_found: { model: "没有找到这个聊天素材。", user: "没有找到这个聊天素材。", status: 404 },
  sticker_asset_mismatch: { model: "素材内容与 asset_id 不一致。", user: "素材内容与 ID 不一致。", status: 409 },
  sticker_image_unsupported: { model: "不支持这种图片格式。", user: "不支持这种图片格式。", status: 400 },
  sticker_image_read_required: { model: "收藏前需要先完整看过这张图片，请先读取它。", user: "收藏前需要先看过这张图片。", status: 409 },
  sticker_image_input_unavailable: { model: "当前模型不能查看图片，无法预览表情包。", user: "当前模型不能查看图片。", status: 503 },
  sticker_collection_failed: { model: "收藏表情包失败。", user: "收藏表情包失败。", status: 500 },
  sticker_management_failed: { model: "整理表情包失败。", user: "整理表情包失败。", status: 500 },
  sticker_send_limit_reached: { model: "本轮已经发送过一次表情包，不能再发。", user: "本轮已经发送过表情包。", status: 429 },
  sticker_delivery_uncertain: { model: "表情包可能已经发出，但没有拿到平台回执，不要重复发送。", user: "表情包发送结果不确定。", status: 502 },
  sticker_preview_stale: { model: "表情包内容已变化，请重新预览。", user: "表情包内容已变化。", status: 409 },
  sticker_preview_too_large: { model: "表情包太大，无法预览。", user: "表情包太大，无法预览。", status: 413 },
  sticker_preview_unavailable: { model: "无法生成这个表情包的预览。", user: "无法生成预览。", status: 503 },
  sticker_preview_expired: { model: "预览画面已过期，请重新预览。", user: "预览画面已过期。", status: 410 },
  sticker_prepare_failed: { model: "表情包转换失败，无法发送。", user: "表情包转换失败。", status: 500 },
  sticker_scope_unavailable: { model: "当前会话缺少机器人身份，无法确定表情库范围。", user: "缺少机器人身份，无法确定表情库范围。", status: 400 },
  sticker_import_empty: { model: "没有可导入的内容。", user: "没有可导入的内容。", status: 400 },
  sticker_import_unreadable: { model: "无法读取要导入的文件。", user: "无法读取要导入的文件。", status: 400 },
});

export type StickerErrorCode = keyof typeof STICKER_ERRORS;

/** What a sticker tool returns to the model for a registered code (foundation codes included); anything else reads as `internal_error`. */
export function stickerFailure(code: string, effect: ErrorEffect = "none"): ToolFailure {
  return toToolResult(new AppError(code, { effect }));
}

/** The registered code carried by a caught error, if any. */
export function errorCode(cause: unknown): string | undefined {
  return cause instanceof AppError ? cause.code : undefined;
}
