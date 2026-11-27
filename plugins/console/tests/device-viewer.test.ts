import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

import type { DeviceView, OperationResult } from "@yesimbot/contracts";
import { systemClock } from "@yesimbot/foundation";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { ScreenStreamParser, encodeScreenRecord, type DeviceActivityResponse, type ScreenStreamRecord } from "../src/shared/device-screen.js";
import { installDevices } from "../src/webui/devices.js";

const id = "22222222-2222-4222-8222-222222222222";
const tenant = "11111111-1111-4111-8111-111111111111";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const image: OperationResult = { status: "succeeded", output: { data: png.toString("base64"), mediaType: "image/png" } };
interface HttpFixture {
  query: Record<string, unknown>;
  status: number;
  body: unknown;
  req: EventEmitter;
  res: EventEmitter;
  get(key: string): string;
  set(key: string, value: string): unknown;
}

type Handler = (http: HttpFixture) => Promise<void>;
const device = (): DeviceView => ({
  deviceId: id,
  tenantId: tenant,
  name: "test",
  platform: "linux",
  createdAt: 1,
  online: true,
  capabilities: ["computer.desktop"],
  features: ["screen-view"],
});
function harness() {
  const routes = new Map<string, Handler>();
  const dispose: Array<() => void> = [];
  const devices = {
    available: true,
    list: vi.fn(async (): Promise<DeviceView[]> => [device()]),
    captureScreen: vi.fn(async (_id: string, _signal: AbortSignal): Promise<OperationResult> => image),
    activity: new ComputerActivity(),
  };
  const auth = {
    onRevocation: () => () => {},
    sessionFromCookie: vi.fn((cookie: string): { role: string } | undefined => (cookie ? { role: cookie } : undefined)),
    sameOrigin: (http: HttpFixture) => http.get("origin") === "https://console.test",
  };
  installDevices(
    {
      on: (_event: string, fn: () => void) => dispose.push(fn),
      clock: systemClock(),
      server: { ws() {}, get: (path: string, handler: Handler) => routes.set(path, handler), post: vi.fn() },
      yesimbot: { devices },
    } as never,
    auth as never,
  );
  const start = (path = "screen", query: Record<string, unknown> = { deviceId: id }, role = "owner", origin = "https://console.test", site = "same-origin") => {
    const headers: Record<string, string> = { cookie: role, origin, "sec-fetch-site": site };
    const responseHeaders: Record<string, string> = {};
    const http = {
      query,
      status: 200,
      body: undefined as unknown,
      req: new EventEmitter(),
      res: new EventEmitter(),
      get: (key: string) => headers[key] ?? "",
      set: (key: string, value: string) => (responseHeaders[key] = value),
    };
    const done = routes.get(`/yesimbot/api/v1/devices/${path}`)!(http);
    return { http, done, headers, responseHeaders };
  };
  return { devices, auth, start, dispose: () => dispose.forEach((fn) => fn()) };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
});

