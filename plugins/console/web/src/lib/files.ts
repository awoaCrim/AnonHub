import type { FileListing, FileStat, UploadResult } from "../../../src/shared/files";
import { api, ApiError, notifyUnauthorized } from "./api";

const BASE = "/yesimbot/api/v1/files";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function listFiles(dir: string): Promise<FileListing> {
  return api<FileListing>(`${BASE}/list?dir=${encodeURIComponent(dir)}`);
}

export function statFile(path: string): Promise<FileStat> {
  return api<FileStat>(`${BASE}/stat?path=${encodeURIComponent(path)}`);
}

export function previewUrl(path: string, version?: number): string {
  return `${BASE}/preview?path=${encodeURIComponent(path)}${version ? `&v=${Math.round(version)}` : ""}`;
}

/** XHR instead of fetch so the slow tunnel can show upload progress. */
export function uploadFile(file: Blob & { name: string }, scope: string, onProgress?: (ratio: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const path = `${BASE}/upload?name=${encodeURIComponent(file.name)}&scope=${encodeURIComponent(scope)}`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress?.(event.loaded / event.total);
    xhr.onerror = () => reject(new ApiError(0, "network"));
    xhr.onload = () => {
      let data: { message?: unknown } | undefined;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) return resolve(data as unknown as UploadResult);
      if (xhr.status === 401) notifyUnauthorized(path);
      reject(new ApiError(xhr.status, typeof data?.message === "string" ? data.message : `http_${xhr.status}`));
    };
    xhr.send(file);
  });
}

export function fileError(error: unknown): string {
  if (!(error instanceof ApiError)) return "操作失败，请稍后重试。";
  return (
    {
      network: "网络连接中断，请重试。",
      too_large: `文件太大，最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB。`,
      outside_base: "只能访问 Koishi 数据目录内的文件。",
      not_found: "找不到这个位置。",
      invalid_upload: "上传失败，请重新选择文件。",
      empty_upload: "文件是空的。",
      owner_required: "只有所有者可以管理文件。",
    }[error.code] ?? "操作失败，请稍后重试。"
  );
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
