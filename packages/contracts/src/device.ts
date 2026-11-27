import { z } from "zod/v4";

import { actorSchema, conversationSchema, opaqueId, uuid } from "./identity.js";

export const MAX_DEVICE_FRAME_BYTES = 20 * 1024 * 1024;

export const MAX_DEVICE_INPUT_BYTES = 256 * 1024;

/** Base64-encoded 8 MiB file plus bounded invocation metadata. */
export const MAX_DEVICE_FILE_INPUT_BYTES = 12 * 1024 * 1024;

export const capabilitySchema = z.enum(["workspace.files", "computer.shell", "computer.desktop", "computer.browser"]);

export type DeviceCapability = z.infer<typeof capabilitySchema>;

export const capabilitiesSchema = z
  .array(capabilitySchema)
  .max(4)
  .refine((values) => new Set(values).size === values.length);

export const deviceRecordSchema = z
  .object({
    deviceId: uuid,
    tenantId: uuid,
    name: z.string().trim().min(1).max(128),
    platform: z.enum(["win32", "darwin", "linux"]),
    capabilities: capabilitiesSchema,
    createdAt: z.number().int().nonnegative(),
    revokedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

export const deviceHealthSchema = z.partialRecord(capabilitySchema, z.boolean());

/** Optional client abilities announced per connection (WebSocket upgrade header), not stored with the device. */
/** `browser-view`: the bot browser's tab can be watched like the screen (`BROWSER_VIEW_READ`). */
/** `browser-control`: the owner can take over that tab with clicks, keys and text (`isBrowserControl`). */
/**
 * `shell-jobs`: `computer.shell` takes `exec {continueAfterTimeout}` and the `start`/`job` methods, so a command that outlives
 * its wait keeps running as a background job. Older clients reject the extra field, so servers send it only to clients announcing this.
 */
/**
 * `project-files`: `workspace.files` also takes absolute paths inside the project directories the device's owner opened
 * locally (announced in `DEVICE_ROOTS_HEADER`), and `write` takes `expectedSha256` (`null`: the file must not exist).
 */
export const DEVICE_FEATURES = [
  "screen-view",
  "auto-update",
  "file-upload-8m",
  "desktop-stream",
  "browser-view",
  "browser-control",
  "shell-jobs",
  "project-files",
  // Browser `type`, `hotkey`, `scroll` and `upload` (user, 2026-11-20: 「允许部署客户端」).
  "browser-input",
] as const;

export type DeviceFeature = (typeof DEVICE_FEATURES)[number];

export const DEVICE_FEATURES_HEADER = "x-yesimbot-device-features";

/** Known features in a comma-separated header or list; unknown tokens are ignored so newer peers stay compatible. */
export function parseDeviceFeatures(value: unknown): DeviceFeature[] {
  const tokens = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return DEVICE_FEATURES.filter((feature) => tokens.some((token) => typeof token === "string" && token.trim() === feature));
}

/** The client's release version, announced per connection like the features. */
export const DEVICE_VERSION_HEADER = "x-yesimbot-device-version";

/** A release version such as `2026.1107.1930`; anything else is dropped rather than shown. */
export function parseDeviceVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9]{1,6}(\.[0-9]{1,6}){1,3}$/.test(value.trim()) ? value.trim() : undefined;
}

/** Project directories a client's owner opened to the file tools, announced per connection like the version. */
export const DEVICE_ROOTS_HEADER = "x-yesimbot-device-roots";

export const MAX_PROJECT_ROOTS = 32;

/** Header value for `DEVICE_ROOTS_HEADER`: URI-encoded JSON, so any path stays a valid header value. */
export function encodeDeviceRoots(roots: readonly string[]): string {
  return encodeURIComponent(JSON.stringify(roots));
}

/** Absolute-looking paths from the header; anything malformed drops the whole list rather than part of it. */
export function parseDeviceRoots(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value || value.length > 64 * 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > MAX_PROJECT_ROOTS) return undefined;
    const valid = (item: unknown): item is string =>
      // A path with control characters is refused, not shown.
      // eslint-disable-next-line no-control-regex
      typeof item === "string" && item.length <= 1024 && !/[\u0000-\u001f]/.test(item) && (item.startsWith("/") || /^[A-Za-z]:[\\/]/.test(item));
    return parsed.every(valid) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export type DeviceView = DeviceRecord & {
  online: boolean;
  health?: Partial<Record<DeviceCapability, boolean>>;
  features?: DeviceFeature[];
  /** Release version of the connected client; absent for older clients and gateways. */
  version?: string;
  /** Project directories the client's owner opened to file tools (`project-files`); absent when none. */
  projectRoots?: string[];
};

