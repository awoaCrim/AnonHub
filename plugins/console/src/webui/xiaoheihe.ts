import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import { XIAOHEIHE_PATH, type XiaoheiheConnection } from "../shared/xiaoheihe.js";
import { authorizeOwner } from "./plugins.js";

/** The slice of the extension's service the console uses; read through `ctx.get`, with no package dependency. */
interface XiaoheiheService {
  status(): Omit<Extract<XiaoheiheConnection, { available: true }>, "available">;
  startWebLogin(): Promise<void>;
}

/**
 * The 服务连接 card for Xiaoheihe: the configured account, whether it is logged in, and the QR login.
 * Owner only. The extension runs nothing on its own; this is the one place a login is started.
 */
export function installXiaoheihe(ctx: Host, auth: AdminAuth): void {
  const service = () => ctx.get("yesimbotXiaoheihe") as XiaoheiheService | undefined;
  const view = (): XiaoheiheConnection => {
    const running = service();
    return running ? { available: true, ...running.status() } : { available: false };
  };
  ctx.server.get(XIAOHEIHE_PATH, (http) => {
    if (authorizeOwner(http, auth)) http.body = view();
  });
  ctx.server.post(`${XIAOHEIHE_PATH}/login`, async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    try {
      const body = (await readAdminLoginBody(http, 4096)) as Record<string, unknown>;
      if (!body || Object.keys(body).length) throw new Error("invalid_request");
      const running = service();
      if (!running) {
        http.status = 409;
        http.body = { message: "xiaoheihe_unavailable" };
        return;
      }
      await running.startWebLogin();
      http.body = view();
    } catch {
      http.status = 400;
      http.body = { message: "login_failed" };
    }
  });
}
