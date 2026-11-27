import { detectImageType, newId } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";

import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host, HttpContext } from "../host.js";
import { IMAGE_MAX_BYTES, isControl } from "./chat-attachments.js";
import { authorizeOwner } from "./plugins.js";

const MAX_BYTES = 8 * 1024 * 1024;
/** An upload fails once nothing has arrived for this long, */
const UPLOAD_IDLE_MS = 15_000;
/** and in any case after this long: a slow link still finishes, a trickle cannot hold the request forever. */
const UPLOAD_TOTAL_MS = 5 * 60_000;

export interface Upload {
  id: string;
  name: string;
  kind: "image" | "file";
  /** An image in the conversation's own assets: the bot sees it directly, and no computer is needed. */
  asset?: string;
  /** The copy on the conversation's computer, and the computer that holds it. */
  uri?: string;
  deviceId?: string;
  scope: string;
  expires: number;
}

/**
 * Uploads are account-local, bounded, and tied to the actual conversation. An image (PNG, JPEG, GIF or WebP
 * up to {@link IMAGE_MAX_BYTES}) is kept in the conversation's own assets, plus a copy on its computer when
 * one is connected; any other file needs that computer.
 */
/**
 * `core` is the running Core service (`undefined` while it is stopped). The console plugin does not inject
 * `yesimbot`, so reading it off the context logged a warning on every status poll (seen 2026-11-18).
 */
export function installChatUploads(ctx: Host, auth: AdminAuth, current: () => Promise<ChannelContext>, core: () => Host["yesimbot"] | undefined) {
  const uploads = new Map<string, Upload>();
  const prune = () => {
    for (const [id, file] of uploads) if (file.expires < ctx.clock.now()) uploads.delete(id);
  };
  const key = (scope: ChannelContext) => JSON.stringify(scope);
  async function connected(scope: ChannelContext) {
    const devices = core()?.devices;
    if (!devices) throw Error("upload_computer_unavailable");
    const deviceId = devices.workspaceDevice(scope);
    if (!deviceId) throw Error("upload_computer_required");
    const device = (await devices.list()).find((d) => d.deviceId === deviceId && !d.revokedAt);
    if (!device?.online || !device.capabilities.includes("workspace.files")) throw Error("upload_computer_unavailable");
    return deviceId;
  }

  async function uploadLimit(deviceId: string) {
    const device = ((await core()?.devices.list()) ?? []).find((d) => d.deviceId === deviceId);
    return device?.features?.includes("file-upload-8m") ? MAX_BYTES : 180 * 1024;
  }
  /** Images can always be sent; `files` says whether a computer takes other files, up to `maxBytes`. */
  ctx.server.get("/yesimbot/api/v1/chat/uploads", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    // Core is not running: nothing can be kept.
    const available = !!core()?.resource;
    try {
      const deviceId = await connected(await current());
      http.body = { available, files: available, maxBytes: await uploadLimit(deviceId), imageMaxBytes: IMAGE_MAX_BYTES };
    } catch {
      http.body = { available, files: false, maxBytes: MAX_BYTES, imageMaxBytes: IMAGE_MAX_BYTES };
    }
  });
  ctx.server.post("/yesimbot/api/v1/chat/uploads", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    const session = auth.sessionFromCookie(http.get("cookie"));
    try {
      prune();
      if (uploads.size >= 64) throw Error("upload_limit");
      if (!session) throw Error("login_required");
      const scope = { ...(await current()) },
        scopeKey = key(scope);
      // A file needs the computer; an image does not, but gets a copy there when it is connected.
      const computer = await connected(scope).then(
        (deviceId) => ({ deviceId, error: "" }),
        (error: unknown) => ({ deviceId: undefined, error: error instanceof Error ? error.message : "upload_computer_unavailable" }),
      );
      const fileLimit = computer.deviceId ? await uploadLimit(computer.deviceId) : 0;
      const verifyTarget = async (deviceId?: string) => {
        const active = await current();
        if (auth.sessionFromCookie(http.get("cookie")) !== session) throw Error("login_required");
        if (key(active) !== scopeKey || (deviceId !== undefined && core()?.devices.workspaceDevice(scope) !== deviceId)) throw Error("upload_target_changed");
      };
      const type = http.get("content-type").split(";", 1)[0].trim().toLowerCase();
      let originalName: string, bytes: Buffer;
      if (type === "application/octet-stream") {
        originalName = uploadName(http.query.name);
        bytes = await readRaw(http, Math.max(IMAGE_MAX_BYTES, fileLimit));
        if (!bytes.length) throw Error("invalid_upload");
      } else {
        if (type !== "application/json") throw Error("invalid_upload");
        const body = (await readAdminLoginBody(http, 12 * 1024 * 1024)) as Record<string, unknown>;
        originalName = uploadName(body?.name);
        if (typeof body.data !== "string" || body.data.length > Math.ceil(MAX_BYTES / 3) * 4) throw Error("invalid_upload");
        bytes = Buffer.from(body.data, "base64");
        if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString("base64") !== body.data) throw Error("invalid_upload");
      }
      const image = !!detectImageType(bytes);
      // A larger image goes only to the computer, like any other file.
      const shown = image && bytes.length <= IMAGE_MAX_BYTES;
      if (!shown) {
        if (!computer.deviceId) throw Error(computer.error);
        if (bytes.length > fileLimit) throw Error("upload_client_limit");
      }
      await verifyTarget(shown ? undefined : computer.deviceId);
      const id = newId();
      const name = [...originalName].map((char) => (/[<>:"|?*\\/]/.test(char) || isControl(char) ? "_" : char)).join("");
      const resource = core()?.resource;
      if (shown && !resource) throw Error("upload_computer_unavailable");
      const asset = shown ? await (await resource!.get(scope)).assets.put(bytes) : undefined;
      let copy: { uri: string; deviceId: string } | undefined;
      if (computer.deviceId && bytes.length <= fileLimit) {
        try {
          const path = `${id}-${name.replace(/[. ]+$/, "_")}`;
          const devices = core()?.devices;
          if (!devices) throw Error("upload_computer_unavailable");
          const result = await devices.invoke(
            computer.deviceId,
            {
              scope,
              actors: scope.type === "direct" ? [{ platform: scope.platform, userId: scope.userId }] : [],
              operationId: id,
              capability: "workspace.files",
              method: "write",
              input: { path, data: bytes.toString("base64") },
              expiresAt: ctx.clock.now() + 30_000,
            },
            AbortSignal.timeout(30_000),
          );
          if (result.status !== "succeeded") throw Error("upload_not_confirmed");
          await verifyTarget(computer.deviceId);
          copy = { uri: `workspace:///${path}`, deviceId: computer.deviceId };
        } catch (error) {
          // The image itself is already in the conversation; only its copy on the computer is missing.
          if (!asset) throw error;
        }
      }
      await verifyTarget();
      const file: Upload = {
        id,
        name,
        kind: image ? "image" : "file",
        ...(asset ? { asset } : {}),
        ...copy,
        scope: scopeKey,
        expires: ctx.clock.now() + 60 * 60_000,
      };
      uploads.set(id, file);
      http.body = { id, name, kind: file.kind };
    } catch (error) {
      http.status = 400;
      const code = error instanceof Error ? error.message : "";
      http.body = {
        message: [
          "upload_client_limit",
          "upload_computer_required",
          "upload_computer_unavailable",
          "invalid_upload",
          "upload_limit",
          "upload_target_changed",
          "upload_not_confirmed",
          "login_required",
        ].includes(code)
          ? code
          : "upload_failed",
      };
    }
  });
  return {
    /** The uploads for one send. A copy on a computer the conversation no longer uses is dropped; a file that has only that copy expires. */
    async resolve(ids: readonly string[], scope: ChannelContext): Promise<Upload[]> {
      prune();
      const deviceId = await connected(scope).catch(() => undefined);
      return ids.map((id) => {
        const file = uploads.get(id);
        if (!file || file.scope !== key(scope)) throw Error("upload_expired");
        if (!file.uri || file.deviceId === deviceId) return file;
        if (!file.asset) throw Error("upload_expired");
        return { ...file, uri: undefined, deviceId: undefined };
      });
    },
  };
}

