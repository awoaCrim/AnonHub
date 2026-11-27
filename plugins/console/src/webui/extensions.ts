import { AppError, isRecord, toHttp } from "@yesimbot/foundation";

import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { ExtensionItem } from "../shared/extensions.js";
import { authorizeOwner } from "./plugins.js";

const PATH = "/yesimbot/api/v1/extensions";

/** The host's installs as 我的扩展 lists them. */
export function extensionItems(host: Pick<Host, "extensions">): ExtensionItem[] {
  return host.extensions.list().map((item) => {
    const status: ExtensionItem["status"] = item.installing ? "installing" : item.error ? "failed" : (item.state?.state ?? "disabled");
    const error = item.error ?? (item.state?.state === "failed" ? item.state.error?.code : undefined);
    return {
      name: item.name,
      ...(item.version ? { version: item.version } : {}),
      ...(item.module ? { module: item.module } : {}),
      status,
      ...(error ? { error } : {}),
    };
  });
}

/**
 * 我的扩展: what this instance installed from npm. `install` answers at once (202) and the list shows how it goes;
 * `remove` stops the extension and deletes its settings and files. Its settings are its module's, edited like any other.
 */
export function installExtensions(ctx: Host, auth: AdminAuth) {
  ctx.server.get(PATH, (http) => {
    if (!authorizeOwner(http, auth)) return;
    http.body = { items: extensionItems(ctx) };
  });
  ctx.server.post(PATH, async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    const cookie = http.get("cookie");
    const session = auth.sessionFromCookie(cookie);
    try {
      const body: unknown = await readAdminLoginBody(http, 16 * 1024);
      // Signed out while the body arrived.
      if (auth.sessionFromCookie(cookie) !== session) {
        http.status = 401;
        http.body = { message: "login_required" };
        return;
      }
      if (!isRecord(body)) throw new AppError("input_invalid", { effect: "none" });
      if (body.action === "install") {
        http.body = ctx.extensions.install(body.name, body.version);
        http.status = 202;
      } else if (body.action === "remove") {
        await ctx.extensions.remove(body.name);
        http.body = { ok: true };
      } else throw new AppError("input_invalid", { effect: "none" });
    } catch (error) {
      const { status, body } = toHttp(error);
      http.status = status;
      http.body = { message: body.code };
    }
  });
}
