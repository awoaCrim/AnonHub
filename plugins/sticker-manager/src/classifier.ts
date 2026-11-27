import { errorFields, logger } from "@yesimbot/foundation";
import { generateText, type LanguageModel } from "ai";

import { firstFrameToPng } from "./frames.js";
import { normalizeCategory, type StickerConfig } from "./types.js";

/** Administrator reclassification prompt; `{{categories}}` is replaced with the current category list. */
const CLASSIFICATION_PROMPT = [
  "请对以下表情包进行分类，已有分类：[{{categories}}]。",
  "选择最匹配的分类或创建新类别。只返回分类名称。",
  "分类应基于可能的使用语境，避免模糊不清的名称。",
  "若不确定，请思考此表情包的具体使用场景后再分类。",
].join("");

/** The auxiliary model the host resolves; it throws when none is configured. */
export type ResolveClassifierModel = () => { readonly model: LanguageModel; readonly entry: { readonly modalities?: { readonly input?: readonly string[] } } };

export interface ClassifyInput {
  bytes: Uint8Array;
  mediaType: string;
  categories: string[];
  signal?: AbortSignal;
}

export interface ClassifyResult {
  category?: string;
  tags?: string[];
}

export interface StickerClassifier {
  classify(input: ClassifyInput): Promise<ClassifyResult | undefined>;
}

export class ModelStickerClassifier implements StickerClassifier {
  private readonly logger = logger("yesimbot.sticker-manager");

  public constructor(
    private readonly resolveModel: ResolveClassifierModel,
    private readonly config: StickerConfig,
  ) {}

  public async classify(input: ClassifyInput): Promise<ClassifyResult | undefined> {
    let ref;
    try {
      ref = this.resolveModel();
    } catch (cause) {
      this.logger.warn("sticker_classifier.model_unavailable", { route: "auxiliary", purpose: "utility", ...errorFields(cause) });
      return undefined;
    }

    if (!ref.entry.modalities?.input?.includes("image")) return undefined;

    const basePrompt = CLASSIFICATION_PROMPT.replaceAll("{{categories}}", input.categories.join(", ") || "暂无分类");
    const prompt = this.config.tagMode
      ? [
          basePrompt,
          '同时返回一个 JSON 对象：{"category":"分类名","tags":["标签1","标签2"]}',
          "category 只返回一个分类；tags 返回 1-16 个简短标签，可以包含 category。不要输出其他内容。",
        ].join("\n")
      : basePrompt;
    const frame = input.mediaType === "image/gif" ? firstFrameToPng(input.bytes) : undefined;

    try {
      const { text } = await generateText({
        model: ref.model,
        temperature: 0.2,
        maxRetries: 0,
        abortSignal: input.signal,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "file", data: frame?.bytes ?? input.bytes, mediaType: frame?.mediaType ?? input.mediaType },
            ],
          },
        ],
      });
      return parseClassification(text, this.config.tagMode);
    } catch (cause) {
      this.logger.warn("sticker_classifier.call_failed", { ...errorFields(cause) });
      return undefined;
    }
  }
}

function parseClassification(text: string, tagMode: boolean): ClassifyResult {
  const fallbackCategory = normalizeCategory(text) || undefined;
  if (!tagMode) return { category: fallbackCategory, tags: [] };

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as { category?: unknown; tags?: unknown };
    const category = typeof parsed.category === "string" ? normalizeCategory(parsed.category) : undefined;
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags
          .filter((tag): tag is string => typeof tag === "string")
          .map(normalizeCategory)
          .filter((tag) => tag.length > 0)
      : [];
    return { category, tags };
  } catch {
    return { category: fallbackCategory, tags: [] };
  }
}
