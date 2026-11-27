import { AppError, defineErrors, errorEntry, isAbortError, toToolResult, type ToolFailure } from "@yesimbot/foundation";

export const SEARCH_ERRORS = defineErrors({
  search_request_failed: { model: "搜索服务请求失败，请稍后再试。", user: "搜索服务请求失败，请稍后再试。", status: 502, retryable: true },
  search_upstream_rejected: { model: "搜索服务拒绝了这次请求。", user: "搜索服务拒绝了这次请求。", status: 502 },
  search_rate_limited: { model: "搜索服务限制了请求频率，请稍后再试。", user: "搜索服务限制了请求频率，请稍后再试。", status: 429, retryable: true },
  search_keys_unavailable: {
    model: "Tavily 已配置的所有 API Key 额度均已用完或失效，请补充新的 Key 或稍后再试。",
    user: "Tavily 已配置的所有 API Key 额度均已用完或失效，请补充新的 Key 或稍后再试。",
    status: 503,
  },
  search_response_invalid: { model: "搜索服务返回的内容格式不对。", user: "搜索服务返回的内容格式不对。", status: 502 },
  search_extract_failed: { model: "这个网页没能提取出内容。", user: "这个网页没能提取出内容。", status: 502 },
  search_query_invalid: { model: "请给出公开对象的名称，长度 1 到 512 个字。", user: "搜索词不符合要求。", status: 400 },
  search_url_invalid: { model: "网址格式不对，或不是 http、https 开头。", user: "网址格式不对，或不是 http、https 开头。", status: 400 },
  search_image_url_invalid: { model: "图片地址不可用，请换一张候选图片。", user: "图片地址不可用。", status: 400 },
  search_image_unsafe_destination: { model: "图片所在的地址不允许访问，请换一张候选图片。", user: "图片所在的地址不允许访问。", status: 403 },
  search_image_dns_failed: { model: "图片所在的域名解析失败，请换一张候选图片。", user: "图片所在的域名解析失败。", status: 502 },
  search_image_too_many_redirects: { model: "图片地址跳转次数过多，请换一张候选图片。", user: "图片地址跳转次数过多。", status: 502 },
  search_image_timeout: { model: "图片下载超时，请换一张候选图片。", user: "图片下载超时。", status: 504, retryable: true },
  search_image_aborted: { model: "图片下载已取消。", user: "图片下载已取消。", status: 499 },
  search_image_download_failed: { model: "图片下载失败，请换一张候选图片。", user: "图片下载失败。", status: 502 },
  search_image_too_large: { model: "图片超过大小上限，请换一张候选图片。", user: "图片超过大小上限。", status: 413 },
  search_image_invalid: { model: "下载到的内容不是可用的 PNG、JPEG 或 WebP 图片。", user: "下载到的内容不是可用的图片。", status: 502 },
  search_image_input_unavailable: {
    model: "没能查看这张参考图。不要声称已经核实了身份，没有可靠候选时请向用户要图或请他澄清。",
    user: "没能查看这张参考图。",
    status: 503,
  },
  search_artifact_write_failed: { model: "参考图没能保存。不要声称已经核实了身份，请向用户要图或请他澄清。", user: "参考图没能保存。", status: 500 },
  search_blacklist_invalid: { model: "搜索结果过滤规则不是有效的正则表达式。", user: "搜索结果过滤规则不是有效的正则表达式。", status: 500 },
  search_config_invalid: { model: "搜索服务的配置不完整。", user: "搜索服务的配置不完整，请检查后端设置。", status: 500 },
});

const REFERENCE_CODES: Readonly<Record<string, ReferenceToolCode>> = {
  search_image_url_invalid: "invalid_url",
  search_image_unsafe_destination: "unsafe_destination",
  search_image_dns_failed: "dns_failed",
  search_image_too_many_redirects: "too_many_redirects",
  search_image_timeout: "timeout",
  search_image_aborted: "aborted",
  search_image_download_failed: "download_failed",
  search_image_too_large: "too_large",
  search_image_invalid: "invalid_image",
  search_image_input_unavailable: "image_input_unavailable",
  search_artifact_write_failed: "artifact_write_failed",
};

/** The reference import's own tool codes, which its spec fixes: the model sees these, not the registered ones. */
export type ReferenceToolCode =
  | "invalid_url"
  | "unsafe_destination"
  | "dns_failed"
  | "too_many_redirects"
  | "timeout"
  | "aborted"
  | "download_failed"
  | "too_large"
  | "invalid_image"
  | "image_input_unavailable"
  | "artifact_write_failed";

export type SearchToolFailure = ToolFailure & { readonly error: ToolFailure["error"] & { readonly code: "request_failed" | "invalid_query" } };

/** What a search tool returns beside `provider`, `query` and empty `results`: the registered sentence under the old tool code. */
export function searchFailure(error: unknown): SearchToolFailure {
  const result = toToolResult(error);
  const code = error instanceof AppError && error.code === "search_query_invalid" ? "invalid_query" : "request_failed";
  return { ...result, error: { ...result.error, code } };
}

/** A failure the import decided itself (bad input, no image input, an aborted call), under its spec'd tool code. */
export function referenceFailureFor(code: ReferenceToolCode, cause?: unknown) {
  const registered = Object.entries(REFERENCE_CODES).find(([, tool]) => tool === code)?.[0] ?? "search_image_input_unavailable";
  return referenceFailure(new AppError(registered, { effect: "none", ...(cause === undefined ? {} : { cause }) }));
}

/** The reference import's failure: its spec'd tool code with the registered sentence. */
export function referenceFailure(error: unknown): {
  ok: false;
  error: { code: ReferenceToolCode; message: string; retryable: boolean };
  effect: ToolFailure["effect"];
} {
  const result = toToolResult(error);
  const code = isAbortError(error)
    ? "aborted"
    : error instanceof AppError
      ? (REFERENCE_CODES[error.code] ?? "image_input_unavailable")
      : "image_input_unavailable";
  return { ...result, error: { ...result.error, code } };
}

/** The registered sentence the model reads for a code. */
export function modelText(code: keyof typeof SEARCH_ERRORS): string {
  return errorEntry(code)?.model ?? "";
}
