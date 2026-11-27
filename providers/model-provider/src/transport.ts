import { createHash, randomUUID } from "node:crypto";

import {
  classifyModelFailure,
  consumeModelRetry,
  currentModelRequestContext,
  modelDiagnosticContext,
  modelDiagnosticId,
  type ModelFailure,
} from "@yesimbot/agent-runtime";
import { logger, systemClock, type Clock, type modelFetch } from "@yesimbot/foundation";

const MAX_ERROR_BYTES = 65536;

const MAX_COMPATIBILITY_ENTRIES = 128;

const log = logger("yesimbot.model-request");

export interface RequestDiagnostic {
  request: string;
  connection: string;
  attempt: number;
  bodyBytes: number;
  sections: Record<string, number>;
  /** A serialized-size heuristic, not the provider's tokenizer or image-token accounting. */
  estimatedTokens: { method: "serialized_bytes_div_4"; total: number; sections: Record<string, number> };
  largestMessage?: { index: number; bytes: number };
  largestToolResult?: { messageIndex: number; bytes: number };
  elapsedMs: number;
  status?: number;
  upstreamRequestId?: string;
  failure?: ModelFailure;
  compatibility?: "omit_usage_metadata";
  correlation?: Record<string, string>;
}

/** The only fallback omits SDK usage metadata after explicit upstream rejection. No general retries.
 * When called by the agent it consumes the same per-step budget as the SDK retry middleware. */
export function modelTransport(
  fetcher: typeof modelFetch,
  connection: string,
  observe?: (event: RequestDiagnostic) => void,
  clock: Clock = systemClock(),
): typeof modelFetch {
  const incompatible = new Set<string>();
  return async (url, options) => {
    if (typeof options?.body !== "string") return fetcher(url, options);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(options.body);
      if (!object(parsed)) return fetcher(url, options);
      body = parsed;
    } catch {
      return fetcher(url, options);
    }
    const inputUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const key = createHash("sha256")
      .update(`${inputUrl}\0${String(body.model ?? "")}`)
      .digest("hex");
    const context = currentModelRequestContext();
    const request = context?.requestId ?? randomUUID();
    const connectionId = modelDiagnosticId(connection);
    const emit = (event: RequestDiagnostic) => {
      try {
        observe?.(event);
      } catch {
        /* diagnostics never change execution */
      }
    };
    const usageOnly = object(body.stream_options) && body.stream_options.include_usage === true && Object.keys(body.stream_options).length === 1;
    let adapted = usageOnly && incompatible.has(key);
    if (adapted) delete body.stream_options;
    for (let attempt = 0; ; attempt++) {
      const payload = JSON.stringify(body),
        started = clock.now(),
        bodyBytes = Buffer.byteLength(payload);
      const base = { request, connection: connectionId, attempt, bodyBytes, ...measure(body, bodyBytes), correlation: modelDiagnosticContext(context) };
      let response: Response;
      try {
        response = await fetcher(url, { ...options, body: payload, redirect: "error" });
      } catch (error) {
        const kind = options.signal?.aborted ? "cancelled" : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
        emit({ ...base, elapsedMs: clock.now() - started, failure: kind });
        throw error;
      }
      const detail = response.ok ? { code: "", param: "", message: "" } : await errorDetail(response);
      const rejectsParameter = /(?:unknown|unsupported|unrecognized)\s+(?:request\s+)?(?:parameter|argument|field)|not supported|not allowed/i;
      const explicitlyRejected =
        (/^stream_options(?:\.include_usage)?$/.test(detail.param) && rejectsParameter.test(`${detail.code.replaceAll("_", " ")} ${detail.message}`)) ||
        /(?:unsupported|unknown|unrecognized|not supported|not allowed).{0,80}\bstream_options\b|\bstream_options\b.{0,80}(?:unsupported|unknown|unrecognized|not supported|not allowed)/i.test(
          detail.message,
        );
      const omit =
        attempt === 0 && [400, 422].includes(response.status) && usageOnly && body.stream_options !== undefined && explicitlyRejected && consumeModelRetry();
      const rawId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
      emit({
        ...base,
        elapsedMs: clock.now() - started,
        status: response.status,
        ...(rawId && /^[a-zA-Z0-9_.:-]{1,160}$/.test(rawId) ? { upstreamRequestId: rawId } : {}),
        ...(!response.ok ? { failure: classifyModelFailure(response.status, detail.code, detail.message) } : {}),
        ...(omit || adapted ? { compatibility: "omit_usage_metadata" as const } : {}),
      });
      if (!omit) return response;
      void response.body?.cancel().catch(() => {});
      if (incompatible.size >= MAX_COMPATIBILITY_ENTRIES) incompatible.delete(incompatible.values().next().value!);
      incompatible.add(key);
      delete body.stream_options;
      adapted = true;
    }
  };
}

