import { createHash } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";

import type { DeviceView } from "@yesimbot/contracts";
import type { Clock } from "@yesimbot/foundation";
import type { Devices, ScreenSource } from "koishi-plugin-yesimbot/kernel";

import { encodeScreenRecord, type DeviceScreenError, type ScreenStreamHeader, type ScreenUnavailableReason } from "../shared/device-screen.js";

/** A new picture at most this often; a slower link gets fewer, since each write waits for the last to drain. */
export const STREAM_FRAME_GAP_MS = 500;

/** How long the check before a capture may reuse the device list; the check after it always reads afresh. */
const LIST_REUSE_MS = 10_000;

/** A finished capture is handed to anyone else asking within this long (several tabs, one capture). */
const SHARE_MS = 400;

const STREAM_ALIVE_MS = 15_000;

const STREAM_LIFETIME_MS = 5 * 60_000;

const STREAM_CAPTURE_MS = 10_000;

/** While a bot desktop call holds the screen, keep the last picture through this many refusals. */
const STREAM_BUSY_TRIES = 6;

export interface ScreenStreamOptions {
  clock: Clock;
  signal: AbortSignal;
  source?: ScreenSource;
  /** Checked before every capture: a logout ends the stream. */
  authorized: () => boolean;
  frameGapMs?: number;
  aliveMs?: number;
  lifetimeMs?: number;
}

interface Screen {
  bytes: Buffer;
  mediaType: "image/png" | "image/jpeg";
  capturedAt: number;
  width?: number;
  height?: number;
  scaleFactor?: number;
}

interface Capture {
  started: number;
  controller: AbortController;
  promise: Promise<Screen>;
  /** Requests currently waiting; only the last one leaving an unfinished capture cancels it. */
  waiters: number;
  settled: boolean;
  expiry?: ReturnType<typeof setTimeout>;
}

export class ScreenError extends Error {
  constructor(
    readonly status: number,
    readonly body: DeviceScreenError,
  ) {
    super(body.message);
  }
}

/** Scoped to one installed runtime; at most one active operation per device and source, shared for `SHARE_MS`. */
export class DeviceScreens {
  private readonly captures = new Map<string, Capture>();
  private disposed = false;
  private listed?: { at: number; devices: Promise<DeviceView[]> };
  constructor(
    private readonly devices: Pick<Devices, "available" | "list" | "captureScreen">,
    private readonly clock: Clock,
  ) {}

