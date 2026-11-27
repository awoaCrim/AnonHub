import { createServer, type IncomingMessage, type Server as NodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import Router from "@koa/router";
import { errorFields, logger } from "@yesimbot/foundation";
import Koa from "koa";
import { koaBody } from "koa-body";
import { WebSocketServer, type WebSocket } from "ws";

const log = logger("host.http");

export type HttpContext = Router.RouterContext;

export type HttpHandler = (http: HttpContext) => unknown;

export type SocketHandler = (socket: WebSocket, request: IncomingMessage) => unknown;

export type Middleware = (http: Koa.Context, next: () => Promise<unknown>) => unknown;

/**
 * The host's HTTP server (Koa), shaped like the Koishi server the modules use today: routes parse their body as
 * Koishi's did (JSON, forms and multipart up to 10 MB, raw body kept), WebSockets are matched by exact path, and
 * middleware can run before every route. Each registration returns the function that removes it.
 */
export class HttpServer {
  public readonly http: NodeServer;

  private readonly koa = new Koa();
  private readonly router = new Router();
  private readonly body = koaBody({ multipart: true, jsonLimit: "10mb", formLimit: "10mb", textLimit: "10mb", includeUnparsed: true });
  private readonly before: Middleware[] = [];
  private readonly sockets = new Map<string, { readonly handler: SocketHandler; readonly accept?: (request: IncomingMessage) => boolean }>();
  private readonly socketServer = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  private bound: { readonly host: string; readonly port: number } | undefined;

  public constructor() {
    this.koa.on("error", (error: unknown) => log.warn("http.request_failed", { ...errorFields(error) }));
    this.koa.use((http, next) => this.runBefore(http, next, 0));
    this.koa.use(this.router.routes());
    this.koa.use(this.router.allowedMethods());
    this.http = createServer(this.koa.callback());
    this.http.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
  }

  public get port(): number | undefined {
    return this.bound?.port;
  }

  public get listenHost(): string | undefined {
    return this.bound?.host;
  }

  public get(path: string, handler: HttpHandler): () => void {
    return this.route("GET", path, handler);
  }

  public post(path: string, handler: HttpHandler): () => void {
    return this.route("POST", path, handler);
  }

  /** `accept` runs before the upgrade: false refuses it with 401 and the handler never sees the socket. */
  public ws(path: string, handler: SocketHandler, accept?: (request: IncomingMessage) => boolean): () => void {
    if (this.sockets.has(path)) throw new Error(`WebSocket path already registered: ${path}`);
    const entry = { handler, accept };
    this.sockets.set(path, entry);
    return () => {
      if (this.sockets.get(path) === entry) this.sockets.delete(path);
    };
  }

  /** Runs before the router's body parsing, in the reverse order of registration (the latest first). */
  public prepend(middleware: Middleware): () => void {
    this.before.unshift(middleware);
    return () => {
      const index = this.before.indexOf(middleware);
      if (index >= 0) this.before.splice(index, 1);
    };
  }

  /** Port 0 picks a free one; `port` then tells which. */
  public async listen(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.http.once("error", failed);
      this.http.listen(port, host, () => {
        this.http.off("error", failed);
        resolve();
      });
    });
    this.bound = { host, port: (this.http.address() as AddressInfo).port };
    log.info("http.listening", { host, port: this.bound.port });
  }

  public async close(): Promise<void> {
    for (const client of this.clients) client.close(1001);
    this.socketServer.close();
    if (!this.http.listening) return;
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeIdleConnections();
      // Requests still running after a grace period are cut off rather than holding shutdown.
      const timer = setTimeout(() => this.http.closeAllConnections(), 5000);
      timer.unref();
    });
    this.bound = undefined;
  }

  private route(method: "GET" | "POST", path: string, handler: HttpHandler): () => void {
    // The router's types come with @types/koa 3 while Koa and koa-body here are typed by @types/koa 2: one cast at the seam.
    const layer = this.router.register(path, [method], [this.body as unknown as Router.Middleware, handler as Router.Middleware]);
    return () => {
      const index = this.router.stack.indexOf(layer);
      if (index >= 0) this.router.stack.splice(index, 1);
    };
  }

  private async runBefore(http: Koa.Context, next: Koa.Next, index: number): Promise<unknown> {
    const middleware = this.before[index];
    if (!middleware) return next();
    return middleware(http, () => this.runBefore(http, next, index + 1));
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(request.url ?? "/", "http://host").pathname;
    const entry = this.sockets.get(path);
    if (!entry) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    let accepted = true;
    try {
      accepted = entry.accept?.(request) ?? true;
    } catch (error) {
      log.warn("http.socket_failed", { path, ...errorFields(error) });
      accepted = false;
    }
    if (!accepted) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // A guard ahead of this listener (the console's loopback check for NapCat) may already have closed it.
    if (socket.destroyed) return;
    const { handler } = entry;
    this.socketServer.handleUpgrade(request, socket, head, (client) => {
      this.clients.add(client);
      client.once("close", () => this.clients.delete(client));
      const failed = (error: unknown) => {
        log.warn("http.socket_failed", { path, ...errorFields(error) });
        client.close(1011);
      };
      try {
        const result = handler(client, request);
        if (result instanceof Promise) result.catch(failed);
      } catch (error) {
        failed(error);
      }
    });
  }
}
