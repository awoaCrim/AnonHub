import { resolve } from "node:path";

import { platformDefinition } from "@yesimbot/contracts/platforms";
import { NapCatGateway, type NapCatLoginStep, type NapCatStatus } from "@yesimbot/onebot/napcat";

import { readAdminLoginBody, type AdminAuth, type AdminHttpContext } from "./admin-auth.js";
import type { Host } from "./host.js";
import type { QQPresence } from "./qq-presence.js";

/** Koishi `Status.ONLINE`. */
const ONLINE = 1;
/** How often the console asks NapCat whether its QQ is online. */
const PRESENCE_INTERVAL = 30_000;

type RecordValue = Record<string, unknown>;

export interface NapCatConfig {
  enabled: boolean;
  endpoint: string;
  webuiConfigFile: string;
}

export function installNapCatGateway(ctx: Host, config: NapCatConfig, auth: AdminAuth, presence?: QQPresence): void {
  if (!config.enabled) return;
  const gateway = new NapCatGateway({ endpoint: config.endpoint, webuiConfigFile: resolve(ctx.baseDir, config.webuiConfigFile) });
  if (presence) {
    // The platform state (平台's dot, the overview, members' health) follows NapCat, not only the OneBot link.
    const check = () =>
      void gateway.presence().then(
        (report) => presence.update(report),
        () => {},
      );
    ctx.on("ready", () => {
      check();
      ctx.setInterval(check, PRESENCE_INTERVAL);
    });
  }
  const allowed = (http: AdminHttpContext, write = false) => {
    if (!auth.requireOwner(http)) return false;
    if (write && !auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "Same-origin request required." };
      return false;
    }
    return true;
  };
  ctx.server.get("/yesimbot/napcat/status", async (http) => {
    if (!allowed(http)) return;
    const status = await gateway.status();
    // Opening 平台 refreshes the platform state at once instead of at the next check.
    if (status.available) presence?.update({ offline: status.loggedIn && status.online === false, accountId: status.accountId });
    http.body = withBotPresence(status, ctx.bots);
  });
  ctx.server.get("/yesimbot/napcat/qrcode", async (http) => {
    if (allowed(http)) http.body = await gateway.qrcode();
  });
  ctx.server.post("/yesimbot/napcat/logout", async (http) => {
    if (!allowed(http, true)) return;
    try {
      http.body = await gateway.logout();
      http.status = 202;
    } catch {
      http.status = 502;
      http.body = { message: "Cannot request QQ logout. Check NapCat availability and server-side configuration." };
    }
  });
  ctx.server.post("/yesimbot/napcat/qrcode/refresh", async (http) => {
    if (allowed(http, true)) http.body = await gateway.refreshQr();
  });
  /** Reads a small JSON object; invalid input answers 400 before NapCat is called. */
  const loginRoute = (path: string, step: (body: RecordValue) => Promise<NapCatLoginStep> | undefined) =>
    ctx.server.post(`/yesimbot/napcat/login/${path}`, async (http) => {
      if (!allowed(http, true)) return;
      let pending: Promise<NapCatLoginStep> | undefined;
      try {
        pending = step(record(await readAdminLoginBody(http, 8192)));
      } catch {
        pending = undefined;
      }
      if (!pending) {
        http.status = 400;
        http.body = { message: "Invalid QQ login request." };
        return;
      }
      try {
        http.body = await pending;
      } catch {
        http.status = 502;
        http.body = { message: "Cannot reach the QQ login service. Check NapCat availability and server-side configuration." };
      }
    });
  loginRoute("password", ({ uin, password }) =>
    typeof uin === "string" && /^[1-9]\d{4,11}$/.test(uin) && typeof password === "string" && password && password.length <= 128
      ? gateway.passwordLogin(uin, password)
      : undefined,
  );
  loginRoute("captcha", ({ ticket, randstr }) =>
    typeof ticket === "string" && ticket && ticket.length <= 4096 && typeof randstr === "string" && randstr && randstr.length <= 512
      ? gateway.captchaLogin(ticket, randstr)
      : undefined,
  );
  loginRoute("device", ({ renew }) => (renew === undefined || typeof renew === "boolean" ? gateway.deviceLogin(renew === true) : undefined));
  ctx.server.post("/yesimbot/napcat/login/cancel", async (http) => {
    if (!allowed(http, true)) return;
    await gateway.cancelLogin();
    http.body = {};
  });
}

/**
 * NapCat's WebUI is only the login service. When it cannot be read, a QQ bot that is online still proves the
 * account is signed in, so an unreadable login service never turns an online QQ into a login page.
 */
export function withBotPresence(
  status: NapCatStatus,
  bots: readonly { platform?: string; selfId?: string; status: number; user?: { name?: string; nick?: string } }[],
): NapCatStatus {
  if (status.available || status.loggedIn) return status;
  const bot = bots.find((candidate) => platformDefinition(candidate.platform ?? "")?.login === "napcat" && candidate.status === ONLINE && candidate.selfId);
  if (!bot) return status;
  const accountId = bot.selfId!;
  return {
    available: false,
    loggedIn: true,
    online: true,
    accountId,
    nickname: bot.user?.nick || bot.user?.name || undefined,
    avatarUrl: /^[1-9]\d{0,19}$/.test(accountId) ? `https://q1.qlogo.cn/g?b=qq&nk=${accountId}&s=140` : undefined,
    message: "QQ is online, but its login service cannot be read right now.",
  };
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" ? (value as RecordValue) : {};
}
