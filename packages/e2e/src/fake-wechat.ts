import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A text the host asked WeChat to send. */
export interface WechatSend {
  readonly threadId: string;
  readonly text: string;
  readonly serverId: string;
  readonly idempotencyKey: string;
}

interface StoredMessage {
  readonly id: string;
  readonly threadId: string;
  readonly serverId: string;
  readonly senderId: string;
  readonly type: number;
  readonly direction: "incoming" | "outgoing";
  readonly body: string;
  readonly createdAt: string;
  readonly mentions?: { state: "known"; userIds: string[]; self: boolean; all: boolean };
}

/**
 * Stands in for the agent-wechat daemon (`wx serve`, `/v1` API, pinned v3.0.0-beta.3): one logged-in account, an
 * event log streamed as SSE, message lookups and text sends that WeChat accepts at once.
 */
export class FakeWechat {
  readonly token = randomBytes(32).toString("hex");
  readonly accountId = "acct_e2e";
  readonly sends: WechatSend[] = [];
  /** Every request, as `METHOD path`, for failure messages. */
  readonly log: string[] = [];
  /** Requests refused for a wrong token. */
  unauthorized = 0;
  /** When set, sends end in this state instead of `accepted`. */
  failSends?: string;
  private readonly events: Array<{ cursor: string; kind: string; data: Record<string, unknown>; createdAt: string }> = [];
  private readonly messages = new Map<string, StoredMessage>();
  private readonly streams = new Set<{ response: ServerResponse; after: number }>();
  private readonly intents = new Map<string, Record<string, unknown>>();
  private readonly byKey = new Map<string, string>();
  private nextServerId = 7_000_000_000_000_000_000n;
  private keepAlive?: ReturnType<typeof setInterval>;
  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly alias: string,
    readonly selfId: string,
  ) {}

  static async start(options: { alias?: string; selfId?: string } = {}): Promise<FakeWechat> {
    let daemon!: FakeWechat;
    const server = createServer(
      (request, response) =>
        void daemon.handle(request, response).catch((error) => respond(response, 500, { error: { code: "internal", message: String(error) } })),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    daemon = new FakeWechat(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, options.alias ?? "bot", options.selfId ?? "wxid_bot");
    daemon.keepAlive = setInterval(() => {
      for (const stream of daemon.streams) stream.response.write(": keep-alive\n\n");
    }, 5000);
    return daemon;
  }

  /** Whether the host is following the event stream. */
  get following(): boolean {
    return this.streams.size > 0;
  }

  /** A text from `peer` in their direct chat. */
  directMessage(peer: string, text: string): string {
    return this.incoming({ threadId: peer, senderId: peer, text });
  }

  /** A text from `sender` in group `room`; `atSelf` marks the bot as mentioned. */
  groupMessage(room: string, sender: string, text: string, options: { atSelf?: boolean } = {}): string {
    return this.incoming({
      threadId: room,
      senderId: sender,
      text,
      ...(options.atSelf ? { mentions: { state: "known", userIds: [this.selfId], self: true, all: false } } : {}),
    });
  }

  async close(): Promise<void> {
    clearInterval(this.keepAlive);
    for (const stream of this.streams) stream.response.end();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private incoming(input: { threadId: string; senderId: string; text: string; mentions?: StoredMessage["mentions"] }): string {
    const message: StoredMessage = {
      id: `msg_${randomBytes(6).toString("hex")}`,
      threadId: input.threadId,
      serverId: String(this.nextServerId++),
      senderId: input.senderId,
      type: 1,
      direction: "incoming",
      body: input.text,
      createdAt: new Date().toISOString(),
      ...(input.mentions ? { mentions: input.mentions } : {}),
    };
    this.messages.set(message.id, message);
    this.emit("message.committed", { messageId: message.id, threadId: message.threadId, origin: "live", direction: "incoming" });
    return message.id;
  }

  private emit(kind: string, data: Record<string, unknown>): void {
    const event = { cursor: String(this.events.length + 1), kind, data, createdAt: new Date().toISOString() };
    this.events.push(event);
    for (const stream of this.streams) if (Number(event.cursor) > stream.after) write(stream.response, event);
  }

  private account() {
    return { id: this.accountId, alias: this.alias, ownUsername: this.selfId, authenticated: true, connection: "online" };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.log.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      this.unauthorized++;
      return respond(response, 401, { error: { code: "unauthorized" } });
    }
    const url = new URL(request.url!, this.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    let body: unknown;
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += String(chunk);
      body = text ? JSON.parse(text) : undefined;
    }
    if (parts[0] !== "v1") return respond(response, 404, { error: { code: "not_found" } });
    if (parts[1] === "status") return respond(response, 200, { serverId: "fake-wechat-server", version: "3.0.0-beta.3" });
    if (parts[1] === "accounts" && parts.length === 2) return respond(response, 200, { items: [this.account()] });
    if (parts[1] !== "accounts" || parts[2] !== this.accountId) return respond(response, 404, { error: { code: "account_not_found" } });
    const [resource, id, sub, subId] = parts.slice(3);
    switch (`${request.method} ${resource}${id === undefined ? "" : "/:id"}${sub === undefined ? "" : `/${sub}`}${subId === undefined ? "" : "/:id"}`) {
      case "GET events":
        return respond(response, 200, { items: this.events.slice(-1), nextCursor: String(this.events.length) });
      case "GET events/:id":
        if (id !== "stream") break;
        return this.stream(response, Number(url.searchParams.get("after") ?? this.events.length));
      case "POST consumers/:id/ack":
        return respond(response, 200, { ok: true });
      case "GET messages/:id": {
        const message = this.messages.get(id!);
        return message ? respond(response, 200, message) : respond(response, 404, { error: { code: "message_not_found" } });
      }
      case "GET contacts/:id":
        return respond(response, 200, { username: id, displayName: `联系人${id}` });
      case "GET threads/:id":
        return respond(response, 200, {
          id,
          kind: id!.endsWith("@chatroom") ? "group" : "direct",
          displayName: id!.endsWith("@chatroom") ? `群${id}` : `联系人${id}`,
        });
      case "GET groups/:id/members/:id":
        return respond(response, 200, { member: { username: subId, displayName: `成员${subId}` } });
      case "POST sends":
        return this.send(request, response, body as { kind: string; threadId: string; text: string });
      case "GET sends/:id": {
        if (id === "by-idempotency-key") {
          const intent = this.intents.get(this.byKey.get(url.searchParams.get("key") ?? "") ?? "");
          return intent ? respond(response, 200, intent) : respond(response, 404, { error: { code: "send_not_found" } });
        }
        const intent = this.intents.get(id!);
        return intent ? respond(response, 200, intent) : respond(response, 404, { error: { code: "send_not_found" } });
      }
    }
    return respond(response, 404, { error: { code: "not_found" } });
  }

  private stream(response: ServerResponse, after: number): void {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const stream = { response, after };
    this.streams.add(stream);
    response.on("close", () => this.streams.delete(stream));
    for (const event of this.events) if (Number(event.cursor) > after) write(response, event);
  }

  private send(request: IncomingMessage, response: ServerResponse, body: { kind: string; threadId: string; text: string }): void {
    const key = String(request.headers["idempotency-key"] ?? "");
    const existing = this.intents.get(this.byKey.get(key) ?? "");
    if (existing) return respond(response, 200, existing);
    if (body?.kind !== "text") return respond(response, 422, { error: { code: "unsupported_send" } });
    const id = `send_${randomBytes(6).toString("hex")}`;
    const failed = this.failSends;
    const serverId = String(this.nextServerId++);
    const intent = failed
      ? { id, state: failed, serverId: null, errorCode: "risk_control" }
      : { id, state: "accepted", serverId, errorCode: null, localMessageId: `msg_${randomBytes(6).toString("hex")}` };
    this.intents.set(id, intent);
    this.byKey.set(key, id);
    if (!failed) this.sends.push({ threadId: body.threadId, text: body.text, serverId, idempotencyKey: key });
    respond(response, 200, intent);
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function write(response: ServerResponse, event: { cursor: string }): void {
  response.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
}
