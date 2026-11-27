import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { EventBus } from "../src/events.js";
import { HttpServer } from "../src/http.js";

const servers: HttpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function listening(): Promise<{ server: HttpServer; base: string }> {
  const server = new HttpServer();
  servers.push(server);
  await server.listen("127.0.0.1", 0);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe("the host's HTTP server", () => {
  it("routes GET and POST, parses the body like Koishi did, and removes a route", async () => {
    const { server, base } = await listening();
    const removeGet = server.get("/hello/:name", (http) => {
      http.body = { hello: http.params.name, q: http.query.q };
    });
    server.post("/echo", (http) => {
      http.body = { got: (http.request as { body?: unknown }).body };
    });
    expect(await (await fetch(`${base}/hello/ann?q=1`)).json()).toEqual({ hello: "ann", q: "1" });
    const posted = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    expect(await posted.json()).toEqual({ got: { a: 1 } });
    removeGet();
    expect((await fetch(`${base}/hello/ann`)).status).toBe(404);
  });

  it("runs prepended middleware before every route, the latest first", async () => {
    const { server, base } = await listening();
    const order: string[] = [];
    server.get("/x", (http) => {
      order.push("route");
      http.body = "ok";
    });
    server.prepend(async (_http, next) => {
      order.push("first");
      await next();
    });
    const remove = server.prepend(async (http, next) => {
      order.push("second");
      if (http.path === "/blocked") {
        http.status = 403;
        return;
      }
      await next();
    });
    await fetch(`${base}/x`);
    expect(order).toEqual(["second", "first", "route"]);
    expect((await fetch(`${base}/blocked`)).status).toBe(403);
    remove();
    order.length = 0;
    await fetch(`${base}/x`);
    expect(order).toEqual(["first", "route"]);
  });

  it("accepts WebSockets on registered paths only and closes them on shutdown", async () => {
    const { server, base } = await listening();
    server.ws("/live", (socket) => socket.send("hi"));
    const socket = new WebSocket(`${base.replace("http", "ws")}/live`);
    const first = await new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
    expect(first).toBe("hi");
    const refused = new WebSocket(`${base.replace("http", "ws")}/other`);
    refused.on("error", () => {});
    const status = await new Promise<number | undefined>((resolve) =>
      refused.once("unexpected-response", (_request, response) => resolve(response.statusCode)),
    );
    expect(status).toBe(404);
    refused.terminate();
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    await server.close();
    expect(await closed).toBe(1001);
  });
});

describe("the host's event bus", () => {
  it("delivers to every listener even when one throws or rejects, and removes a listener", async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on("yesimbot/turn", () => {
      throw new Error("boom");
    });
    bus.on("yesimbot/turn", async () => Promise.reject(new Error("later")));
    const remove = bus.on("yesimbot/turn", (value: unknown) => seen.push(value));
    const warn = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    bus.emit("yesimbot/turn", 1);
    await Promise.resolve();
    remove();
    bus.emit("yesimbot/turn", 2);
    await new Promise((resolve) => setImmediate(resolve));
    const lines = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();
    expect(seen).toEqual([1]);
    expect(lines.filter((line) => line.includes("event.listener_failed"))).toHaveLength(4);
  });
});