  async get(deviceId: string, signal: AbortSignal, source: ScreenSource = "desktop"): Promise<Screen> {
    // A capture every few seconds reuses the list the previous capture's final check read.
    await this.check(deviceId, signal, false, source);
    signal.throwIfAborted();
    if (this.disposed) throw interrupted();
    const key = `${source}:${deviceId}`;
    const capture = this.captures.get(key) ?? this.start(key, deviceId, source);
    // Everyone waiting on a cancelled operation has left; its reason (e.g. their timeout) is not ours.
    if (capture.controller.signal.aborted) throw interrupted();
    capture.waiters++;
    try {
      const screen = await abortable(capture.promise, AbortSignal.any([signal, capture.controller.signal]));
      // Revocation, disconnection and local capability health may change during a capture.
      await this.check(deviceId, signal, true, source);
      return screen;
    } finally {
      // One request closing or timing out leaves the others sharing the capture.
      if (--capture.waiters === 0 && !capture.settled) capture.controller.abort(interrupted());
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const capture of this.captures.values()) {
      clearTimeout(capture.expiry);
      capture.controller.abort(interrupted());
    }
    this.captures.clear();
  }
  private start(key: string, deviceId: string, source: ScreenSource): Capture {
    const entry: Capture = { started: this.clock.now(), controller: new AbortController(), promise: undefined!, waiters: 0, settled: false };
    this.captures.set(key, entry);
    // Keep the slot until the underlying transport settles, even if it ignores cancellation.
    entry.promise = this.capture(deviceId, entry.controller.signal, source).finally(() => {
      entry.settled = true;
      if (this.disposed) return;
      entry.expiry = setTimeout(
        () => {
          if (this.captures.get(key) === entry) this.captures.delete(key);
        },
        Math.max(0, SHARE_MS - (this.clock.now() - entry.started)),
      );
      entry.expiry.unref?.();
    });
    return entry;
  }
  private list(fresh: boolean): Promise<DeviceView[]> {
    if (fresh || !this.listed || this.clock.now() - this.listed.at >= LIST_REUSE_MS) {
      const devices = this.devices.list();
      const entry = { at: this.clock.now(), devices };
      this.listed = entry;
      devices.catch(() => {
        if (this.listed === entry) this.listed = undefined;
      });
    }
    return this.listed!.devices;
  }
  private async check(deviceId: string, signal: AbortSignal, fresh: boolean, source: ScreenSource): Promise<void> {
    if (!this.devices.available) throw new ScreenError(503, { message: "device_connection_unavailable" });
    let devices: DeviceView[];
    try {
      devices = await abortable(this.list(fresh), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ScreenError) throw error;
      throw new ScreenError(503, { message: "device_connection_unavailable" });
    }
    try {
      this.verify(devices, deviceId, source);
    } catch (error) {
      // A reused list may be stale (the device came back): refuse only on a fresh one.
      if (fresh) throw error;
      await this.check(deviceId, signal, true, source);
    }
  }
  private verify(devices: DeviceView[], deviceId: string, source: ScreenSource): void {
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (!device) throw new ScreenError(404, { message: "not_found" });
    if (device.revokedAt !== undefined) throw unavailable("not_ready");
    if (!device.online) throw unavailable("offline");
    const capability = source === "browser" ? "computer.browser" : "computer.desktop";
    if (!device.capabilities.includes(capability)) throw unavailable(source === "browser" ? "no_browser" : "no_desktop");
    if (device.health?.[capability] === false) throw unavailable("not_ready");
    // Never ask an older client: it would journal every screenshot. An older gateway omits features too.
    if (!device.features?.includes(source === "browser" ? "browser-view" : "screen-view")) throw unavailable("update_required");
  }
  private async capture(deviceId: string, signal: AbortSignal, source: ScreenSource): Promise<Screen> {
    const result = await this.devices.captureScreen(deviceId, signal, source).catch((error: unknown) => {
      if (!this.devices.available) throw new ScreenError(503, { message: "device_connection_unavailable" });
      throw error;
    });
    signal.throwIfAborted();
    if (result.status !== "succeeded") {
      if (result.code === "deadline_exceeded") throw screenTimeout();
      if (result.code === "policy_denied") throw unavailable(source === "browser" ? "no_browser" : "no_desktop");
      throw unavailable(result.code === "client_update_required" ? "update_required" : "not_ready");
    }
    const value = result.output as { data?: unknown; mediaType?: unknown; width?: unknown; height?: unknown; text?: unknown; isError?: unknown } | null;
    if (
      !value ||
      value.isError === true ||
      typeof value.data !== "string" ||
      value.data.length > 16 * 1024 * 1024 ||
      // Padded base64. Keep this a flat character class: a grouped `(?:x{4})*` overflows V8's regexp
      // stack above ~8 MiB and would reject valid large screenshots.
      value.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) ||
      (value.mediaType !== "image/png" && value.mediaType !== "image/jpeg")
    )
      throw unavailable("not_ready");
    const bytes = Buffer.from(value.data, "base64");
    const png =
      bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("latin1", 12, 16) === "IHDR";
    const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!(value.mediaType === "image/png" ? png : jpeg)) throw unavailable("not_ready");
    const dimension = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);
    const scale = typeof value.text === "string" ? Number(/"scale_factor"\s*:\s*([0-9.]+)/.exec(value.text)?.[1] ?? 1) : 1;
    const frame = jpeg ? jpegSize(bytes) : undefined;
    return {
      ...(Number.isFinite(scale) && scale > 0 && scale <= 8 ? { scaleFactor: scale } : {}),
      bytes,
      mediaType: value.mediaType,
      capturedAt: this.clock.now(),
      width: dimension(value.width) ?? (png ? dimension(bytes.readUInt32BE(16)) : dimension(frame?.width)),
      height: dimension(value.height) ?? (png ? dimension(bytes.readUInt32BE(20)) : dimension(frame?.height)),
    };
  }
}

