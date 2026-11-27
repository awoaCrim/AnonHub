import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { systemClock } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot";
import { expect, it, vi } from "vitest";

import type { AdminSession } from "../src/admin-auth.js";
import { installChatUploads } from "../src/webui/chat-uploads.js";

interface UploadHttp {
  query: Record<string, unknown>;
  request: { body?: unknown };
  req: PassThrough;
  get(name: string): string;
  set: ReturnType<typeof vi.fn>;
  status?: number;
  body?: unknown;
}

type UploadRoute = (http: UploadHttp) => Promise<void>;

type UploadResult = { id: string };

type UploadFailure = { message: string };

const scope = { type: "direct", platform: "web", selfId: "bot", channelId: "owner", userId: "owner" } as const;
function fixture() {
  const routes = new Map<string, UploadRoute>();
  const devices = {
    workspaceDevice: vi.fn(() => "device-a"),
    list: vi.fn(async () => [{ deviceId: "device-a", online: true, capabilities: ["workspace.files"], features: ["file-upload-8m"] }]),
    invoke: vi.fn(async (_deviceId: string, _request: { scope: ChannelContext; operationId: string; input: { path: string; data: string } }) => ({
      status: "succeeded",
    })),
  };
  const stored = new Map<string, Buffer>();
  const resource = {
    get: vi.fn(async (_scope: ChannelContext) => ({
      assets: {
        put: vi.fn(async (bytes: Uint8Array) => {
          const id = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
          stored.set(id, Buffer.from(bytes));
          return id;
        }),
      },
    })),
  };
  const ctx = {
    clock: systemClock(),
    server: { get: (path: string, fn: UploadRoute) => routes.set("GET " + path, fn), post: (path: string, fn: UploadRoute) => routes.set("POST " + path, fn) },
    // The console does not inject Core: reading it off the context only logs warnings (2026-11-18).
    get yesimbot(): never {
      throw new Error("read Core through the binding");
    },
  };
  const core = { devices, resource };
  const authorization = { session: { role: "owner" } as AdminSession | undefined, sameOrigin: true };
  const current = vi.fn(async (): Promise<ChannelContext> => scope);
  const uploads = installChatUploads(
    ctx as never,
    { sessionFromCookie: (cookie: string) => (cookie === "owner" ? authorization.session : undefined), sameOrigin: () => authorization.sameOrigin } as never,
    current,
    () => core as never,
  );
  const start = (headers: Record<string, string>, query: Record<string, unknown> = {}, input?: unknown) => {
    const req = new PassThrough();
    const http: UploadHttp = { query, request: { body: input }, req, get: (name) => headers[name] ?? "", set: vi.fn() };
    const reading = new Promise<void>((resolve) => req.once("resume", resolve));
    const done = routes.get("POST /yesimbot/api/v1/chat/uploads")!(http);
    return { http, req, reading, done };
  };
  const call = async (input: unknown, authorized = true) => {
    const { http, req, done } = start({ "content-type": "application/json", cookie: authorized ? "owner" : "" }, {}, input);
    req.end();
    await done;
    return http;
  };
  const startBinary = (name: unknown, headers: Record<string, string> = {}) =>
    start({ "content-type": "application/octet-stream", cookie: "owner", ...headers }, name === undefined ? {} : { name });
  const startJson = () => start({ "content-type": "application/json", cookie: "owner" });
  const binary = async (name: unknown, bytes: Buffer, headers?: Record<string, string>) => {
    const { http, req, done } = startBinary(name, headers);
    req.end(bytes);
    await done;
    return http;
  };
  const status = async () => {
    const http: UploadHttp = { query: {}, request: {}, req: new PassThrough(), get: (name) => (name === "cookie" ? "owner" : ""), set: vi.fn() };
    await routes.get("GET /yesimbot/api/v1/chat/uploads")!(http);
    return http.body;
  };
  return { devices, resource, stored, uploads, call, startBinary, startJson, binary, authorization, current, status };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
it("requires both owner authorization and the assigned online computer", async () => {
  const f = fixture();
  await f.call({ name: "a.txt", data: "YQ==" }, false);
  expect(f.devices.invoke).not.toHaveBeenCalled();
  f.devices.list.mockResolvedValue([{ deviceId: "device-b", online: true, capabilities: ["workspace.files"], features: ["file-upload-8m"] }]);
  expect(((await f.call({ name: "a.txt", data: "YQ==" })).body as UploadFailure).message).toBe("upload_computer_unavailable");
  expect(f.devices.invoke).not.toHaveBeenCalled();
});
it("keeps uploaded files scoped, sanitizes filenames, and refuses changed device selection", async () => {
  const f = fixture(),
    http = await f.call({ name: "../bad:name.txt", data: "YQ==" });
  expect(http.status).toBeUndefined();
  expect(f.devices.invoke.mock.calls[0]?.[1]).toMatchObject({ scope, capability: "workspace.files", method: "write" });
  const [file] = await f.uploads.resolve([(http.body as UploadResult).id], scope);
  expect(file.uri).not.toContain("/../");
  expect(file.uri).not.toContain("bad:name");
  await expect(f.uploads.resolve([(http.body as UploadResult).id], { ...scope, userId: "another", channelId: "another" })).rejects.toThrow("upload_expired");
  f.devices.workspaceDevice.mockReturnValue("device-b");
  f.devices.list.mockResolvedValue([{ deviceId: "device-b", online: true, capabilities: ["workspace.files"], features: ["file-upload-8m"] }]);
  await expect(f.uploads.resolve([(http.body as UploadResult).id], scope)).rejects.toThrow("upload_expired");
});
it("does not issue a usable attachment token for unknown write results", async () => {
  const f = fixture();
  f.devices.invoke.mockResolvedValue({ status: "unknown" });
  const http = await f.call({ name: "a.txt", data: "YQ==" });
  expect(http.status).toBe(400);
  expect(http.body).toEqual({ message: "upload_not_confirmed" });
});

it("accepts an 8 MiB file without regex stack overflow and rejects malformed encodings", async () => {
  const f = fixture();
  const response = await f.call({ name: "large.bin", data: Buffer.alloc(8 * 1024 * 1024, 1).toString("base64") });
  expect((response.body as UploadResult).id).toEqual(expect.any(String));
  for (const data of ["YQ", "YQ===", "YQ==\n", "Y!==", "YR=="])
    expect(((await f.call({ name: "bad.bin", data })).body as UploadFailure).message).toBe("invalid_upload");
});

it("refuses oversized uploads to legacy clients before dispatch", async () => {
  const f = fixture();
  f.devices.list.mockResolvedValue([{ deviceId: "device-a", online: true, capabilities: ["workspace.files"], features: [] }]);
  expect(((await f.call({ name: "large.bin", data: Buffer.alloc(181 * 1024).toString("base64") })).body as UploadFailure).message).toBe("upload_client_limit");
  expect(f.devices.invoke).not.toHaveBeenCalled();
});

it("keeps native uploads owner-only and subject to the same-origin write guard", async () => {
  const f = fixture();
  f.authorization.session = undefined;
  expect((await f.binary("a.txt", Buffer.from("a"))).body).toEqual({ message: "login_required" });
  f.authorization.session = { role: "member" } as AdminSession;
  expect((await f.binary("a.txt", Buffer.from("a"))).status).toBe(403);
  f.authorization.session = { role: "owner" } as AdminSession;
  f.authorization.sameOrigin = false;
  expect((await f.binary("a.txt", Buffer.from("a"))).body).toEqual({ message: "same_origin_required" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
});

it("forwards exact native bytes as base64 and sanitizes the decoded query filename", async () => {
  const f = fixture();
  const bytes = Buffer.from([0, 255, 128, 1, 13, 10]);
  const http = await f.binary("../资料 #?%.png", bytes, { "content-type": "Application/Octet-Stream; charset=binary" });
  expect(http.status).toBeUndefined();
  // The bytes, not the name, decide: these are not an image, so they go only to the computer.
  expect(http.body).toMatchObject({ name: ".._资料 #_%.png", kind: "file" });
  expect(f.stored.size).toBe(0);
  const request = f.devices.invoke.mock.calls[0]![1];
  expect(request).toMatchObject({ scope, capability: "workspace.files", method: "write", input: { data: bytes.toString("base64") } });
  const [file] = await f.uploads.resolve([(http.body as UploadResult).id], scope);
  expect(file.uri).toBe(`workspace:///${request.input.path}`);
  expect(file.uri).not.toContain("/../");
});

it.each([undefined, "", "  ", "a".repeat(161), ["a.txt", "b.txt"]])("rejects absent, empty, oversized or repeated native filenames: %j", async (name) => {
  const f = fixture();
  expect((await f.binary(name, Buffer.from("a"))).body).toEqual({ message: "invalid_upload" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
});

it("accepts a 160-character native filename and rejects empty native bytes or unsupported content types", async () => {
  const f = fixture();
  expect((await f.binary("a".repeat(160), Buffer.from("a"))).body).toMatchObject({ id: expect.any(String) });
  f.devices.invoke.mockClear();
  expect((await f.binary("a.txt", Buffer.alloc(0))).body).toEqual({ message: "invalid_upload" });
  expect((await f.binary("a.txt", Buffer.from("a"), { "content-type": "text/plain" })).body).toEqual({ message: "invalid_upload" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
});

it("accepts exactly 8 MiB of native bytes", async () => {
  const f = fixture();
  const bytes = Buffer.alloc(8 * 1024 * 1024, 255);
  const http = await f.binary("large.bin", bytes);
  expect(http.body).toMatchObject({ id: expect.any(String) });
  expect(Buffer.from(f.devices.invoke.mock.calls[0]![1].input.data, "base64").equals(bytes)).toBe(true);
});

it.each([
  ["modern", 8 * 1024 * 1024, ["file-upload-8m"]],
  ["legacy", 180 * 1024, []],
] as const)("bounds %s native streams by actual bytes even when Content-Length is smaller", async (_client, limit, features) => {
  const f = fixture();
  f.devices.list.mockResolvedValue([{ deviceId: "device-a", online: true, capabilities: ["workspace.files"], features: [...features] }]);
  const pending = f.startBinary("large.bin", { "content-length": "1" });
  await pending.reading;
  pending.req.write(Buffer.alloc(limit));
  pending.req.end(Buffer.from([1]));
  await pending.done;
  expect(pending.http.body).toEqual({ message: "upload_client_limit" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
  expect(pending.req.listenerCount("data")).toBe(0);
});

it("accepts exactly the legacy native byte limit", async () => {
  const f = fixture();
  f.devices.list.mockResolvedValue([{ deviceId: "device-a", online: true, capabilities: ["workspace.files"], features: [] }]);
  expect((await f.binary("legacy.bin", Buffer.alloc(180 * 1024))).body).toMatchObject({ id: expect.any(String) });
});

it.each(["aborted", "error", "close"])("rejects a native stream interrupted by %s without dispatching or retaining listeners", async (event) => {
  const f = fixture();
  const pending = f.startBinary("partial.bin");
  await pending.reading;
  const closed = new Promise<void>((resolve) => pending.req.once("close", resolve));
  pending.req.write(Buffer.from("partial"));
  if (event === "error") pending.req.destroy(Error("broken stream"));
  else if (event === "close") pending.req.destroy();
  else {
    pending.req.emit("aborted");
    expect(() => pending.req.emit("error", Error("ECONNRESET after abort"))).not.toThrow();
    pending.req.end();
  }
  await pending.done;
  await closed;
  expect(pending.http.body).toEqual({ message: "invalid_upload" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
  for (const name of ["data", "end", "error", "aborted", "close"]) expect(pending.req.listenerCount(name)).toBe(0);
});

it("rejects a native request that was destroyed before the reader starts", async () => {
  const f = fixture();
  const pending = f.startBinary("partial.bin");
  pending.req.destroy();
  await pending.done;
  expect(pending.http.body).toEqual({ message: "invalid_upload" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
});

it("times out a native body that stops arriving, without dispatching", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.startBinary("stalled.bin");
  try {
    await pending.reading;
    pending.req.write(Buffer.from("first bytes"));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(pending.http.body).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending.done;
    expect(pending.http.body).toEqual({ message: "invalid_upload" });
    expect(f.devices.invoke).not.toHaveBeenCalled();
    expect(pending.req.listenerCount("data")).toBe(0);
  } finally {
    pending.req.destroy();
    vi.useRealTimers();
  }
});

// User, 2026-11-27: 「我一个3m的图片上传不了」 — over the public link a 3 MB body takes about 15 s.
it("accepts a slow native body that keeps arriving past the old 10 s limit", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.startBinary("slow.txt");
  try {
    await pending.reading;
    for (let second = 0; second < 40; second += 8) {
      pending.req.write(Buffer.from("part "));
      await vi.advanceTimersByTimeAsync(8_000);
    }
    pending.req.end(Buffer.from("end"));
    await pending.done;
    expect(pending.http.body).toMatchObject({ id: expect.any(String), name: "slow.txt" });
  } finally {
    vi.useRealTimers();
  }
});

it("ends a trickling native body after five minutes", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.startBinary("trickle.bin");
  try {
    await pending.reading;
    for (let second = 0; second < 300; second += 10) {
      pending.req.write(Buffer.from("x"));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await pending.done;
    expect(pending.http.body).toEqual({ message: "invalid_upload" });
    expect(f.devices.invoke).not.toHaveBeenCalled();
  } finally {
    pending.req.destroy();
    vi.useRealTimers();
  }
});

it.each([
  ["binary", "conversation"],
  ["binary", "computer"],
  ["binary", "login"],
  ["json", "conversation"],
  ["json", "computer"],
  ["json", "login"],
] as const)("refuses a %s upload when the %s changes while reading the body", async (format, changed) => {
  const f = fixture();
  const pending = format === "binary" ? f.startBinary("a.txt") : f.startJson();
  await pending.reading;
  if (changed === "conversation") f.current.mockResolvedValue({ ...scope, channelId: "new", userId: "new" });
  else if (changed === "computer") f.devices.workspaceDevice.mockReturnValue("device-b");
  else f.authorization.session = undefined;
  pending.req.end(format === "binary" ? Buffer.from("a") : JSON.stringify({ name: "a.txt", data: "YQ==" }));
  await pending.done;
  expect(pending.http.body).toEqual({ message: changed === "login" ? "login_required" : "upload_target_changed" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
});

it.each(["conversation", "computer", "login"])("issues no native attachment token if the %s changes during the device write", async (changed) => {
  const f = fixture();
  f.devices.invoke.mockImplementation(async () => {
    if (changed === "conversation") f.current.mockResolvedValue({ ...scope, channelId: "new", userId: "new" });
    else if (changed === "computer") f.devices.workspaceDevice.mockReturnValue("device-b");
    else f.authorization.session = { role: "owner" } as AdminSession;
    return { status: "succeeded" };
  });
  const http = await f.binary("a.txt", Buffer.from("a"));
  expect(http.body).toEqual({ message: changed === "login" ? "login_required" : "upload_target_changed" });
  const request = f.devices.invoke.mock.calls[0]![1];
  f.devices.workspaceDevice.mockReturnValue("device-a");
  await expect(f.uploads.resolve([request.operationId], scope)).rejects.toThrow("upload_expired");
});

it("does not issue a native attachment token for an unknown device write result", async () => {
  const f = fixture();
  f.devices.invoke.mockResolvedValue({ status: "unknown" });
  expect((await f.binary("a.txt", Buffer.from("a"))).body).toEqual({ message: "upload_not_confirmed" });
  await expect(f.uploads.resolve([f.devices.invoke.mock.calls[0]![1].operationId], scope)).rejects.toThrow("upload_expired");
});

it("keeps an image in the conversation's own assets without a computer", async () => {
  const f = fixture();
  f.devices.workspaceDevice.mockReturnValue(undefined as never);
  expect(await f.status()).toEqual({ available: true, files: false, maxBytes: 8 * 1024 * 1024, imageMaxBytes: 5 * 1024 * 1024 });
  const http = await f.binary("截图.png", PNG);
  expect(http.body).toMatchObject({ name: "截图.png", kind: "image" });
  expect(f.devices.invoke).not.toHaveBeenCalled();
  expect(f.resource.get).toHaveBeenCalledWith(scope);
  const [file] = await f.uploads.resolve([(http.body as UploadResult).id], scope);
  expect(file).toMatchObject({ kind: "image", asset: [...f.stored.keys()][0] });
  expect(file.uri).toBeUndefined();
  // Any other file still needs the computer.
  expect((await f.binary("notes.txt", Buffer.from("hello"))).body).toEqual({ message: "upload_computer_required" });
  expect(f.stored.size).toBe(1);
});

it("also puts an image on a connected computer, and sends it without that copy once the computer changes", async () => {
  const f = fixture();
  expect(await f.status()).toEqual({ available: true, files: true, maxBytes: 8 * 1024 * 1024, imageMaxBytes: 5 * 1024 * 1024 });
  const http = await f.binary("a.png", PNG);
  expect(f.devices.invoke.mock.calls[0]![1]).toMatchObject({ scope, method: "write", input: { data: PNG.toString("base64") } });
  const id = (http.body as UploadResult).id;
  const [file] = await f.uploads.resolve([id], scope);
  expect(file).toMatchObject({
    kind: "image",
    asset: expect.stringMatching(/^[a-f0-9]{32}$/),
    uri: expect.stringMatching(/^workspace:\/\/\/[0-9a-f-]{36}-a\.png$/),
  });
  f.devices.workspaceDevice.mockReturnValue("device-b");
  const [moved] = await f.uploads.resolve([id], scope);
  expect(moved).toMatchObject({ asset: file.asset });
  expect(moved.uri).toBeUndefined();
});

it("sends an image even when its copy on the computer fails", async () => {
  const f = fixture();
  f.devices.invoke.mockResolvedValue({ status: "failed" } as never);
  const http = await f.binary("a.png", PNG);
  expect(http.body).toMatchObject({ kind: "image" });
  const [file] = await f.uploads.resolve([(http.body as UploadResult).id], scope);
  expect(file.asset).toEqual(expect.any(String));
  expect(file.uri).toBeUndefined();
});

it("sends an image larger than the bot can be shown only to the computer, as a file there", async () => {
  const f = fixture();
  const large = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  const http = await f.binary("large.png", large);
  expect(http.body).toMatchObject({ kind: "image" });
  expect(f.stored.size).toBe(0);
  const [file] = await f.uploads.resolve([(http.body as UploadResult).id], scope);
  expect(file.asset).toBeUndefined();
  expect(file.uri).toMatch(/^workspace:\/\/\//);
  // Without a computer nothing larger than an image the bot can be shown is even read.
  f.devices.workspaceDevice.mockReturnValue(undefined as never);
  expect((await f.binary("large.png", large)).body).toEqual({ message: "upload_client_limit" });
});