it.each(["screen", "screen/stream", "activity"])("protects %s from anonymous, parent members, foreign origins and cross-site GETs", async (path) => {
  const h = harness();
  for (const [role, origin, site, status] of [
    ["", "", "same-origin", 401],
    ["member", "", "same-origin", 403],
    ["owner", "https://foreign.test", "same-origin", 403],
    ["owner", "", "cross-site", 403],
  ] as const) {
    const r = h.start(path, { deviceId: id }, role, origin, site);
    await r.done;
    expect(r.http.status).toBe(status);
  }
  expect(h.devices.list).not.toHaveBeenCalled();
  expect(h.devices.captureScreen).not.toHaveBeenCalled();
  const r = h.start(path, { deviceId: id }, "owner", "");
  await r.done;
  expect(r.http.status).toBe(200);
  h.dispose();
});
it("returns original image bytes, capture time and PNG dimensions with no-store", async () => {
  const h = harness(),
    r = h.start();
  await r.done;
  expect(r.http.body).toEqual(png);
  expect(r.responseHeaders).toMatchObject({
    "Content-Type": "image/png",
    "Cache-Control": "no-store",
    "X-Captured-At": "10000",
    "X-Screen-Width": "1",
    "X-Screen-Height": "1",
  });
  h.dispose();
});
it.each([
  [undefined, 404, { message: "not_found" }],
  [{ revokedAt: 0 }, 409, { message: "screen_unavailable", reason: "not_ready" }],
  [{ online: false }, 409, { message: "screen_unavailable", reason: "offline" }],
  [{ capabilities: [] }, 409, { message: "screen_unavailable", reason: "no_desktop" }],
  [{ health: { "computer.desktop": false } }, 409, { message: "screen_unavailable", reason: "not_ready" }],
  // An older client (or gateway) announces no screen view: never send it a capture it would journal.
  [{ features: undefined }, 409, { message: "screen_unavailable", reason: "update_required" }],
  [{ features: [] }, 409, { message: "screen_unavailable", reason: "update_required" }],
])("rejects unavailable device %j without capturing", async (override, status, body) => {
  const h = harness();
  h.devices.list.mockResolvedValue(override ? [{ ...device(), ...override } as DeviceView] : []);
  const r = h.start();
  await r.done;
  expect(r.http).toMatchObject({ status, body });
  expect(h.devices.captureScreen).not.toHaveBeenCalled();
  h.dispose();
});
it("shows the bot browser's tab on request, checked against the browser and its own feature, and keeps it apart from the desktop", async () => {
  const h = harness();
  const both = { ...device(), capabilities: ["computer.desktop", "computer.browser"], features: ["screen-view", "browser-view"] } as DeviceView;
  h.devices.list.mockResolvedValue([both]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  h.devices.captureScreen.mockImplementation(async (_id, _signal, source?: string) =>
    source === "browser" ? { status: "succeeded", output: { data: jpeg.toString("base64"), mediaType: "image/jpeg", text: '{"scale":2}' } } : image,
  );
  const browser = h.start("screen", { deviceId: id, source: "browser" });
  const desktop = h.start("screen", { deviceId: id });
  await Promise.all([browser.done, desktop.done]);
  // Separate captures: the desktop one is not handed to the browser view or the other way round.
  expect(browser.http.body).toEqual(jpeg);
  expect(browser.responseHeaders["Content-Type"]).toBe("image/jpeg");
  expect(desktop.http.body).toEqual(png);
  expect(h.devices.captureScreen.mock.calls.map((call) => call[2])).toEqual(["browser", "desktop"]);

  for (const [override, body] of [
    [{ capabilities: ["computer.desktop"] }, { message: "screen_unavailable", reason: "no_browser" }],
    [{ health: { "computer.browser": false } }, { message: "screen_unavailable", reason: "not_ready" }],
    // A client that shows the desktop but predates the browser view.
    [{ features: ["screen-view"] }, { message: "screen_unavailable", reason: "update_required" }],
  ] as const) {
    h.devices.captureScreen.mockClear();
    h.devices.list.mockResolvedValue([{ ...both, ...override } as DeviceView]);
    vi.advanceTimersByTime(11_000);
    const r = h.start("screen", { deviceId: id, source: "browser" });
    await r.done;
    expect(r.http).toMatchObject({ status: 409, body });
    expect(h.devices.captureScreen).not.toHaveBeenCalled();
  }
  h.devices.list.mockResolvedValue([both]);
  vi.advanceTimersByTime(11_000);
  h.devices.captureScreen.mockResolvedValue({ status: "rejected", code: "policy_denied" });
  const denied = h.start("screen", { deviceId: id, source: "browser" });
  await denied.done;
  expect(denied.http).toMatchObject({ status: 409, body: { message: "screen_unavailable", reason: "no_browser" } });

  for (const path of ["screen", "screen/stream"]) {
    const bad = h.start(path, { deviceId: id, source: "window" });
    await bad.done;
    expect(bad.http).toMatchObject({ status: 400, body: { message: "invalid_source" } });
  }
  h.dispose();
});
it("fails closed without connection or with an unavailable gateway, and validates UUIDs", async () => {
  const h = harness();
  for (const query of [{}, { deviceId: "../foreign" }, { deviceId: [id, id] }]) {
    const r = h.start("screen", query);
    await r.done;
    expect(r.http.status).toBe(400);
  }
  h.devices.available = false;
  let r = h.start();
  await r.done;
  expect(r.http).toMatchObject({ status: 503, body: { message: "device_connection_unavailable" } });
  h.devices.available = true;
  h.devices.list.mockRejectedValue(new Error("secret"));
  r = h.start();
  await r.done;
  expect(r.http.body).toEqual({ message: "device_connection_unavailable" });
  h.dispose();
});
it("coalesces captures and serves the previous image until 400 ms have elapsed", async () => {
  const h = harness();
  let finish!: (value: OperationResult) => void;
  h.devices.captureScreen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = h.start(),
    second = h.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.devices.captureScreen).toHaveBeenCalledTimes(1);
  finish(image);
  await Promise.all([first.done, second.done]);
  await vi.advanceTimersByTimeAsync(399);
  const cached = h.start();
  await cached.done;
  expect(h.devices.captureScreen).toHaveBeenCalledTimes(1);
  expect(cached.responseHeaders["X-Captured-At"]).toBe(first.responseHeaders["X-Captured-At"]);
  await vi.advanceTimersByTimeAsync(1);
  const next = h.start();
  await next.done;
  expect(h.devices.captureScreen).toHaveBeenCalledTimes(2);
  h.dispose();
});
it("reads the device list once per capture: the check before reuses the last fresh list, the check after reads afresh", async () => {
  const h = harness();
  const first = h.start();
  await first.done;
  expect(first.http.status).toBe(200);
  expect(h.devices.list).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(3000);
    const next = h.start();
    await next.done;
    expect(next.http.status).toBe(200);
  }
  expect(h.devices.list).toHaveBeenCalledTimes(5);
  expect(h.devices.captureScreen).toHaveBeenCalledTimes(4);
  // A capture whose final check sees the device offline fails, and that list is what the next check would reuse.
  h.devices.list.mockResolvedValueOnce([{ ...device(), online: false }]);
  await vi.advanceTimersByTimeAsync(3000);
  const offline = h.start();
  await offline.done;
  expect(offline.http).toMatchObject({ status: 409, body: { reason: "offline" } });
  // The device came back: a reused list that refuses is not trusted, a fresh one decides.
  await vi.advanceTimersByTimeAsync(3000);
  const back = h.start();
  await back.done;
  expect(back.http.status).toBe(200);
  // After ten seconds without a capture, the check before reads afresh too.
  h.devices.list.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  await h.start().done;
  expect(h.devices.list).toHaveBeenCalledTimes(2);
  h.dispose();
});
it("does not return a cached image after revocation, or after authorization expires during capture", async () => {
  const h = harness();
  const first = h.start();
  await first.done;
  h.devices.list.mockResolvedValue([{ ...device(), revokedAt: 10001 }]);
  const next = h.start();
  await next.done;
  expect(next.http.status).toBe(409);
  h.devices.list.mockResolvedValue([device()]);
  await vi.advanceTimersByTimeAsync(1500);
  let finish!: (value: OperationResult) => void;
  h.devices.captureScreen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = h.start();
  await vi.advanceTimersByTimeAsync(0);
  pending.headers.cookie = "";
  finish(image);
  await pending.done;
  expect(pending.http.status).toBe(401);
  expect(Buffer.isBuffer(pending.http.body)).toBe(false);
  h.dispose();
});
it("keeps a shared capture for the remaining waiters when one disconnects, ignores normal request close, and removes listeners", async () => {
  const h = harness();
  let signal!: AbortSignal;
  let finish!: (value: OperationResult) => void;
  h.devices.captureScreen.mockImplementationOnce((_id, inputSignal) => {
    signal = inputSignal;
    return new Promise((resolve) => {
      finish = resolve;
      inputSignal.addEventListener("abort", () => resolve({ status: "unknown", code: "cancelled" }));
    });
  });
  const first = h.start(),
    second = h.start();
  await vi.advanceTimersByTimeAsync(0);
  first.http.req.emit("close");
  expect(signal.aborted).toBe(false);
  first.http.res.emit("close");
  await first.done;
  expect(signal.aborted).toBe(false);
  finish(image);
  await second.done;
  expect(second.http.body).toEqual(png);
  expect(h.devices.captureScreen).toHaveBeenCalledTimes(1);
  expect(first.http.res.listenerCount("close")).toBe(0);
  expect(second.http.req.listenerCount("aborted")).toBe(0);
  h.dispose();
});
it("cancels the device operation only when its last waiter leaves; a later request does not inherit that reason", async () => {
  const h = harness();
  let signal!: AbortSignal;
  h.devices.captureScreen.mockImplementationOnce((_id, inputSignal) => {
    signal = inputSignal;
    // An uncooperative transport keeps the slot occupied after cancellation.
    return new Promise(() => {});
  });
  const first = h.start();
  await vi.advanceTimersByTimeAsync(5_000);
  const second = h.start();
  await vi.advanceTimersByTimeAsync(5_000);
  await first.done;
  expect(first.http).toMatchObject({ status: 504, body: { message: "screen_timeout" } });
  expect(signal.aborted).toBe(false);
  second.http.req.emit("aborted");
  await second.done;
  expect(signal.aborted).toBe(true);
  const third = h.start();
  await third.done;
  expect(third.http).toMatchObject({ status: 409, body: { message: "screen_unavailable", reason: "not_ready" } });
  expect(h.devices.captureScreen).toHaveBeenCalledTimes(1);
  h.dispose();
});
it("accepts valid screenshots up to the 16 MiB base64 limit and leaves no timers after disposal", async () => {
  const h = harness();
  const large = Buffer.alloc(10 * 1024 * 1024);
  png.copy(large, 0, 0, 33);
  h.devices.captureScreen.mockResolvedValue({ status: "succeeded", output: { data: large.toString("base64"), mediaType: "image/png" } });
  expect(large.toString("base64").length).toBeGreaterThan(12 * 1024 * 1024);
  const r = h.start();
  await r.done;
  expect(r.http.status).toBe(200);
  expect((r.http.body as Buffer).length).toBe(large.length);
  h.devices.captureScreen.mockResolvedValue({ status: "succeeded", output: { data: "A".repeat(16 * 1024 * 1024 + 4), mediaType: "image/png" } });
  await vi.advanceTimersByTimeAsync(1500);
  const oversized = h.start();
  await oversized.done;
  expect(oversized.http.body).toEqual({ message: "screen_unavailable", reason: "not_ready" });
  h.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds even an uncooperative capture at 10 s without starting another operation", async () => {
  const h = harness();
  let signal!: AbortSignal;
  h.devices.captureScreen.mockImplementation((_id, inputSignal) => {
    signal = inputSignal;
    return new Promise(() => {});
  });
  const r = h.start();
  await vi.advanceTimersByTimeAsync(10_000);
  await r.done;
  expect(r.http).toMatchObject({ status: 504, body: { message: "screen_timeout" } });
  expect(signal.aborted).toBe(true);
  const next = h.start();
  await vi.advanceTimersByTimeAsync(10_000);
  await next.done;
  expect(h.devices.captureScreen).toHaveBeenCalledTimes(1);
  h.dispose();
});
it("also bounds a hung device list at 10 s", async () => {
  const h = harness();
  h.devices.list.mockReturnValue(new Promise(() => {}));
  const r = h.start();
  await vi.advanceTimersByTimeAsync(10_000);
  await r.done;
  expect(r.http.status).toBe(504);
  expect(h.devices.captureScreen).not.toHaveBeenCalled();
  h.dispose();
});
it.each([
  [{ status: "rejected", code: "policy_denied" }, "no_desktop"],
  [{ status: "rejected", code: "desktop_unavailable" }, "not_ready"],
  [{ status: "rejected", code: "client_update_required" }, "update_required"],
  [{ status: "succeeded", output: { data: "secret", mediaType: "text/html" } }, "not_ready"],
  [{ status: "succeeded", output: { data: png.toString("base64"), mediaType: "image/png", isError: true } }, "not_ready"],
])("maps driver errors safely %j", async (result, reason) => {
  const h = harness();
  h.devices.captureScreen.mockResolvedValue(result as OperationResult);
  const r = h.start();
  await r.done;
  expect(r.http.body).toEqual({ message: "screen_unavailable", reason });
  h.dispose();
});
it("supports JPEG metadata and clears active capture on disposal", async () => {
  const h = harness();
  const bytes = Buffer.from([255, 216, 255, 217]);
  h.devices.captureScreen.mockResolvedValue({
    status: "succeeded",
    output: { data: bytes.toString("base64"), mediaType: "image/jpeg", width: 80, height: 60 },
  });
  const r = h.start();
  await r.done;
  expect(r.http.body).toEqual(bytes);
  expect(r.responseHeaders["X-Screen-Width"]).toBe("80");
  await vi.advanceTimersByTimeAsync(1500);
  // Without a size of its own, the size comes from the JPEG's frame header (after APP0 and a padding byte).
  const app0 = [0xff, 0xe0, 0, 4, 0, 0];
  const sof0 = [0xff, 0xff, 0xc0, 0, 11, 8, 0x02, 0xa6, 0x04, 0xff, 1, 1, 0x11, 0];
  const sized = Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
  h.devices.captureScreen.mockResolvedValue({ status: "succeeded", output: { data: sized.toString("base64"), mediaType: "image/jpeg" } });
  const measured = h.start();
  await measured.done;
  expect([measured.responseHeaders["X-Screen-Width"], measured.responseHeaders["X-Screen-Height"]]).toEqual(["1279", "678"]);
  await vi.advanceTimersByTimeAsync(1500);
  // A truncated or headerless JPEG has no size rather than a wrong one.
  for (const broken of [Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff, 0, 0, 0])]) {
    h.devices.captureScreen.mockResolvedValue({ status: "succeeded", output: { data: broken.toString("base64"), mediaType: "image/jpeg" } });
    const none = h.start();
    await none.done;
    expect(none.responseHeaders["X-Screen-Width"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500);
  }
  let signal!: AbortSignal;
  h.devices.captureScreen.mockImplementation((_id, inputSignal) => {
    signal = inputSignal;
    return new Promise((resolve) => inputSignal.addEventListener("abort", () => resolve({ status: "unknown", code: "cancelled" })));
  });
  const pending = h.start();
  await vi.advanceTimersByTimeAsync(0);
  h.dispose();
  await pending.done;
  expect(signal.aborted).toBe(true);
});
it("filters only this runtime's ring and validates activity limits", async () => {
  const h = harness(),
    otherRuntime = harness();
  for (let i = 0; i < 55; i++) await h.devices.activity.record("computer_exec", { command: `echo ${i}` }, id, () => ({}));
  await h.devices.activity.record("computer_browser", { action: "tabs" }, tenant, () => ({}));
  const r = h.start("activity", {});
  await r.done;
  expect((r.http.body as DeviceActivityResponse).items).toHaveLength(50);
  expect((r.http.body as DeviceActivityResponse).items[0].tool).toBe("computer_browser");
  const filtered = h.start("activity", { deviceId: id, limit: "100" });
  await filtered.done;
  expect((filtered.http.body as DeviceActivityResponse).items).toHaveLength(55);
  const foreign = h.start("activity", { deviceId: "33333333-3333-4333-8333-333333333333" });
  await foreign.done;
  expect(foreign.http.body).toEqual({ items: [] });
  const isolated = otherRuntime.start("activity", {});
  await isolated.done;
  expect(isolated.http.body).toEqual({ items: [] });
  for (const limit of ["0", "101", "-1", "1.5", "", "NaN", ["1", "2"]]) {
    const invalid = h.start("activity", { limit });
    await invalid.done;
    expect(invalid.http).toMatchObject({ status: 400, body: { message: "invalid_limit" } });
  }
  const one = h.start("activity", { limit: "1" });
  await one.done;
  expect((one.http.body as DeviceActivityResponse).items).toHaveLength(1);
  h.dispose();
  otherRuntime.dispose();
});

