import type { GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ImageModelV3 } from "@ai-sdk/provider";
import { APICallError, generateImage, NoImageGeneratedError } from "ai";
import { imageTransportError, MODEL_ERRORS, modelFetch, type ImageEditor, type ImageModelAdapter } from "koishi-plugin-yesimbot/kernel";

/** Gemini sizes by aspect ratio: the tools' pixel sizes become their ratios. */
const ASPECT_RATIOS: Readonly<Record<string, `${number}:${number}`>> = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3" };

export interface OpenAIImageConnection {
  readonly baseURL?: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** The Images protocol is independent of the connection's chat/responses format. */
export function createOpenAIImageAdapter(options: OpenAIImageConnection): ImageModelAdapter {
  const client = createOpenAI({ apiKey: options.apiKey, baseURL: options.baseURL, fetch: options.fetch ?? modelFetch });
  return { model: client.image(options.modelId), edit: createOpenAIImageEditor(options) };
}

export function createOpenAIImageEditor(options: OpenAIImageConnection): ImageEditor {
  const endpoint = `${(options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/images/edits`;
  const fetch = options.fetch ?? modelFetch;
  return async ({ sourceDataUrls, prompt, size, abortSignal, maxBytes }) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw imageTransportError(MODEL_ERRORS.image_too_large, false);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.modelId,
        prompt,
        images: sourceDataUrls.map((image_url) => ({ image_url })),
        ...(size ? { size } : {}),
        n: 1,
        response_format: "b64_json",
      }),
      signal: abortSignal,
    });
    const maxResponseBytes = Math.ceil(maxBytes / 3) * 4 + 65_536;
    const text = await readBoundedResponseText(response, maxResponseBytes);
    if (!response.ok) {
      if (containsContentRefusal(text)) throw imageTransportError(MODEL_ERRORS.image_content_refused, false);
      throw imageTransportError(MODEL_ERRORS.image_provider_failed, response.status === 429 || response.status >= 500, failureDetail(response.status, text));
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw imageTransportError(MODEL_ERRORS.image_provider_failed, false);
    }
    const data = isRecord(value) && Array.isArray(value.data) ? value.data : [];
    if (data.length === 0) throw imageTransportError(MODEL_ERRORS.image_result_empty, true);
    const encoded = readImageBase64(data[0]);
    const bytes = decodeBase64(encoded, maxBytes);
    return { images: [{ uint8Array: bytes }], totalImages: data.length };
  };
}

/**
 * Images follow the connection's endpoint like chat does (user, 2026-11-23: 「图片也需要看端点」): a Gemini endpoint
 * generates and edits with Gemini's own `generateContent` (image output; sources and references as image parts),
 * never the OpenAI Images body a gateway may forward to Gemini unconverted (a 400 with an empty upstream body).
 */
export function createGoogleImageAdapter(client: Pick<GoogleGenerativeAIProvider, "image">, modelId: string): ImageModelAdapter {
  const model = withAspectRatio(client.image(modelId));
  return { model, edit: createGoogleImageEditor(model) };
}

function aspectRatioFor(size: string | undefined): `${number}:${number}` | undefined {
  if (!size) return undefined;
  const known = ASPECT_RATIOS[size];
  if (known) return known;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return undefined;
  const width = Number(match[1]),
    height = Number(match[2]);
  const divisor = gcd(width, height);
  return divisor ? `${width / divisor}:${height / divisor}` : undefined;
}

function gcd(left: number, right: number): number {
  return right ? gcd(right, left % right) : left;
}

function withAspectRatio(model: ImageModelV3): ImageModelV3 {
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    maxImagesPerCall: model.maxImagesPerCall,
    doGenerate: ({ size, aspectRatio, ...options }) => model.doGenerate({ ...options, size: undefined, aspectRatio: aspectRatio ?? aspectRatioFor(size) }),
  };
}

/**
 * The request never completed on the wire: no response, or a 200 whose body broke off while it was read (the SDK's
 * "Failed to process successful response"). Two selfies failed this way in the bot on 2026-11-24 while the same
 * request succeeded five times outside it; the cause was not found, so it is retried once.
 */
function interrupted(cause: APICallError): boolean {
  return cause.statusCode === undefined || (cause.statusCode >= 200 && cause.statusCode < 300);
}

function createGoogleImageEditor(model: ImageModelV3): ImageEditor {
  return async ({ sourceDataUrls, prompt, size, abortSignal, maxBytes }) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw imageTransportError(MODEL_ERRORS.image_too_large, false);
    let result: Awaited<ReturnType<typeof generateImage>> | undefined;
    for (let attempt = 0; !result; attempt++) {
      try {
        result = await generateImage({
          model,
          prompt: { text: prompt, images: [...sourceDataUrls] },
          n: 1,
          size: size as `${number}x${number}` | undefined,
          maxRetries: 0,
          abortSignal,
        });
      } catch (cause) {
        if (NoImageGeneratedError.isInstance(cause)) throw imageTransportError(MODEL_ERRORS.image_result_empty, true);
        if (!APICallError.isInstance(cause)) throw cause;
        if (containsContentRefusal(cause.responseBody ?? cause.message)) throw imageTransportError(MODEL_ERRORS.image_content_refused, false);
        if (interrupted(cause) && attempt === 0 && !abortSignal?.aborted) continue;
        throw imageTransportError(
          MODEL_ERRORS.image_provider_failed,
          cause.isRetryable || interrupted(cause),
          `${attempt ? "重试后仍失败，" : ""}${failureDetail(cause.statusCode, cause.responseBody || cause.message)}${causeChain(cause.cause)}`,
        );
      }
    }
    const image = result.images[0];
    if (!image) throw imageTransportError(MODEL_ERRORS.image_result_empty, true);
    if (image.uint8Array.byteLength > maxBytes) throw imageTransportError(MODEL_ERRORS.image_too_large, false);
    return { images: [{ uint8Array: image.uint8Array }], totalImages: result.images.length };
  };
}

/** What lay under the SDK's error (a socket closed, a body that stopped), as ` ← name[code]: message` links. */
function causeChain(cause: unknown): string {
  const links: string[] = [];
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    links.push(`${current.name}${typeof code === "string" ? `[${code}]` : ""}: ${current.message.slice(0, 160)}`);
  }
  return links.map((link) => ` ← ${link}`).join("");
}

/** Status and the start of the provider's message, on one line, for the operator's log. */
function failureDetail(status: number | undefined, text: string | undefined): string {
  const message = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return `${status ? `HTTP ${status}` : "没有收到响应"}${message ? `：${message}` : ""}`;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw imageTransportError(MODEL_ERRORS.image_too_large, false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function readImageBase64(value: unknown): string {
  if (!isRecord(value)) throw imageTransportError(MODEL_ERRORS.image_data_invalid, true);
  if (typeof value.b64_json === "string" && value.b64_json.length > 0) return value.b64_json;
  if (typeof value.url === "string") {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i.exec(value.url);
    if (match?.[1]) return match[1];
  }
  throw imageTransportError(MODEL_ERRORS.image_result_empty, true);
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) throw imageTransportError(MODEL_ERRORS.image_too_large, false);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw imageTransportError(MODEL_ERRORS.image_data_invalid, true);
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.byteLength > maxBytes) throw imageTransportError(MODEL_ERRORS.image_too_large, false);
  return bytes;
}

function containsContentRefusal(value: string): boolean {
  return /content[ _-]?policy|safety|moderation|refus(?:e|ed|al)|blocked|disallowed|unsafe/i.test(value.slice(0, 4096));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
