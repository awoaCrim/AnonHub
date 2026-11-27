import { AppError, defineErrors } from "@yesimbot/foundation";

/** Resource reads, the channel's assets and artifacts, and video prepared for the model. */
export const RESOURCE_ERRORS = defineErrors({
  resource_uri_invalid: { model: "资源地址格式不对，或者这个地址不允许读取。", user: "资源地址格式不对。", status: 400 },
  resource_unavailable: { model: "现在读不到这个资源。", user: "现在读不到这个资源。", status: 503 },
  resource_not_found: { model: "找不到这个资源。", user: "找不到这个资源。", status: 404 },
  resource_timeout: { model: "读取资源超时。", user: "读取资源超时。", status: 504, retryable: true },
  resource_read_aborted: { model: "读取已取消。", user: "读取已取消。", status: 499 },
  resource_too_large: { model: "资源超过大小上限，没有读取。", user: "资源超过大小上限。", status: 413 },
  resource_not_video: { model: "这个资源不是可读取的视频。", user: "这个资源不是可读取的视频。", status: 415 },
  resource_not_image: { model: "这个资源不是可读取的图片。", user: "这个资源不是可读取的图片。", status: 415 },
  resource_read_failed: { model: "读取资源失败。", user: "读取资源失败。", status: 500 },
  resource_delivery_restricted: { model: "这个资源不能发送。", user: "这个资源不能发送。", status: 403 },
  resource_scheme_reserved: { model: "这个资源地址前缀由 Core 保留。", user: "这个资源地址前缀由 Core 保留。", status: 500 },
  asset_data_invalid: { model: "素材数据必须是字节。", user: "素材数据必须是字节。", status: 500 },
  asset_id_invalid: { model: "素材编号格式不对。", user: "素材编号格式不对。", status: 400 },
  asset_prefix_ambiguous: { model: "这个素材编号前缀对应了多个素材。", user: "这个素材编号前缀对应了多个素材。", status: 400 },
  artifact_uri_invalid: { model: "制品地址格式不对。", user: "制品地址格式不对。", status: 400 },
  artifact_not_found: { model: "找不到这个制品。", user: "找不到这个制品。", status: 404 },
  artifact_data_invalid: { model: "制品数据必须是字节。", user: "制品数据必须是字节。", status: 500 },
  artifact_metadata_invalid: { model: "制品的元数据无效。", user: "制品的元数据无效。", status: 500 },
  video_compression_unavailable: { model: "视频压缩工具不可用。", user: "视频压缩工具不可用。", status: 503 },
  video_compression_failed: { model: "视频压缩失败。", user: "视频压缩失败。", status: 500 },
  video_compression_timeout: { model: "视频压缩超时。", user: "视频压缩超时。", status: 504, retryable: true },
});

const READ_CODES: ReadonlySet<string> = new Set<ResourceReadErrorCode>([
  RESOURCE_ERRORS.resource_uri_invalid,
  RESOURCE_ERRORS.resource_unavailable,
  RESOURCE_ERRORS.resource_not_found,
  RESOURCE_ERRORS.resource_timeout,
  RESOURCE_ERRORS.resource_read_aborted,
  RESOURCE_ERRORS.resource_too_large,
  RESOURCE_ERRORS.resource_not_video,
  RESOURCE_ERRORS.resource_not_image,
  RESOURCE_ERRORS.resource_read_failed,
  RESOURCE_ERRORS.resource_delivery_restricted,
]);

const VIDEO_CODES: ReadonlySet<string> = new Set<VideoCompressionErrorCode>([
  RESOURCE_ERRORS.video_compression_unavailable,
  RESOURCE_ERRORS.video_compression_failed,
  RESOURCE_ERRORS.video_compression_timeout,
  RESOURCE_ERRORS.resource_read_aborted,
  RESOURCE_ERRORS.resource_too_large,
]);

/** What a resource read can fail with; readers registered by plugins throw these too. */
export type ResourceReadErrorCode =
  | typeof RESOURCE_ERRORS.resource_uri_invalid
  | typeof RESOURCE_ERRORS.resource_unavailable
  | typeof RESOURCE_ERRORS.resource_not_found
  | typeof RESOURCE_ERRORS.resource_timeout
  | typeof RESOURCE_ERRORS.resource_read_aborted
  | typeof RESOURCE_ERRORS.resource_too_large
  | typeof RESOURCE_ERRORS.resource_not_video
  | typeof RESOURCE_ERRORS.resource_not_image
  | typeof RESOURCE_ERRORS.resource_read_failed
  | typeof RESOURCE_ERRORS.resource_delivery_restricted;

export type VideoCompressionErrorCode =
  | typeof RESOURCE_ERRORS.video_compression_unavailable
  | typeof RESOURCE_ERRORS.video_compression_failed
  | typeof RESOURCE_ERRORS.video_compression_timeout
  | typeof RESOURCE_ERRORS.resource_read_aborted
  | typeof RESOURCE_ERRORS.resource_too_large;

/** A failed resource read. No side effect happened: reads never change anything. */
export function resourceError(
  code: ResourceReadErrorCode | VideoCompressionErrorCode,
  options: { readonly cause?: unknown; readonly detail?: string } = {},
): AppError {
  return new AppError(code, { ...options, effect: "none" });
}

/**
 * The read failure `cause` is, if it is one. Matched by name and code rather than `instanceof`, so an error from another
 * loaded copy of Core (a plugin's own build) still counts.
 */
export function resourceErrorCode(cause: unknown): ResourceReadErrorCode | undefined {
  return appErrorCode(cause, READ_CODES) as ResourceReadErrorCode | undefined;
}

export function videoCompressionErrorCode(cause: unknown): VideoCompressionErrorCode | undefined {
  return appErrorCode(cause, VIDEO_CODES) as VideoCompressionErrorCode | undefined;
}

function appErrorCode(cause: unknown, codes: ReadonlySet<string>): string | undefined {
  if (!(cause instanceof Error) || cause.name !== "AppError") return undefined;
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === "string" && codes.has(code) ? code : undefined;
}