// ---------- The live screen stream ----------
const shot = (bytes: Buffer): OperationResult => ({ status: "succeeded", output: { data: bytes.toString("base64"), mediaType: "image/png" } });
function collect(stream: Readable) {
  const parser = new ScreenStreamParser();
  const records: ScreenStreamRecord[] = [];
  const state = { records, ended: false };
  stream.on("data", (chunk: Buffer) => records.push(...parser.push(new Uint8Array(chunk))));
  stream.on("end", () => (state.ended = true));
  return state;
}

it("splits stream records whatever the chunk boundaries", () => {
  const bytes = new Uint8Array([
    ...encodeScreenRecord({ type: "frame", mediaType: "image/png", size: 3, capturedAt: 1 }, new Uint8Array([7, 8, 9])),
    ...encodeScreenRecord({ type: "alive" }),
  ]);
  for (const step of [1, 2, 5, bytes.length]) {
    const parser = new ScreenStreamParser();
    const records: ScreenStreamRecord[] = [];
    for (let i = 0; i < bytes.length; i += step) records.push(...parser.push(bytes.subarray(i, i + step)));
    expect(records.map((record) => record.header.type)).toEqual(["frame", "alive"]);
    expect([...records[0].image!]).toEqual([7, 8, 9]);
  }
  expect(() => new ScreenStreamParser().push(new Uint8Array([0, 0, 0, 0]))).toThrow("invalid_screen_stream");
});

