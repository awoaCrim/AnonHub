import type { LanguageModelMiddleware } from "ai";

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_PARTS = 16_384;

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;

type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

export class IncompleteModelStreamError extends Error {
  constructor() {
    super("Model response stream ended before finish");
    this.name = "IncompleteModelStreamError";
  }
}

/**
 * Keep an unfinished model step private so SDK request retries cannot replay tool effects or
 * publish duplicate deltas. Once committed (finish, provider effect, or buffer limit), the rest
 * is passed through and cannot be retried. Previous model steps are never involved.
 */
export async function bufferModelStream(result: StreamResult, signal?: AbortSignal): Promise<StreamResult> {
  const reader = result.stream.getReader();
  const buffered: StreamPart[] = [];
  let bytes = 0;
  let handedOff = false;
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  try {
    checkAbort();
    while (true) {
      const { done, value } = await reader.read();
      checkAbort();
      if (done) throw new IncompleteModelStreamError();
      if (value.type === "error") throw value.error;
      buffered.push(value);
      bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      const providerEffect =
        ("providerExecuted" in value && value.providerExecuted === true) || value.type === "tool-result" || value.type === "tool-approval-request";
      if (value.type !== "finish" && !providerEffect && bytes < MAX_BUFFER_BYTES && buffered.length < MAX_BUFFER_PARTS) continue;

      handedOff = true;
      let index = 0;
      return {
        ...result,
        stream: new ReadableStream<StreamPart>({
          async pull(controller) {
            try {
              checkAbort();
              if (index < buffered.length) {
                controller.enqueue(buffered[index++]!);
                if (index === buffered.length) buffered.length = 0;
                return;
              }
              const next = await reader.read();
              if (next.done) {
                reader.releaseLock();
                controller.close();
              } else {
                controller.enqueue(next.value);
              }
            } catch (error) {
              void reader.cancel(error).catch(() => undefined);
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        }),
      };
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!handedOff) void reader.cancel().catch(() => undefined);
  }
}
