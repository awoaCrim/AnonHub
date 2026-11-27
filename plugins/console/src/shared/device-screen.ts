/**
 * The live screen (`GET /devices/screen/stream`): one long response of records, each
 * `[u32 big-endian header length][UTF-8 JSON header][image bytes, header.size of them]`.
 * A frame is sent only when the picture changed; `alive` keeps an idle stream open; `end` asks the
 * browser to reconnect (the server re-checks the login then).
 */
export const SCREEN_STREAM_TYPE = "application/x-yesimbot-screen-stream";

const MAX_HEADER_BYTES = 4096;

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** `update_required`: the computer's client predates screen view (it would keep every screenshot forever). */
export type ScreenUnavailableReason = "offline" | "no_desktop" | "no_browser" | "not_ready" | "update_required";

/** `?source=browser` shows the tab of the bot's own browser; the default is the desktop. */
export type ScreenViewSource = "desktop" | "browser";

export type DeviceScreenError =
  | { message: "screen_unavailable"; reason: ScreenUnavailableReason }
  | { message: "not_found" | "device_connection_unavailable" | "screen_timeout" | "invalid_device" | "invalid_source" }
  | { message: "login_required" | "owner_required" | "same_origin_required" };

export type DeviceActivityError = { message: "invalid_device" | "invalid_limit" | "login_required" | "owner_required" | "same_origin_required" };

export type ScreenStreamHeader =
  | { type: "frame"; mediaType: "image/png" | "image/jpeg"; size: number; capturedAt: number; width?: number; height?: number; scaleFactor?: number }
  | { type: "problem"; status: number; body: DeviceScreenError }
  | { type: "alive"; capturedAt?: number }
  | { type: "end" };

/** Browser-only DTOs: screen success is binary, with the following response headers. */
export interface DeviceScreenHeaders {
  "Content-Type": "image/png" | "image/jpeg";
  "Cache-Control": "no-store";
  "X-Captured-At": string;
  "X-Screen-Width"?: string;
  "X-Screen-Height"?: string;
}

export interface ScreenStreamRecord {
  header: ScreenStreamHeader;
  image?: Uint8Array<ArrayBuffer>;
}

export interface DeviceActivityItem {
  id: string;
  at: number;
  tool: string;
  label: string;
  summary: string;
  status: "running" | "ok" | "failed";
  deviceId?: string;
  conversation?: { platform: string; channel: string; session: string };
}

export interface DeviceActivityResponse {
  items: DeviceActivityItem[];
}

/** Splits the stream back into records, whatever the chunk boundaries; throws on a malformed stream. */
export class ScreenStreamParser {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  push(chunk: Uint8Array): ScreenStreamRecord[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const records: ScreenStreamRecord[] = [];
    let offset = 0;
    while (joined.length - offset >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint32(0);
      if (length === 0 || length > MAX_HEADER_BYTES) throw new Error("invalid_screen_stream");
      if (joined.length - offset < 4 + length) break;
      const header = JSON.parse(new TextDecoder().decode(joined.subarray(offset + 4, offset + 4 + length))) as ScreenStreamHeader;
      const size = header.type === "frame" ? header.size : 0;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_IMAGE_BYTES) throw new Error("invalid_screen_stream");
      if (joined.length - offset < 4 + length + size) break;
      const start = offset + 4 + length;
      records.push(size ? { header, image: joined.slice(start, start + size) } : { header });
      offset = start + size;
    }
    this.buffer = joined.slice(offset);
    return records;
  }
}

export function encodeScreenRecord(header: ScreenStreamHeader, image?: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + (image?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  if (image) out.set(image, 4 + json.length);
  return out;
}
