import { chmod, lstat, rm } from "node:fs/promises";
import http from "node:http";
import { pathToFileURL } from "node:url";

import { LIMITS, RenderError, launchBrowser, renderHtml, validateInput } from "./renderer.mjs";

const MAX_REQUEST_BYTES = LIMITS.htmlBytes * 6 + 1024;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RenderError("invalid_content_type", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new RenderError("request_too_large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RenderError("invalid_json");
  }
}

export function createServer(browser, render = renderHtml) {
  let busy = false;
  let ready = true;
  browser.on("disconnected", () => {
    ready = false;
  });
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (request, response) => {
    if (request.url === "/health" && request.method === "GET")
      return json(response, ready ? 200 : 503, { ok: ready, service: "yesimbot-html-renderer", isolation: "static-no-script-no-network" });
    if (request.url !== "/render" || request.method !== "POST") return json(response, 404, { error: "not_found" });
    if (!ready) return json(response, 503, { error: "renderer_unavailable" });
    if (busy) return json(response, 503, { error: "renderer_busy" });
    busy = true;
    let timer;
    try {
      const input = await readJson(request);
      validateInput(input);
      const bytes = await Promise.race([
        render(browser, input),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new RenderError("renderer_timeout", 504)), LIMITS.timeoutMs);
        }),
      ]);
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": bytes.byteLength,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(bytes);
    } catch (error) {
      const known = error instanceof RenderError;
      json(response, known ? error.status : 500, { error: known ? error.message : "render_failed" });
      // A timed-out browser may still be working. Do not admit another request;
      // fail health and let the supervisor replace this process/container.
      if (error instanceof RenderError && error.message === "renderer_timeout") {
        ready = false;
        void browser.close().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      busy = !ready;
    }
  });
  return server;
}

export async function start(socketPath = process.env.RENDERER_SOCKET || "/run/renderer/http.sock") {
  const previous = await lstat(socketPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (previous && !previous.isSocket()) throw new Error("renderer_socket_path_is_not_socket");
  if (previous) await rm(socketPath);
  const browser = await launchBrowser();
  const server = createServer(browser);
  let stopping = false;
  // A browser failure must also restart the process under Docker/systemd.
  browser.on("disconnected", () => {
    if (stopping) return;
    server.close();
    server.closeAllConnections();
    process.exitCode = 1;
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    stopping = true;
    await browser.close();
    throw error;
  }
  await chmod(socketPath, 0o660);
  const shutdown = async () => {
    stopping = true;
    server.close();
    server.closeAllConnections();
    await browser.close();
    await rm(socketPath, { force: true });
  };
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  return { server, browser, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
