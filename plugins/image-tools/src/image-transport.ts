import { APICallError } from "ai";
import { imageTransportFailure, type ImageTransportCode } from "koishi-plugin-yesimbot/kernel";

import { imageToolFailure, type ImageToolErrorCode, type ImageToolResult } from "./image-output.js";

/** The image tools' own model-facing code for each registered transport failure (their spec fixes what the model sees). */
const TOOL_CODES: Readonly<Record<ImageTransportCode, ImageToolErrorCode>> = {
  image_provider_failed: "provider_error",
  image_content_refused: "content_refused",
  image_result_empty: "empty_result",
  image_data_invalid: "invalid_image",
  image_too_large: "image_too_large",
};

/** Logs what a failed image request got back; the model only sees the error code. */
export type ImageFailureLog = (detail: string) => void;

/** The tool result for a provider's image failure, or `undefined` when `cause` is not one. */
export function transportToolFailure(cause: unknown): Extract<ImageToolResult, { ok: false }> | undefined {
  const failure = imageTransportFailure(cause);
  return failure && imageToolFailure(TOOL_CODES[failure.code], failure.retryable);
}

/** One line for the operator: the provider's status and message when known. */
export function describeImageFailure(cause: unknown): string {
  const failure = imageTransportFailure(cause);
  if (failure) return failure.detail ? `${failure.code}，${failure.detail}` : failure.code;
  const seen = new Set<unknown>();
  for (let current = cause; current && !seen.has(current); current = current instanceof Error ? current.cause : undefined) {
    seen.add(current);
    if (APICallError.isInstance(current)) {
      const message = (current.responseBody || current.message).replace(/\s+/g, " ").trim().slice(0, 300);
      const links: string[] = [];
      for (let under = current.cause, depth = 0; under instanceof Error && depth < 4; under = under.cause, depth++) {
        const code = (under as { code?: unknown }).code;
        links.push(` ← ${under.name}${typeof code === "string" ? `[${code}]` : ""}: ${under.message.slice(0, 160)}`);
      }
      return `${current.statusCode ? `HTTP ${current.statusCode}` : "没有收到响应"}：${message}${links.join("")}`;
    }
  }
  return cause instanceof Error ? `${cause.name}：${cause.message.slice(0, 300)}` : String(cause).slice(0, 300);
}

// Connection credentials and HTTP transports live in the model-provider package.
export type { ImageEditor, ImageEditRequest, ImageEditResponse } from "koishi-plugin-yesimbot/kernel";
