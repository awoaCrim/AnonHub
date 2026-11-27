import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Host } from "./host.js";

// The managed distribution connects NapCat through loopback, and the QQ connector checks a token only when one is
// set, so a connection to /onebot is admitted only straight from loopback.
export function installManagedOneBotIngress(ctx: Host): void {
  const guard = (request: IncomingMessage, socket: Duplex) => {
    if (!/^\/onebot(?:[/?]|$)/.test(request.url ?? "")) return;
    const address = request.socket.remoteAddress;
    const forwarded = ["origin", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"].some(
      (name) => request.headers?.[name] !== undefined,
    );
    if (!forwarded && (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1")) return;
    socket.destroy();
  };
  const server = ctx.server.http;
  server.prependListener("upgrade", guard);
  ctx.on("dispose", () => {
    server.removeListener("upgrade", guard);
  });
}
