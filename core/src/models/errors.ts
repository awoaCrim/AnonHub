import { AppError, defineErrors } from "@yesimbot/foundation";

/** Model lookup, the auxiliary model, and image generation through a provider. */
export const MODEL_ERRORS = defineErrors({
  model_id_invalid: { model: "模型 ID 格式不对。", user: "模型 ID 格式不对。", status: 400 },
  model_provider_not_found: { model: "找不到这个模型供应商。", user: "找不到这个模型供应商，检查模型设置。", status: 404 },
  model_provider_duplicate: { model: "模型供应商重复登记。", user: "模型供应商重复登记。", status: 500 },
  model_capability_unsupported: { model: "这个模型供应商不支持这种用法。", user: "这个模型供应商不支持这种用法。", status: 400 },
  model_not_found: { model: "找不到这个模型。", user: "找不到这个模型，检查模型设置。", status: 404 },
  model_auxiliary_missing: { model: "没有配置辅助模型。", user: "没有配置辅助模型，在模型设置里选一个。", status: 503 },
  model_auxiliary_invalid: { model: "辅助模型的 ID 格式不对。", user: "辅助模型的 ID 格式不对，检查模型设置。", status: 503 },
  model_auxiliary_provider_unavailable: { model: "辅助模型的供应商不可用。", user: "辅助模型的供应商不可用，检查模型设置。", status: 503 },
  model_auxiliary_unresolvable: { model: "辅助模型现在用不了。", user: "辅助模型现在用不了，检查模型设置。", status: 503 },
  image_provider_failed: { model: "生图服务出错了。", user: "生图服务出错了。", status: 502 },
  image_content_refused: { model: "生图服务拒绝了这次请求的内容。", user: "生图服务拒绝了这次请求的内容。", status: 422 },
  image_result_empty: { model: "生图服务没有返回图片。", user: "生图服务没有返回图片。", status: 502 },
  image_data_invalid: { model: "生图服务返回的图片数据无效。", user: "生图服务返回的图片数据无效。", status: 502 },
  image_too_large: { model: "图片超过大小上限。", user: "图片超过大小上限。", status: 413 },
});

const IMAGE_CODES: ReadonlySet<string> = new Set<ImageTransportCode>([
  MODEL_ERRORS.image_provider_failed,
  MODEL_ERRORS.image_content_refused,
  MODEL_ERRORS.image_result_empty,
  MODEL_ERRORS.image_data_invalid,
  MODEL_ERRORS.image_too_large,
]);

/** How an image request to a provider failed. */
export type ImageTransportCode =
  | typeof MODEL_ERRORS.image_provider_failed
  | typeof MODEL_ERRORS.image_content_refused
  | typeof MODEL_ERRORS.image_result_empty
  | typeof MODEL_ERRORS.image_data_invalid
  | typeof MODEL_ERRORS.image_too_large;

export interface ImageTransportFailure {
  readonly code: ImageTransportCode;
  readonly retryable: boolean;
  /** What the provider said, for the operator's log only (status and a short message); never shown to the model. */
  readonly detail?: string;
}

/** A failed image request; the upstream may already have produced (and billed) a picture, so the effect is unknown. */
export function imageTransportError(code: ImageTransportCode, retryable: boolean, detail?: string): AppError {
  return new AppError(code, { retryable, effect: "unknown", ...(detail === undefined ? {} : { detail }) });
}

/** The image failure `cause` is, matched by name and code so another loaded copy of Core still counts. */
export function imageTransportFailure(cause: unknown): ImageTransportFailure | undefined {
  if (!(cause instanceof Error) || cause.name !== "AppError") return undefined;
  const { code, retryable, detail } = cause as { code?: unknown; retryable?: unknown; detail?: unknown };
  if (typeof code !== "string" || !IMAGE_CODES.has(code)) return undefined;
  return { code: code as ImageTransportCode, retryable: retryable === true, ...(typeof detail === "string" ? { detail } : {}) };
}
