const FILE_FAILURE_LABELS: Readonly<Record<FileFailureCode, string>> = {
  missing_source: "缺少下载地址",
  missing_filename: "缺少文件名",
  unsupported_type: "不支持的文件类型",
  file_limit: "数量超限",
  total_size_limit: "总大小超限",
  timeout: "读取超时",
  too_large: "文件过大",
  not_text: "不是有效文本",
  not_image: "不是有效图片",
  download_failed: "下载失败",
  save_failed: "保存失败",
};

export type FileFailureCode =
  | "missing_source"
  | "missing_filename"
  | "unsupported_type"
  | "file_limit"
  | "total_size_limit"
  | "timeout"
  | "too_large"
  | "not_text"
  | "not_image"
  | "download_failed"
  | "save_failed";

export function isFileFailureCode(value: unknown): value is FileFailureCode {
  return typeof value === "string" && Object.hasOwn(FILE_FAILURE_LABELS, value);
}

/** OneBot calls the filename `file`; other adapters use `title` or `name`. */
export function fileName(attrs: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["title", "name", "file"] as const) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim() && !/^(?:https?|data|base64|file):/i.test(value)) return value;
  }
  return undefined;
}

/** Preserve useful metadata, including for old unread files, without exposing transport URLs. */
export function formatFileFailure(value: unknown, filename: string | undefined): string {
  const reason = isFileFailureCode(value) ? `：${FILE_FAILURE_LABELS[value]}` : "";
  return `[文件：${filename ?? "未命名"}；未读取${reason}]`;
}