export const deviceCredentialSchema = z
  .object({
    version: z.literal(1),
    deviceId: uuid,
    tenantId: uuid,
    secret: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type DeviceCredential = z.infer<typeof deviceCredentialSchema>;

export const enrollmentSchema = z
  .object({
    code: z.string().regex(/^[a-f0-9]{48}$/),
    name: deviceRecordSchema.shape.name,
    platform: deviceRecordSchema.shape.platform,
    capabilities: capabilitiesSchema,
  })
  .strict();

export type DeviceEnrollment = z.infer<typeof enrollmentSchema>;

export const deviceInvocationSchema = z
  .object({
    operationId: uuid,
    capability: capabilitySchema,
    method: opaqueId,
    conversation: conversationSchema,
    actors: z.array(actorSchema).max(128),
    input: z.unknown(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export type DeviceInvocation = z.infer<typeof deviceInvocationSchema>;

export function deviceInputLimit(invocation: Pick<DeviceInvocation, "capability" | "method">): number {
  return invocation.capability === "workspace.files" && invocation.method === "write" ? MAX_DEVICE_FILE_INPUT_BYTES : MAX_DEVICE_INPUT_BYTES;
}

/** Reserved conversation label of the owner's WebUI screen view; never a chat platform. */
export const SCREEN_VIEW_PLATFORM = "yesimbot-viewer";

/** The desktop's screen-view reads: a desktop batch without actions, and agent-desktop's screenshot. */
export const SCREEN_VIEW_READS = {
  execute: { actions: [] },
  ui: { tool: "screenshot", args: {} },
} as const;

/** The bot browser's screen-view read (`computer.browser` `execute`): the tab the bot last used, else the first tab. Never a bot action. */
export const BROWSER_VIEW_READ = { action: "view" } as const;

/**
 * A screen-view read has no side effect, so replaying it is harmless and it is not written to the
 * gateway or client operation ledgers (which keep every result forever to prevent duplicate effects).
 * Exact match only: any other input, method, scope or actor is an ordinary ledgered operation.
 */
export function isScreenViewRead(invocation: DeviceInvocation): boolean {
  if (invocation.conversation.platform !== SCREEN_VIEW_PLATFORM || invocation.actors.length) return false;
  const input = invocation.input;
  if (invocation.capability === "computer.browser")
    return invocation.method === "execute" && plain(input, ["action"]) && input.action === BROWSER_VIEW_READ.action;
  if (invocation.capability !== "computer.desktop") return false;
  if (invocation.method === "execute") return plain(input, ["actions"]) && Array.isArray(input.actions) && input.actions.length === 0;
  if (invocation.method !== "ui" || !plain(input, ["args", "tool"]) || input.tool !== SCREEN_VIEW_READS.ui.tool) return false;
  return plain(input.args, []);
}

function plain(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

export const operationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), output: z.unknown() }).strict(),
  z.object({ status: z.literal("failed"), code: opaqueId }).strict(),
  z.object({ status: z.literal("unknown"), code: opaqueId }).strict(),
  z.object({ status: z.literal("rejected"), code: opaqueId }).strict(),
]);

export type OperationResult = z.infer<typeof operationResultSchema>;

const desktopData = z
  .string()
  .max(90_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const DESKTOP_CHUNK_BYTES = 64 * 1024;

export interface DesktopReceiver {
  data(bytes: Uint8Array): void;
  close(): void;
}

export interface DesktopTunnel {
  send(bytes: Uint8Array): void;
  close(): void;
}

const controlPoint = { x: z.number().int().min(0).max(16383), y: z.number().int().min(0).max(16383) };
/**
 * One input of the owner's manual takeover, in pixels of the picture the owner sees. Keys are xdotool-style
 * combos (`ctrl+a`, `shift+Tab`, `Return`); `scroll` is wheel notches, positive upwards.
 */
export const controlActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      ...controlPoint,
      button: z.enum(["left", "right", "middle"]).default("left"),
      count: z.number().int().min(1).max(2).optional(),
    })
    .strict(),
  z.object({ type: z.literal("move"), ...controlPoint }).strict(),
  z.object({ type: z.literal("drag"), ...controlPoint, toX: controlPoint.x, toY: controlPoint.y }).strict(),
  z.object({ type: z.literal("scroll"), ...controlPoint, dy: z.number().int().min(-10).max(10) }).strict(),
  z
    .object({
      type: z.literal("key"),
      key: z
        .string()
        .regex(
          /^(?:(?:ctrl|alt|shift|cmd)\+){0,3}(?:[a-z0-9]|F(?:[1-9]|1[0-2])|Return|Tab|Escape|BackSpace|Delete|Left|Right|Up|Down|Home|End|Page_Up|Page_Down|space)$/,
        ),
    })
    .strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(4000) }).strict(),
]);

export type ControlAction = z.infer<typeof controlActionSchema>;

/** The owner's takeover input to the bot browser (`computer.browser` `execute`); `action` in pixels of the browser view. */
export const browserControlInputSchema = z.object({ action: z.literal("control"), input: controlActionSchema }).strict();

