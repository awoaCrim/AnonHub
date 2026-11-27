import { spawn } from "node:child_process";

/** A still copy only has to let a model see the picture; nothing needs more than this on the longest side. */
const MAX_SIDE = 2048;
const DEMUXERS = { "image/png": "png_pipe", "image/jpeg": "jpeg_pipe", "image/webp": "webp_pipe", "image/gif": "gif" } as const;

/** What a model route that takes only PNG and JPEG needs converted. */
export type StillConvertible = "image/webp" | "image/gif";

export type StillImageType = keyof typeof DEMUXERS;

export interface StillImageOptions {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export function isStillConvertible(mediaType: string | undefined): mediaType is StillConvertible {
  return mediaType === "image/webp" || mediaType === "image/gif";
}

/**
 * The first frame of a WebP or GIF as PNG, through the FFmpeg the runtime image ships, for a model route that takes
 * only PNG and JPEG (Gemini through the gateway on ssh1, 2026-11-24). Undefined when FFmpeg is missing, fails, runs out
 * of time or writes more than `maxBytes`; an animated WebP fails with FFmpeg 4.4.
 */
export function firstFrameToPng(bytes: Uint8Array, mediaType: StillConvertible, options: StillImageOptions): Promise<Uint8Array | undefined> {
  return stillImageToPng(bytes, mediaType, { ...options, maxSide: MAX_SIDE });
}

/** A PNG, JPEG, WebP or GIF (its first frame) as PNG no larger than `maxSide` on either side, through FFmpeg. */
export function stillImageToPng(
  bytes: Uint8Array,
  mediaType: StillImageType,
  { maxBytes, timeoutMs, signal, maxSide }: StillImageOptions & { readonly maxSide: number },
): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-f",
        DEMUXERS[mediaType],
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Uint8Array | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(value);
    };
    function stop() {
      child.kill("SIGKILL");
      finish(undefined);
    }
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", () => finish(undefined));
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) return stop();
      chunks.push(chunk);
    });
    child.on("close", (code) => finish(code === 0 && total > 0 ? new Uint8Array(Buffer.concat(chunks, total)) : undefined));
    child.stdin.end(bytes);
  });
}
