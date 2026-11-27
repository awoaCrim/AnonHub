import { memberId } from "../accounts.js";
import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host, HttpContext } from "../host.js";
import { ManagerError, type TenantManagerClient } from "../tenant-manager-client.js";

export const INSTANCE_RESTART_PATH = "/yesimbot/admin/instances/restart";

export const INSTANCE_NAPCAT_PREFIX = "/yesimbot/admin/instances";

/** The owner's own QQ login UI uses exactly these NapCat routes; a friend's QQ is relayed on the same set and nothing else. */
const NAPCAT_GET = ["status", "qrcode"] as const;

const NAPCAT_POST = ["logout", "qrcode/refresh", "login/password", "login/captcha", "login/device", "login/cancel"] as const;

/** What the relay lets through; a friend's own auth failures are not the owner's, so they never surface as 401/403. */
const PASS = new Set([200, 202, 400, 409, 429, 502, 503]);

type Manager = Pick<TenantManagerClient, "restart" | "napcat">;

/**
 * Owner-only operations on any instance: restart its bot or QQ, and sign its QQ in. Under `/yesimbot/admin`,
 * which the tenant proxy keeps for the parent, so a friend's own backend never sees these.
 */
export function installInstanceOps(ctx: Host, auth: AdminAuth, manager: Manager) {
  const gate = (http: HttpContext, write: boolean) => {
    http.set("Cache-Control", "private, no-store");
    if (!auth.requireOwner(http)) return false;
    if (write && !auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "Same-origin request required." };
      return false;
    }
    return true;
  };

  ctx.server.post(INSTANCE_RESTART_PATH, async (http) => {
    if (!gate(http, true)) return;
    let body: { target?: unknown; program?: unknown };
    try {
      body = (await readAdminLoginBody(http, 2048)) as typeof body;
    } catch {
      http.status = 400;
      http.body = { message: "invalid_request" };
      return;
    }
    if (
      !(body.target === "owner" || (typeof body.target === "string" && memberId.test(body.target))) ||
      (body.program !== "koishi" && body.program !== "napcat")
    ) {
      http.status = 400;
      http.body = { message: "invalid_request" };
      return;
    }
    try {
      const { status, ...result } = await manager.restart(body.target as string, body.program);
      http.status = status;
      http.body = result;
    } catch (error) {
      const status = error instanceof ManagerError ? error.status : 0;
      http.status = status === 404 || status === 409 ? status : status === 400 ? 400 : 502;
      http.body = { message: status === 409 ? "runtime_unavailable" : status === 404 ? "not_found" : "restart_failed" };
    }
  });

  const relay = async (http: HttpContext, method: "GET" | "POST", rest: string) => {
    const id = String(http.params.id ?? "");
    if (!memberId.test(id)) {
      http.status = 400;
      http.body = { message: "invalid_account_id" };
      return;
    }
    let payload: unknown;
    if (method === "POST") {
      try {
        payload = await readAdminLoginBody(http, 8192);
      } catch {
        http.status = 400;
        http.body = { message: "Invalid QQ login request." };
        return;
      }
    }
    try {
      const result = await manager.napcat(id, method, rest, payload);
      http.status = PASS.has(result.status) ? result.status : 502;
      http.body = http.status === 502 && !PASS.has(result.status) ? { message: "Cannot reach the QQ login service." } : result.body;
    } catch {
      http.status = 502;
      http.body = { message: "Cannot reach the QQ login service." };
    }
  };
  for (const rest of NAPCAT_GET)
    ctx.server.get(`${INSTANCE_NAPCAT_PREFIX}/:id/napcat/${rest}`, async (http) => {
      if (gate(http, false)) await relay(http, "GET", rest);
    });
  for (const rest of NAPCAT_POST)
    ctx.server.post(`${INSTANCE_NAPCAT_PREFIX}/:id/napcat/${rest}`, async (http) => {
      if (gate(http, true)) await relay(http, "POST", rest);
    });
}