/**
 * Count actual stream bytes; Content-Length never grants permission to buffer more. The wait is for silence, not for the
 * whole body (user, 2026-11-27: 「我一个3m的图片上传不了」): over the public link a 3 MB image takes about 15 s, and a
 * fixed 10 s for the whole body turned every such upload into 上传未能确认.
 */
export async function readRaw(http: HttpContext, limit: number): Promise<Buffer> {
  const req = http.req;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const cleanup = () => {
      clearTimeout(idle);
      clearTimeout(total);
      req.off("data", data);
      req.off("end", end);
      req.off("error", invalid);
      req.off("aborted", invalid);
      req.off("close", close);
    };
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      req.off("data", data);
      req.off("aborted", invalid);
      // An aborted request can still emit ECONNRESET. Keep error/end/close handlers until draining finishes.
      req.resume();
      reject(Error(code));
    };
    const invalid = () => fail("invalid_upload");
    const data = (chunk: Buffer | string) => {
      idle.refresh();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) fail("upload_client_limit");
      else chunks.push(buffer);
    };
    const end = () => {
      const complete = !settled;
      settled = true;
      cleanup();
      if (complete) resolve(Buffer.concat(chunks, size));
    };
    const close = () => {
      invalid();
      cleanup();
    };
    const expire = () => {
      invalid();
      req.destroy();
    };
    const idle = setTimeout(expire, UPLOAD_IDLE_MS);
    const total = setTimeout(expire, UPLOAD_TOTAL_MS);
    req.on("data", data);
    req.once("end", end);
    req.on("error", invalid);
    req.once("aborted", invalid);
    req.once("close", close);
    if (req.aborted || req.destroyed || req.readableEnded) {
      invalid();
      if (req.closed) cleanup();
    }
  });
}

function uploadName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw Error("invalid_upload");
  return value;
}