it("streams a frame only when the picture changes, stays alive while idle and ends after five minutes", async () => {
  const h = harness();
  const other = Buffer.concat([png, Buffer.from([1, 2, 3])]);
  h.devices.captureScreen.mockResolvedValueOnce(image).mockResolvedValueOnce(image).mockResolvedValueOnce(shot(other));
  const r = h.start("screen/stream");
  await r.done;
  expect(r.responseHeaders["Content-Type"]).toBe("application/x-yesimbot-screen-stream");
  const got = collect(r.http.body as Readable);
  // 0 ms: A; 500 ms: A again (not sent); 1000 ms: B; 1500 ms: A.
  await vi.advanceTimersByTimeAsync(1600);
  expect(got.records.map((record) => record.header.type)).toEqual(["frame", "frame", "frame"]);
  expect(Buffer.from(got.records[1].image!)).toEqual(other);
  expect(got.records[0].header).toMatchObject({ mediaType: "image/png", size: png.length, width: 1, height: 1 });
  await vi.advanceTimersByTimeAsync(16_000);
  expect(got.records.at(-1)!.header.type).toBe("alive");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(got.records.at(-1)!.header.type).toBe("end");
  expect(got.ended).toBe(true);
  h.dispose();
});

it("keeps the last picture while the bot holds the desktop, reports a lasting problem once, and stops where retrying cannot help", async () => {
  const h = harness();
  const busy: OperationResult = { status: "rejected", code: "desktop_unavailable" };
  h.devices.captureScreen.mockResolvedValueOnce(image).mockResolvedValueOnce(busy).mockResolvedValueOnce(busy).mockResolvedValueOnce(busy);
  const r = h.start("screen/stream");
  await r.done;
  const got = collect(r.http.body as Readable);
  await vi.advanceTimersByTimeAsync(2600);
  expect(got.records.map((record) => record.header.type)).toEqual(["frame"]);
  h.devices.list.mockResolvedValue([{ ...device(), online: false }]);
  await vi.advanceTimersByTimeAsync(20_000);
  const problems = got.records.filter((record) => record.header.type === "problem");
  expect(problems.map((record) => record.header)).toEqual([{ type: "problem", status: 409, body: { message: "screen_unavailable", reason: "offline" } }]);
  h.devices.list.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(got.records.at(-1)!.header).toEqual({ type: "problem", status: 404, body: { message: "not_found" } });
  expect(got.ended).toBe(true);
  h.dispose();
});

