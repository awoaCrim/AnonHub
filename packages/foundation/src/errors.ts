import { redact } from "./redact.js";

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const CJK = /[㐀-鿿]/;
const DIAGNOSTIC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const catalog = new Map<string, ErrorEntry>();

// Registered after the catalog exists; an exported constant here would have to come first and see it uninitialized.
const FOUNDATION_ERRORS = defineErrors({
  internal_error: { model: "内部错误，操作没有完成。", user: "内部错误，操作没有完成。", status: 500 },
  request_aborted: { model: "操作已取消。", user: "操作已取消。", status: 499 },
  input_invalid: { model: "参数不符合要求，请修正后重试。", user: "填写的内容不符合要求。", status: 400 },
  data_invalid: { model: "数据文件格式无法识别，已停止加载。", user: "数据文件格式无法识别，已停止加载，原文件已保留。", status: 500 },
  file_changed: { model: "文件已被其他操作修改，请重新读取后再改。", user: "文件已被其他操作修改，请刷新后再试。", status: 409 },
  file_too_large: { model: "文件超过大小上限。", user: "文件超过大小上限。", status: 413 },
  file_not_private: { model: "文件权限不安全，已拒绝读取。", user: "文件权限不安全，已拒绝读取。", status: 500 },
  path_outside_root: { model: "路径超出允许的目录。", user: "路径超出允许的目录。", status: 400 },
  path_is_link: { model: "路径包含符号链接，已拒绝。", user: "路径包含符号链接，已拒绝。", status: 400 },
  path_missing: { model: "路径不存在。", user: "路径不存在。", status: 404 },
  path_hardlinked: { model: "文件有多个硬链接，已拒绝。", user: "文件有多个硬链接，已拒绝。", status: 400 },
  png_invalid: { model: "PNG 文件已损坏或格式不对。", user: "PNG 文件已损坏或格式不对。", status: 400 },
  lock_held: { model: "数据正被另一个进程使用。", user: "数据正被另一个进程使用。", status: 409 },
  time_zone_invalid: { model: "时区配置无效。", user: "时区配置无效。", status: 500 },
  network_url_invalid: { model: "网址无效或协议不允许。", user: "网址无效或协议不允许。", status: 400 },
  network_destination_blocked: { model: "目标地址不允许访问。", user: "目标地址不允许访问。", status: 403 },
  network_dns_failed: { model: "域名解析失败。", user: "域名解析失败。", status: 502, retryable: true },
  network_too_many_redirects: { model: "跳转次数过多，已停止。", user: "跳转次数过多，已停止。", status: 502 },
  network_timeout: { model: "请求超时。", user: "请求超时。", status: 504, retryable: true },
  network_response_too_large: { model: "响应超过大小上限。", user: "响应超过大小上限。", status: 502 },
  network_failed: { model: "网络请求失败。", user: "网络请求失败。", status: 502, retryable: true },
});

/** The codes the foundation itself throws. */
export type FoundationErrorCode = keyof typeof FOUNDATION_ERRORS;

/** `none`: nothing happened outside; `unknown`: it may have; `done`: it did. */
export type ErrorEffect = "none" | "unknown" | "done";

/** One catalog row: what the model reads, what a person reads, and the HTTP status. */
export interface ErrorEntry {
  readonly model: string;
  readonly user: string;
  readonly status: number;
  readonly retryable?: boolean;
}

export interface AppErrorOptions {
  readonly cause?: unknown;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly effect?: ErrorEffect;
  /** Goes to logs only, after redaction. */
  readonly detail?: string;
  /** A server's own wait hint (for example Retry-After), in milliseconds. */
  readonly retryAfterMs?: number;
}

export interface ToolFailure {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
  readonly effect: ErrorEffect;
}

export interface ErrorFields {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
  readonly detail?: string;
  readonly causes?: string[];
}

/** The one error type. A caught error that is thrown again keeps it as `cause`. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly effect: ErrorEffect;
  readonly detail?: string;
  readonly retryAfterMs?: number;

  constructor(code: string, options: AppErrorOptions = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    const entry = catalog.get(code);
    this.code = code;
    this.status = options.status ?? entry?.status ?? 500;
    this.retryable = options.retryable ?? entry?.retryable ?? false;
    this.effect = options.effect ?? "unknown";
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Registers error codes. Each code is snake_case with a domain prefix and appears once in the whole process; both texts
 * are Chinese. Returns the codes so callers can refer to them without retyping strings.
 */