/**
 * The live screen as one response (`ScreenStreamHeader` records). It sends a frame only when the
 * picture changed. Problems are sent once each. Retrying is pointless after 401/403/404, so the
 * stream stops there. After `lifetimeMs` it sends `end`, so the browser reconnects through the
 * login check again.
 */
export function streamScreen(screens: Pick<DeviceScreens, "get">, deviceId: string, options: ScreenStreamOptions): Readable {
  const { signal, clock } = options;
  const gap = options.frameGapMs ?? STREAM_FRAME_GAP_MS,
    alive = options.aliveMs ?? STREAM_ALIVE_MS,
    lifetime = options.lifetimeMs ?? STREAM_LIFETIME_MS;
  const out = new PassThrough();
  const stopped = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
    out.once("close", () => resolve());
  });
  let lastWrite = clock.now();
  const write = async (header: ScreenStreamHeader, image?: Uint8Array) => {
    if (signal.aborted || out.destroyed) return;
    lastWrite = clock.now();
    if (!out.write(encodeScreenRecord(header, image))) await Promise.race([new Promise((resolve) => out.once("drain", resolve)), stopped]);
  };
  const wait = (ms: number) => Promise.race([new Promise((resolve) => setTimeout(resolve, ms).unref?.()), stopped]);
  void (async () => {
    const started = clock.now();
    let shown: string | undefined, reported: string | undefined;
    let failures = 0;
    try {
      while (!signal.aborted && !out.destroyed && clock.now() - started < lifetime) {
        if (!options.authorized()) {
          await write({ type: "problem", status: 401, body: { message: "login_required" } });
          return;
        }
        const began = clock.now();
        try {
          const screen = await screens.get(deviceId, AbortSignal.any([signal, AbortSignal.timeout(STREAM_CAPTURE_MS)]), options.source);
          failures = 0;
          reported = undefined;
          const digest = createHash("sha1").update(screen.bytes).digest("hex");
          if (digest !== shown) {
            shown = digest;
            const { mediaType, capturedAt, width, height, scaleFactor } = screen;
            await write({ type: "frame", mediaType, size: screen.bytes.length, capturedAt, width, height, scaleFactor }, screen.bytes);
          } else if (clock.now() - lastWrite >= alive) await write({ type: "alive", capturedAt: screen.capturedAt });
          await wait(Math.max(0, gap - (clock.now() - began)));
        } catch (error) {
          if (signal.aborted) return;
          const failure =
            error instanceof ScreenError ? error : error instanceof Error && error.name === "TimeoutError" ? screenTimeout() : unavailable("not_ready");
          failures++;
          // A bot desktop call briefly holds the screen: keep the last picture and look again soon.
          const busy = failure.status === 409 && "reason" in failure.body && failure.body.reason === "not_ready";
          const quiet = busy && shown !== undefined && failures <= STREAM_BUSY_TRIES;
          const key = JSON.stringify([failure.status, failure.body]);
          if (!quiet && key !== reported) {
            reported = key;
            await write({ type: "problem", status: failure.status, body: failure.body });
          } else if (clock.now() - lastWrite >= alive) await write({ type: "alive" });
          if (failure.status === 401 || failure.status === 403 || failure.status === 404) return;
          await wait(quiet ? gap : Math.min(10_000, 1000 * 2 ** Math.min(failures - 1, 4)));
        }
      }
      await write({ type: "end" });
    } finally {
      out.end();
    }
  })();
  return out;
}

export function screenTimeout(): ScreenError {
  return new ScreenError(504, { message: "screen_timeout" });
}

/** Also bounds a hung list/transport without relying on its AbortSignal implementation. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? interrupted());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A JPEG's size from its first frame header (the bot browser's tab pictures carry no size of their own). */
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 9 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Start of scan: the image data follows, so no frame header came first.
    if (marker === 0xda) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
}

function unavailable(reason: ScreenUnavailableReason): ScreenError {
  return new ScreenError(409, { message: "screen_unavailable", reason });
}

function interrupted(): ScreenError {
  return unavailable("not_ready");
}