it("ends the stream on logout and stops capturing once the browser leaves", async () => {
  const h = harness();
  let r = h.start("screen/stream");
  await r.done;
  let got = collect(r.http.body as Readable);
  await vi.advanceTimersByTimeAsync(100);
  h.auth.sessionFromCookie.mockReturnValue(undefined);
  await vi.advanceTimersByTimeAsync(1000);
  expect(got.records.at(-1)!.header).toEqual({ type: "problem", status: 401, body: { message: "login_required" } });
  expect(got.ended).toBe(true);
  h.auth.sessionFromCookie.mockImplementation((cookie: string) => (cookie ? { role: cookie } : undefined));
  r = h.start("screen/stream");
  await r.done;
  got = collect(r.http.body as Readable);
  await vi.advanceTimersByTimeAsync(100);
  const calls = h.devices.captureScreen.mock.calls.length;
  r.http.res.emit("close");
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.devices.captureScreen.mock.calls.length).toBe(calls);
  expect(got.ended).toBe(true);
  h.dispose();
});

it("preserves the desktop scale for accurate manual input on high-DPI screens", async () => {
  const h = harness();
  h.devices.captureScreen.mockResolvedValue({
    status: "succeeded",
    output: { data: png.toString("base64"), mediaType: "image/png", text: '{"data":{"scale_factor":2}}' },
  });
  const response = h.start();
  await response.done;
  expect(response.responseHeaders["X-Screen-Scale"]).toBe("2");
  h.dispose();
});