export function defineErrors<const T extends Record<string, ErrorEntry>>(entries: T): { readonly [K in keyof T]: K } {
  const codes = {} as Record<string, string>;
  for (const [code, entry] of Object.entries(entries)) {
    if (!CODE.test(code)) throw new Error(`error code must be snake_case with a domain prefix: ${code}`);
    if (!CJK.test(entry.model) || !CJK.test(entry.user)) throw new Error(`error texts must be Chinese: ${code}`);
    if (!Number.isInteger(entry.status) || entry.status < 400 || entry.status > 599) throw new Error(`error status must be 4xx or 5xx: ${code}`);
    // The same module loaded twice (its source and its build in one test run) registers the same rows again; only a
    // different row under a taken code is a conflict.
    const existing = catalog.get(code);
    if (existing && !sameEntry(existing, entry)) throw new Error(`error code registered twice: ${code}`);
    if (!existing) catalog.set(code, Object.freeze({ ...entry }));
    codes[code] = code;
  }
  return Object.freeze(codes) as { readonly [K in keyof T]: K };
}

export function errorEntry(code: string): ErrorEntry | undefined {
  return catalog.get(code);
}

export function registeredErrorCodes(): string[] {
  return [...catalog.keys()];
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** What a tool returns to the model. Unregistered codes and foreign errors read as `internal_error`. */
export function toToolResult(error: unknown): ToolFailure {
  if (isAbortError(error)) return failure("request_aborted", false, "unknown");
  if (error instanceof AppError && catalog.has(error.code)) return failure(error.code, error.retryable, error.effect);
  return failure("internal_error", false, error instanceof AppError ? error.effect : "unknown");
}

/** What the console API returns: a status and a registered code, never error text. */
export function toHttp(error: unknown): { status: number; body: { code: string } } {
  if (isAbortError(error)) return { status: 499, body: { code: "request_aborted" } };
  if (error instanceof AppError && catalog.has(error.code)) return { status: error.status, body: { code: error.code } };
  return { status: 500, body: { code: "internal_error" } };
}

/** What a chat shows: the fixed Chinese sentence, the code and a diagnostic ID (the `tasks/failure.ts` format). */
export function toChatText(error: unknown, diagnosticId?: string): string {
  const code = isAbortError(error) ? "request_aborted" : error instanceof AppError && catalog.has(error.code) ? error.code : "internal_error";
  const id = diagnosticId && DIAGNOSTIC_ID.test(diagnosticId) ? ` 诊断编号：${diagnosticId}` : "";
  return `${catalog.get(code)!.user} [${code}]${id}`;
}

/** The only way an error enters a log: name, code, redacted and truncated message, detail and cause chain. */
export function errorFields(cause: unknown): ErrorFields {
  const fields: { name: string; code?: string; message: string; detail?: string; causes?: string[] } = describe(cause, 500);
  if (cause instanceof AppError && cause.detail) fields.detail = redact(cause.detail).slice(0, 1000);
  const causes: string[] = [];
  const seen = new Set<unknown>([cause]);
  let next = cause instanceof Error ? cause.cause : undefined;
  while (next !== undefined && causes.length < 5 && !seen.has(next)) {
    seen.add(next);
    const item = describe(next, 300);
    causes.push(`${item.name}${item.code ? `[${item.code}]` : ""}: ${item.message}`);
    next = next instanceof Error ? next.cause : undefined;
  }
  if (causes.length) fields.causes = causes;
  return fields;
}

function failure(code: string, retryable: boolean, effect: ErrorEffect): ToolFailure {
  return { ok: false, error: { code, message: catalog.get(code)!.model, retryable }, effect };
}

function describe(value: unknown, limit: number): { name: string; code?: string; message: string } {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, ...(typeof code === "string" && code ? { code } : {}), message: redact(value.message).slice(0, limit) };
  }
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return { name: typeof value, message: redact(text).slice(0, limit) };
}

function sameEntry(left: ErrorEntry, right: ErrorEntry): boolean {
  return left.model === right.model && left.user === right.user && left.status === right.status && (left.retryable ?? false) === (right.retryable ?? false);
}
