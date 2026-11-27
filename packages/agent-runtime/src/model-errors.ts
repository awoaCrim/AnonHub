import { APICallError } from "ai";

const tagged = new WeakMap<object, ModelFailureInfo>();

export type ModelFailure =
  | "authentication"
  | "permission"
  | "quota"
  | "context_limit"
  | "rate_limit"
  | "unavailable"
  | "invalid_request"
  | "invalid_response"
  | "network"
  | "timeout"
  | "cancelled";

export interface ModelFailureInfo {
  readonly kind: ModelFailure;
  readonly status?: number;
  readonly requestId?: string;
}

/** Classify privately; no provider prose, request data or credentials enter the public result. */
export function classifyModelFailure(status?: number, code = "", message = ""): ModelFailure {
  if (
    /context_length_exceeded|input_token_limit_exceeded|prompt_too_long|context_window_exceeded/.test(code) ||
    ((status === 400 || status === 413) &&
      /context (?:length|window)|too many (?:input )?tokens|prompt is too long|exceeds? (?:the )?(?:maximum|token)/i.test(message))
  )
    return "context_limit";
  if (status === 401 || code === "authentication_error" || code === "invalid_api_key") return "authentication";
  if (status === 403 || code === "permission_error") return "permission";
  if (
    status === 402 ||
    /insufficient_quota|quota_exceeded|billing_hard_limit_reached|credit_balance_too_low/.test(code) ||
    ((status === 400 || status === 429) && /insufficient (?:quota|credit|balance)|credit balance.*too low|billing hard limit/i.test(message))
  )
    return "quota";
  if (status === 429 || code === "rate_limit_error") return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status !== undefined && status >= 500 && status <= 599) return "unavailable";
  return status === undefined ? "network" : "invalid_request";
}

export function classifyModelError(error: unknown): ModelFailureInfo {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && object(error) && !seen.has(error); depth++) {
    seen.add(error);
    const saved = tagged.get(error);
    if (saved) return saved;
    if (APICallError.isInstance(error)) {
      const status = error.statusCode;
      let data: unknown = error.data;
      if (!data && error.responseBody && error.responseBody.length <= 65536) {
        try {
          data = JSON.parse(error.responseBody);
        } catch {
          /* not JSON */
        }
      }
      const detail = object(data) && object(data.error) ? data.error : data;
      const code = object(detail) ? [detail.code, detail.type, detail.status].filter((value) => typeof value === "string").join(" ") : "";
      const message = object(detail) && typeof detail.message === "string" ? detail.message : error.message;
      if (status !== undefined) return { kind: classifyModelFailure(status, code, message), status };
    }
    if (error.name === "AbortError" || error.name === "ResponseAborted") return { kind: "cancelled" };
    if (error.name === "TimeoutError" || error.code === "ETIMEDOUT" || (typeof error.code === "string" && /_TIMEOUT$/.test(error.code)))
      return { kind: "timeout" };
    if (typeof error.name === "string" && /(?:JSONParse|TypeValidation|InvalidResponseData|NoContentGenerated)/.test(error.name))
      return { kind: "invalid_response" };
    if (typeof error.name === "string" && /(?:UnsupportedFunctionality|InvalidArgument|InvalidPrompt|NoSuchModel|LoadSetting)/.test(error.name))
      return { kind: "invalid_request" };
    if (error.name === "AI_LoadAPIKeyError") return { kind: "authentication" };
    error = error.lastError ?? (Array.isArray(error.errors) ? error.errors.at(-1) : undefined) ?? error.cause;
  }
  return { kind: "network" };
}

/** Keep the SDK error identity and retry flags intact. */
export function markModelError<T>(error: T, requestId?: string): T | Error {
  const target = object(error) ? error : new Error("Model request failed");
  tagged.set(target, { ...classifyModelError(error), ...(requestId ? { requestId } : {}) });
  return target;
}

/** Only marked model failures (or SDK HTTP errors) receive the safe public summary. */
export function modelFailureInfo(error: unknown): ModelFailureInfo | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && object(error) && !seen.has(error); depth++) {
    seen.add(error);
    const info = tagged.get(error);
    if (info) return info;
    if (APICallError.isInstance(error)) return classifyModelError(error);
    error = error.lastError ?? (Array.isArray(error.errors) ? error.errors.at(-1) : undefined) ?? error.cause;
  }
}

export function modelFailureMessage(info: ModelFailureInfo): string {
  const messages: Record<ModelFailure, string> = {
    authentication: "模型认证失败，请检查密钥。",
    permission: "模型请求没有权限。",
    quota: "模型服务额度不足。",
    context_limit: "模型上下文超出限制。",
    rate_limit: "模型请求受到限流。",
    unavailable: "模型服务暂时不可用。",
    invalid_request: "模型服务拒绝了请求参数。",
    invalid_response: "模型服务返回了无效响应。",
    network: "模型服务连接失败。",
    timeout: "模型请求超时。",
    cancelled: "模型请求已取消。",
  };
  return `${messages[info.kind]} [${info.kind}${info.status === undefined ? "" : `:${info.status}`}]`;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