/** Exact reserved scope of a manual takeover input (the same as the desktop's); never a model tool. */
function isControlScope(invocation: DeviceInvocation): boolean {
  const scope = invocation.conversation;
  return (
    scope.platform === SCREEN_VIEW_PLATFORM &&
    scope.botId === "webui" &&
    scope.kind === "direct" &&
    scope.conversationId === "control" &&
    !scope.parentId &&
    invocation.actors.length === 0
  );
}

/** The owner's takeover input to the bot browser. It is an ordinary, journaled operation; only its scope makes it the owner's. */
export function isBrowserControl(invocation: DeviceInvocation): boolean {
  return (
    invocation.capability === "computer.browser" &&
    invocation.method === "execute" &&
    isControlScope(invocation) &&
    browserControlInputSchema.safeParse(invocation.input).success
  );
}

/** Exact reserved scope for an ephemeral, manually leased remote desktop; never a model tool. */
export function isDesktopStream(invocation: DeviceInvocation): boolean {
  const scope = invocation.conversation;
  return (
    invocation.capability === "computer.desktop" &&
    invocation.method === "remote" &&
    scope.platform === SCREEN_VIEW_PLATFORM &&
    scope.botId === "webui" &&
    scope.kind === "direct" &&
    scope.conversationId === "control" &&
    !scope.parentId &&
    invocation.actors.length === 0 &&
    !!invocation.input &&
    typeof invocation.input === "object" &&
    !Array.isArray(invocation.input) &&
    Object.keys(invocation.input).length === 0
  );
}

export const serverFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), version: z.literal(1), connectionId: uuid, device: deviceRecordSchema }).strict(),
  z.object({ type: z.literal("invoke"), connectionId: uuid, requestId: uuid, invocation: deviceInvocationSchema }).strict(),
  z.object({ type: z.literal("status"), connectionId: uuid, requestId: uuid, operationId: uuid }).strict(),
  z.object({ type: z.literal("cancel"), connectionId: uuid, operationId: uuid }).strict(),
  z.object({ type: z.literal("desktop-open"), connectionId: uuid, streamId: uuid, invocation: deviceInvocationSchema }).strict(),
  z.object({ type: z.literal("desktop-data"), connectionId: uuid, streamId: uuid, data: desktopData }).strict(),
  z.object({ type: z.literal("desktop-close"), connectionId: uuid, streamId: uuid }).strict(),
]);

export type DeviceServerFrame = z.infer<typeof serverFrameSchema>;

export const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("desktop-data"), connectionId: uuid, streamId: uuid, data: desktopData }).strict(),
  z.object({ type: z.literal("desktop-close"), connectionId: uuid, streamId: uuid }).strict(),
  z.object({ type: z.literal("health"), connectionId: uuid, health: deviceHealthSchema }).strict(),
  z.object({ type: z.literal("hello"), version: z.literal(1), deviceId: uuid, capabilities: capabilitiesSchema }).strict(),
  z.object({ type: z.literal("result"), connectionId: uuid, requestId: uuid, operationId: uuid, result: operationResultSchema }).strict(),
]);

export type DeviceClientFrame = z.infer<typeof clientFrameSchema>;

/** The same authenticated contract is used by local and remote device transports. */
export interface DeviceTransport {
  /** Authenticated, local-policy-checked remote desktop. Only Core's manual lease holder may open it. */
  openDesktop?(deviceId: string, invocation: DeviceInvocation, receiver: DesktopReceiver, signal: AbortSignal): Promise<DesktopTunnel>;
  list(): Promise<DeviceView[]>;
  pair(): Promise<{ code: string; expiresAt: number }>;
  revoke(deviceId: string): Promise<void>;
  invoke(deviceId: string, invocation: DeviceInvocation, signal?: AbortSignal): Promise<OperationResult>;
  status(deviceId: string, operationId: string, signal?: AbortSignal): Promise<OperationResult>;
}

export function parseDeviceFrame<T>(text: string, schema: z.ZodType<T>): T {
  if (new TextEncoder().encode(text).length > MAX_DEVICE_FRAME_BYTES) throw new Error("device_frame_too_large");
  return schema.parse(JSON.parse(text));
}

export function deviceUrl(base: string, path: string, allowLoopback = false): URL {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid_gateway_url");
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("secure_gateway_required");
  }
  return new URL(path, url);
}

/** 10/8, 172.16/12 and 192.168/16: host-internal bridges (Docker, libvirt), never a public network. */
function privateIPv4(hostname: string): boolean {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)?.slice(1).map(Number);
  if (!parts || parts.some((part) => part > 255)) return false;
  const [a, b] = parts as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The same gateway reached on the machine it runs on: cleartext HTTP to a private IPv4 address with a
 * port, as a container or VM sees its host bridge. Traffic never leaves that machine; the public
 * `deviceUrl` stays the address everything else uses.
 */
export function localGatewayUrl(base: string, path: string): URL {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid_gateway_url");
  if (url.protocol !== "http:" || !url.port || !privateIPv4(url.hostname)) throw new Error("invalid_local_gateway_url");
  return new URL(path, url);
}
