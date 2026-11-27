import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { newSecret, safeEqual } from "@yesimbot/foundation";

import { writePrivateJson } from "./config.js";
import { ClientController } from "./controller.js";
import type { ClientUpdater } from "./updater.js";
import { dashboardHtml, dashboardScript, dashboardStyle } from "./web-ui.js";

export async function startDashboard(controller: ClientController, port = 0, updater?: ClientUpdater) {
  const token = newSecret(32, { encoding: "hex" });
  let origin = "",
    closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  const descriptor = join(controller.options.state, "control", "ui.json");
  async function close(): Promise<void> {
    return (closing ??= (async () => {
      updater?.stop();
      try {
        await controller.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await unlink(descriptor).catch(() => {});
      }
    })());
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (
      !origin ||
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      reply(403, { error: "local_origin_required" });
      return;
    }
    const path = new URL(request.url ?? "/", origin).pathname;
    const assets: Record<string, [string, string]> = {
      "/": ["text/html; charset=utf-8", dashboardHtml],
      "/app.js": ["text/javascript; charset=utf-8", dashboardScript],
      "/style.css": ["text/css; charset=utf-8", dashboardStyle],
    };
    if (request.method === "GET" && assets[path]) {
      response.setHeader("content-type", assets[path]![0]);
      response.end(assets[path]![1]);
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer ") || !safeEqual(authorization.slice(7), token, { format: /^[a-f0-9]{64}$/ })) {
      reply(401, { error: "local_session_required" });
      return;
    }
    try {
      if (request.method === "GET" && path === "/api/snapshot") {
        reply(200, { ...(await controller.snapshot()), ...(updater ? { update: updater.snapshot() } : {}) });
        return;
      }
      if (request.method === "GET" && path === "/api/config") {
        reply(200, await controller.configuration());
        return;
      }
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
        reply(405, { error: "invalid_method" });
        return;
      }
      const body = await readBody(request);
      if (path === "/api/config") await controller.save(body.config, String(body.revision ?? ""));
      else if (path === "/api/pair") await controller.pair(String(body.code ?? ""), String(body.name ?? ""));
      else if (path === "/api/unpair") await controller.unpair();
      else if (path === "/api/start") await controller.start();
      else if (path === "/api/stop") await controller.stop();
      else if (path === "/api/update/check" && updater) {
        // 立即更新 installs right away; 检查更新 only looks, and installs when updates are automatic.
        const install = body.install === true || updater.snapshot().auto;
        const checking = updater.check(install);
        if (!install) await checking;
        reply(200, updater.snapshot());
        return;
      } else if (path === "/api/update/auto" && updater) {
        if (typeof body.auto !== "boolean") throw new Error("invalid_request");
        await updater.setAuto(body.auto);
        reply(200, updater.snapshot());
        return;
      } else if (path === "/api/diagnose") {
        reply(200, await controller.diagnose());
        return;
      } else if (path === "/api/shutdown") {
        reply(200, { ok: true });
        setImmediate(() => {
          void close().catch(() => {
            process.exitCode = 1;
          });
        });
        return;
      } else {
        reply(404, { error: "not_found" });
        return;
      }
      reply(200, { ok: true });
    } catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : "client_action_failed";
      reply(400, { error: code });
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await writePrivateJson(descriptor, { version: 1, origin, token });
  } catch (error) {
    await close();
    throw error;
  }
  return { origin, token, close };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_request");
  return body;
}
