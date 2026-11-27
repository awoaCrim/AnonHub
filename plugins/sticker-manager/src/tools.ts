import type { AgentTool } from "@yesimbot/agent-runtime";
import { contentHash, type ToolFailure } from "@yesimbot/foundation";
import {
  hasCompletedImageRead,
  parseReply,
  partView,
  type Part,
  RESOURCE_MAX_BYTES,
  withAbortSignal,
  type AssetStore,
  type ChannelContext,
} from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { stickerFailure, errorCode } from "./errors.js";
import { detectImageMediaType } from "./files.js";
import type { StickerStore } from "./store.js";
import { normalizeCategory, normalizeTags, scopeKeyFor, tagModeInput, type StickerConfig } from "./types.js";

const manageSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), sticker_id: z.string().regex(/^[a-f0-9]{64}$/), category: z.string().min(1) }).strict(),
  z.object({ action: z.literal("delete"), sticker_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.enum(["rename_category", "merge_category"]), source_category: z.string().min(1), category: z.string().min(1) }).strict(),
]);

type ToolResult = { ok: true; message: string; [key: string]: unknown } | ToolFailure;

type ManageStickerInput = z.infer<typeof manageSchema>;

export interface StickerToolsOptions {
  store: StickerStore;
  assets: AssetStore;
  scope: ChannelContext;
  config: StickerConfig;
  readonly captureTurn?: (turnId: string) => () => boolean;
}

