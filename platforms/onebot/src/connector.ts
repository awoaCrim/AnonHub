import type { IncomingMessage } from "node:http";

import { errorFields, logger, safeEqual } from "@yesimbot/foundation";
import { defineConnector } from "koishi-plugin-yesimbot/kernel";

import { OneBotAccount } from "./account.js";
import { moduleConfig, type Config } from "./config.js";
import { inboundFromEvent } from "./inbound.js";

/**
 * QQ through NapCat (leave-koishi 6.5): NapCat dials `path` as adapter-onebot's reverse WebSocket client, with its
 * `X-Self-ID` and `X-Client-Role: Universal`; the connector puts that QQ account online and hands each event to Core.
 * Without a configured `selfId` the account is whichever QQ NapCat signed in to (the console's QR login): `path` is
 * already this instance's secret, and a different QQ takes the previous one's place. Only `apps/server` runs it (the
 * Koishi adapter-onebot path was removed in leave-koishi stage 8).
 */
export const connector = defineConnector({
  moduleConfig,
  start(ctx) {
    let current: { account: OneBotAccount; off: () => void } | undefined;
    const accountOf = (selfId: string): OneBotAccount => {
      if (current?.account.selfId === selfId) return current.account;
      current?.account.detach();
      current?.off();
      const account: OneBotAccount = new OneBotAccount(selfId, {
        clock: ctx.clock,
        onEvent: (event) => {
          const inbound = inboundFromEvent(event, account, () => ctx.clock.now());
          if (!inbound) return;
          ctx.core.messenger.accept(inbound).catch((error: unknown) => log.warn("event.failed", { routeId: inbound.routeId, ...errorFields(error) }));
        },
      });
      current = { account, off: ctx.account(account) };
      return account;
    };
    if (ctx.config.selfId) accountOf(ctx.config.selfId);
    ctx.ws(
      ctx.config.path,
      // `admits` ran first: the header is a QQ number, and the configured one when there is one.
      (socket, request) => accountOf(header(request, "x-self-id")!).attach(socket),
      (request) => admits(ctx.config, request),
    );
    return () => current?.account.detach();
  },
});

const log = logger("onebot.connector");
const QQ_NUMBER = /^[1-9][0-9]{4,14}$/;

/** Whether a connection is NapCat for this account: its role, a QQ number (the configured one, if any), and the token when one is set. */
export function admits(config: Pick<Config, "selfId" | "token">, request: IncomingMessage): boolean {
  const role = header(request, "x-client-role");
  const selfId = header(request, "x-self-id");
  if (role !== "Universal" || !selfId || !QQ_NUMBER.test(selfId) || (config.selfId !== undefined && selfId !== config.selfId)) {
    log.warn("connection.refused", { reason: role !== "Universal" ? "role" : "self_id" });
    return false;
  }
  if (!config.token) return true;
  const presented =
    header(request, "authorization")?.replace(/^(?:Bearer|Token)\s+/i, "") ?? new URL(request.url ?? "/", "http://host").searchParams.get("access_token") ?? "";
  const valid = safeEqual(presented, config.token);
  if (!valid) log.warn("connection.refused", { reason: "token" });
  return valid;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