/** Opt-in metadata-only logs. Raw labels, URLs, messages, images and credentials are excluded. */
export function diagnosticObserver(_connection: string): (event: RequestDiagnostic) => void {
  return (event) => {
    if (process.env.YESIMBOT_MODEL_DIAGNOSTICS === "1") log.info("model_request.diagnostic", { ...event });
  };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

function measure(body: Record<string, unknown>, bodyBytes: number) {
  const sections: Record<string, number> = {};
  for (const key of ["messages", "input", "contents", "system", "instructions", "tools", "generationConfig"]) {
    if (body[key] !== undefined) sections[key] = bytes(body[key]);
  }
  const messages = [body.messages, body.input, body.contents].find(Array.isArray) as unknown[] | undefined;
  let largestMessage: RequestDiagnostic["largestMessage"];
  let largestToolResult: RequestDiagnostic["largestToolResult"];
  messages?.forEach((message, index) => {
    const size = bytes(message);
    if (!largestMessage || size > largestMessage.bytes) largestMessage = { index, bytes: size };
    if (!object(message)) return;
    const outputs =
      message.role === "tool" || message.type === "function_call_output"
        ? [message]
        : Array.isArray(message.parts)
          ? message.parts.filter((part) => object(part) && part.functionResponse !== undefined)
          : Array.isArray(message.content)
            ? message.content.filter((part) => object(part) && part.type === "tool_result")
            : [];
    for (const output of outputs) {
      const outputBytes = bytes(output);
      if (!largestToolResult || outputBytes > largestToolResult.bytes) largestToolResult = { messageIndex: index, bytes: outputBytes };
    }
  });
  return {
    sections,
    estimatedTokens: {
      method: "serialized_bytes_div_4" as const,
      total: Math.ceil(bodyBytes / 4),
      sections: Object.fromEntries(Object.entries(sections).map(([key, size]) => [key, Math.ceil(size / 4)])),
    },
    ...(largestMessage ? { largestMessage } : {}),
    ...(largestToolResult ? { largestToolResult } : {}),
  };
}

async function errorDetail(response: Response): Promise<{ code: string; param: string; message: string }> {
  const empty = { code: "", param: "", message: "" };
  if (Number(response.headers.get("content-length") ?? 0) > MAX_ERROR_BYTES) return empty;
  const reader = response.clone().body?.getReader();
  if (!reader) return empty;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_ERROR_BYTES) return empty;
          chunks.push(part.value);
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const detail = object(parsed) && object(parsed.error) ? parsed.error : parsed;
        if (!object(detail)) return empty;
        return {
          code: [detail.code, detail.type, detail.status].filter((value) => typeof value === "string").join(" "),
          param: typeof detail.param === "string" ? detail.param : "",
          message: typeof detail.message === "string" ? detail.message : "",
        };
      })(),
      new Promise<typeof empty>((resolve) => {
        timer = setTimeout(() => resolve(empty), 1000);
      }),
    ]);
  } catch {
    return empty;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export { classifyModelFailure, type ModelFailure } from "@yesimbot/agent-runtime";