export function createStickerTools(options: StickerToolsOptions): AgentTool[] {
  const { store, assets, scope, config } = options;
  const scopeKey = scopeKeyFor(scope, config);

  const stealSchema = z
    .object({
      asset_id: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .describe("当前聊天完整 32 位 asset id"),
      category: z.string().min(1).describe("根据实际画面选择的具体分类，非未分类"),
      tags: z.array(z.string().max(32)).max(5).optional(),
    })
    .strict();
  const searchSchema = z
    .object({
      category: z.string().optional().describe("已有分类的完整名称，精确匹配"),
      keyword: z.string().optional().describe("分类名、id 或标签的单个子串（忽略大小写）；不支持 OR/AND 或画面语义搜索"),
      tags: z.array(z.string()).max(5).optional().describe("实验性标签列表，匹配任一标签即可"),
      limit: z.number().int().min(1).max(50).optional().describe("返回数量上限"),
    })
    .strict();

  const stealTool: AgentTool<z.infer<typeof stealSchema>, ToolResult> = {
    name: "sticker_steal",
    description: [
      "收藏当前聊天（含历史）中已经实际看过的一张图片；不占发送额度。",
      "asset_id 只传消息资源的完整 32 位十六进制 id，不接受 URI/路径，不要猜测。",
      "先完成同一 asset 的 read 原生图片或成功非空 read/describe_image 视觉描述；只有链接、元数据或旧原生结果已清理时必须重读。",
      "category 必填：根据画面选择已有或新的具体分类，不可为空或“未分类”；不会调用辅助分类模型。",
      "重复内容返回已有真实 ID/分类，不会暗中改类；旧未分类记录需要显式管理或管理员分类。",
      ...(config.tagMode ? ["可选 tags 最多 5 个，由你依据画面提供；也会包含分类标签。"] : []),
    ].join("\n"),
    inputSchema: tagModeInput(stealSchema, config),
    execute: async (input, execution) => {
      const current = options.captureTurn?.(execution.turnId) ?? (() => true);
      const allowed = current;
      if (!allowed()) return stickerFailure("sticker_capability_retired");
      if (execution.abortSignal?.aborted) return stickerFailure("request_aborted");
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["asset_id", "category", ...(config.tagMode ? ["tags"] : [])].includes(key)))
        return stickerFailure("input_invalid");
      const { asset_id: id, category, tags } = input;
      if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) return stickerFailure("sticker_asset_id_invalid");
      const classified = typeof category === "string" ? normalizeCategory(category) : "";
      if (!classified || classified === "未分类") return stickerFailure("sticker_classification_required");
      if (tags !== undefined && (!Array.isArray(tags) || tags.length > 5 || tags.some((tag) => typeof tag !== "string" || tag.length > 32)))
        return stickerFailure("input_invalid");
      let bytes: Uint8Array;
      try {
        bytes = await withAbortSignal(assets.get(id), execution.abortSignal);
      } catch {
        return stickerFailure(execution.abortSignal?.aborted ? "request_aborted" : "sticker_asset_not_found");
      }
      if (!allowed()) return stickerFailure("sticker_capability_retired");
      if (bytes.byteLength > RESOURCE_MAX_BYTES) return stickerFailure("sticker_too_large");
      const mediaType = detectImageMediaType(bytes);
      if (!mediaType) return stickerFailure("sticker_image_unsupported");
      if (contentHash(bytes).slice(0, 32) !== id) return stickerFailure("sticker_asset_mismatch");
      if (!hasCompletedImageRead(execution.messages, { uri: `asset://${id}`, bytes, mediaType })) return stickerFailure("sticker_image_read_required");
      try {
        // Duplicate detection and commit share the guarded queue; do not merge tags or move duplicates.
        const saved = await store.save(
          {
            scopeKey,
            bytes,
            mediaType,
            category: classified,
            tags: config.tagMode ? normalizeTags([classified, ...(tags ?? [])]) : undefined,
            source: { kind: "steal", platform: scope.platform, channelId: scope.channelId },
          },
          { signal: execution.abortSignal, stillAllowed: allowed, preserveDuplicate: true },
        );
        const actual = { status: saved.status, id: saved.sticker.id, category: saved.sticker.category, tags: saved.sticker.tags };
        if (!normalizeCategory(saved.sticker.category) || normalizeCategory(saved.sticker.category) === "未分类")
          return { ...actual, ...stickerFailure("sticker_classification_required", "done") };
        return {
          ...actual,
          ok: true,
          message: saved.status === "duplicate" ? `表情包已存在于分类：${saved.sticker.category}` : `已收藏到分类：${saved.sticker.category}`,
        };
      } catch {
        return execution.abortSignal?.aborted
          ? stickerFailure("request_aborted", "unknown")
          : !allowed()
            ? stickerFailure("sticker_capability_retired", "unknown")
            : stickerFailure("sticker_collection_failed", "unknown");
      }
    },
  };

  const searchTool: AgentTool<z.infer<typeof searchSchema>, ToolResult> = {
    name: "sticker_search",
    description: [
      `不带任何检索条件调用（category、keyword${config.tagMode ? "、tags" : ""}、limit 都不给）时，返回当前可见库的分类及每类数量${config.tagMode ? "，以及实验性标签及数量" : ""}，用来了解库里有什么。`,
      "带条件时搜索当前可见的表情包，返回紧凑 id 候选列表。",
      "category 按完整分类名精确匹配；keyword 只是分类名、id 或标签的单个子串，不支持 OR/AND 运算，也不按图片画面或人物进行语义搜索。",
      "搜索结果只是候选元数据，不代表你已经看过画面；sticker_preview 可查看实际画面。",
      "绝不能把返回的 id 拼成 artifact:// 等资源 URI。",
      ...(config.tagMode ? ["实验性 tag 模式开启时，可按 tags 过滤。"] : []),
    ].join("\n"),
    inputSchema: tagModeInput(searchSchema, config),
    execute: async (query) => {
      if (!query.category && !query.keyword && !query.tags?.length && query.limit === undefined) {
        const categories = await store.listCategories(scopeKey);
        const tags = config.tagMode ? await store.listTags(scopeKey) : undefined;
        return { ok: true, categories, ...(tags ? { tags } : {}), message: categories.length ? "已返回分类列表" : "暂无分类" };
      }
      const stickers = await store.search(scopeKey, query);
      return {
        ok: true,
        stickers: stickers.map((sticker) => ({
          id: sticker.id,
          category: sticker.category,
          tags: sticker.tags,
          mime: sticker.mime,
          size: sticker.size,
          usageCount: sticker.usageCount,
        })),
        message: stickers.length ? "已返回当前搜索结果；这些只是元数据，可选 sticker_preview 查看画面" : "没有匹配的表情包",
      };
    },
  };

  const manageTool: AgentTool<ManageStickerInput, ToolResult> = {
    name: "sticker_manage",
    description:
      "管理当前可见库：move 单张重新分类；rename_category 分类改名；merge_category 分类合并；delete 删除精确单张（含管理员导入）。不支持整类或批量删除，不要循环单张删除模拟批量操作；批量需求交给管理员确认。分类通过记录创建，修改后重新查询可获取当前状态。",
    inputSchema: manageSchema,
    execute: async (input, execution) => {
      const current = options.captureTurn?.(execution.turnId) ?? (() => true);
      const allowed = current;
      if (!allowed()) return stickerFailure("sticker_capability_retired");
      if (execution.abortSignal?.aborted) return stickerFailure("request_aborted");
      if (!input || typeof input !== "object") return stickerFailure("input_invalid");
      const keys =
        input.action === "delete"
          ? ["action", "sticker_id"]
          : input.action === "move"
            ? ["action", "sticker_id", "category"]
            : ["action", "source_category", "category"];
      if (Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => typeof (input as Record<string, unknown>)[key] !== "string"))
        return stickerFailure("input_invalid");
      if (!["move", "delete", "rename_category", "merge_category"].includes(input.action)) return stickerFailure("input_invalid");
      const category = "category" in input ? normalizeCategory(input.category) : undefined;
      if (category !== undefined && (!category || category === "未分类")) return stickerFailure("sticker_classification_required");
      const guard = { signal: execution.abortSignal, stillAllowed: allowed };
      try {
        if (input.action === "move" || input.action === "delete") {
          if (!/^[a-f0-9]{64}$/.test(input.sticker_id)) return stickerFailure("sticker_id_invalid");
          if (input.action === "delete") {
            const removed = await store.deleteSticker(scopeKey, input.sticker_id, guard);
            return removed.removed ? { ok: true, id: input.sticker_id, ...removed, message: "已删除指定单张记录" } : stickerFailure("sticker_not_found");
          }
          const affected = await store.moveSticker(scopeKey, input.sticker_id, category!, guard);
          return affected ? { ok: true, id: input.sticker_id, category, affected, message: `已移动到分类：${category}` } : stickerFailure("sticker_not_found");
        }
        if (input.source_category === category) return stickerFailure("sticker_category_unchanged");
        const affected =
          input.action === "rename_category"
            ? await store.renameCategory(scopeKey, input.source_category, category!, guard)
            : await store.mergeCategories(scopeKey, input.source_category, category!, guard);
        return affected
          ? { ok: true, sourceCategory: input.source_category, category, affected, message: "已更新分类，当前查询已生效" }
          : stickerFailure("sticker_category_not_found");
      } catch (cause) {
        if (execution.abortSignal?.aborted) return stickerFailure("request_aborted", "unknown");
        if (!allowed()) return stickerFailure("sticker_capability_retired", "unknown");
        return errorCode(cause) === "sticker_not_found" ? stickerFailure("sticker_not_found") : stickerFailure("sticker_management_failed", "unknown");
      }
    },
  };

  return [
    // The plugin's capability guard removes sensitive management from group conversations.
    stealTool,
    manageTool,
    searchTool,
  ];
}

/**
 * Delivery-boundary guard for `send_message`.
 *
 * A bare `<sticker/>` element in message text would be turned into bytes without the exact-record admission or
 * the per-turn quota; stickers go out only as sticker parts. This returns a block reason for exactly that case
 * and never inspects unrelated payloads.
 */
export function stickerSendMessageBlockReason(input: unknown): string | undefined {
  const value = input as { messages?: unknown; verbatim?: unknown; parts?: unknown; mode?: unknown } | null;
  if (!value || value.mode === "raw") return undefined;
  const texts = [
    ...(Array.isArray(value.messages) ? value.messages : []),
    ...(Array.isArray(value.verbatim) ? value.verbatim : []),
    ...(Array.isArray(value.parts) ? value.parts.flatMap((part) => (part?.kind === "text" ? [part.text] : [])) : []),
  ];
  const restricted = (part: Part): boolean => {
    const element = partView(part);
    return element.type === "sticker" || element.children.some(restricted);
  };
  return texts.some((message) => typeof message === "string" && parseReply(message).some((segment) => segment.some(restricted)))
    ? "sticker_send_required"
    : undefined;
}

export { pickBestTaggedSticker } from "./tag-selection.js";
