import { randomUUID } from "node:crypto";

import { detectImageType } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";

import type { AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import { authorizeOwner, type HttpContext } from "./plugins.js";

export const ATTACHMENT_PATH = "/yesimbot/api/v1/chat/attachment";

/** Core's bound for one image it reads: an image the bot is shown directly is never larger. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const FILE_MAX_BYTES = 8 * 1024 * 1024;

const ASSET_ID = /^[a-f0-9]{32}$/;

/** What chat uploads name their copy on the computer: `<uuid>-<name>` at the conversation's root, nothing else. */
const UPLOAD_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

type Core = Host["yesimbot"];

/** An image or file in the conversation's own assets. */
export const assetUrl = (conversation: string, asset: string, name: string) => `${ATTACHMENT_PATH}?${new URLSearchParams({ c: conversation, asset, name })}`;

/** A chat upload's copy on the conversation's computer; readable only while that computer is online. */
export const computerFileUrl = (conversation: string, path: string, name: string) =>
  `${ATTACHMENT_PATH}?${new URLSearchParams({ c: conversation, file: path, name })}`;

/** The path of a chat upload's `workspace:///` reference, or undefined for anything else. */
export function uploadPath(uri: string | undefined): string | undefined {
  const path = uri?.startsWith("workspace:///") ? uri.slice("workspace:///".length) : undefined;
  return path && isUploadPath(path) ? path : undefined;
}

/**
 * Shows the web chat's images and files to the account holder: from the conversation's own assets, or the
 * upload's copy on its computer. Only images and plain text are shown in place; anything else downloads,
 * and nothing it serves can run in the console's origin.
 */
export function installChatAttachments(
  ctx: Host,
  auth: AdminAuth,
  source: { core(): Core | undefined; context(conversation: string): Promise<ChannelContext | undefined> },
) {
  ctx.server.get(ATTACHMENT_PATH, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const core = source.core();
    const { c: conversation, asset, file, name } = http.query;
    const context = core && typeof conversation === "string" ? await source.context(conversation) : undefined;
    if (!core || !context) return fail(http, 404, "attachment_not_found");
    let bytes: Uint8Array;
    try {
      if (typeof asset === "string" && ASSET_ID.test(asset)) bytes = await (await core.resource.get(context)).assets.get(asset, { maxBytes: FILE_MAX_BYTES });
      else if (typeof file === "string" && isUploadPath(file)) bytes = await readComputerFile(core, context, file, ctx.clock.now());
      else return fail(http, 400, "invalid_attachment");
    } catch (error) {
      return error instanceof Error && error.message === "computer_offline" ? fail(http, 409, "computer_offline") : fail(http, 404, "attachment_not_found");
    }
    // An asset's ID is its content, so it never changes; a computer's copy is read fresh each time.
    sendStoredFile(http, bytes, typeof name === "string" ? name : undefined, http.query.download === "1", typeof asset === "string");
  });
}

/**
 * Serves a stored image or file to the account holder: images and plain text in place, anything else as a download,
 * and nothing it serves can run in the console's origin (also used for memory attachments).
 */
export function sendStoredFile(http: HttpContext, bytes: Uint8Array, name: string | undefined, download: boolean, cacheable: boolean): void {
  const type = detectImageType(bytes) ?? (isText(bytes) ? "text/plain; charset=utf-8" : "application/octet-stream");
  const filename = (name?.trim() ? name : "attachment")
    .split("")
    .map((char) => (isControl(char) || char === '"' || char === "\\" || char === "/" ? "_" : char))
    .join("")
    .slice(0, 200);
  http.set("Content-Type", type);
  http.set(
    "Content-Disposition",
    `${download || type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  http.set("X-Content-Type-Options", "nosniff");
  http.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  http.set("Cross-Origin-Resource-Policy", "same-origin");
  if (cacheable) http.set("Cache-Control", "private, max-age=3600");
  http.body = Buffer.from(bytes);
}

/** A character below U+0020, or DEL. */
export function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** Text a person can read: valid UTF-8 without NUL bytes. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function readComputerFile(core: Core, context: ChannelContext, path: string, now: number): Promise<Uint8Array> {
  const deviceId = core.devices.workspaceDevice(context);
  const device = deviceId ? (await core.devices.list()).find((item) => item.deviceId === deviceId && !item.revokedAt) : undefined;
  if (!deviceId || !device?.online || !device.capabilities.includes("workspace.files")) throw Error("computer_offline");
  const result = await core.devices.invoke(
    deviceId,
    {
      scope: context,
      actors: context.type === "direct" ? [{ platform: context.platform, userId: context.userId }] : [],
      operationId: randomUUID(),
      capability: "workspace.files",
      method: "read",
      input: { path },
      expiresAt: now + 30_000,
    },
    AbortSignal.timeout(30_000),
  );
  const data = (result.status === "succeeded" ? (result.output as { data?: unknown } | undefined) : undefined)?.data;
  if (typeof data !== "string" || data.length > Math.ceil(FILE_MAX_BYTES / 3) * 4) throw Error("attachment_not_found");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw Error("attachment_not_found");
  return bytes;
}

function fail(http: HttpContext, status: number, message: string) {
  http.status = status;
  http.body = { message };
}

/** `<uuid>-<name>`: a name of 1 to 200 characters with no path separator or control character. */
function isUploadPath(value: string): boolean {
  const name = value.slice(37);
  return UPLOAD_PREFIX.test(value) && name.length >= 1 && name.length <= 200 && ![...name].some((char) => char === "/" || char === "\\" || isControl(char));
}
