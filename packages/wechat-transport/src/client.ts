import { readFile } from "node:fs/promises";

import { AppError, httpFetch, type BoundedResponse, isRecord } from "@yesimbot/foundation";

import { AGENT_WECHAT_ERRORS } from "./errors.js";
import type {
  AgentWechatAccount,
  AgentWechatContact,
  AgentWechatEvent,
  AgentWechatGroup,
  AgentWechatGroupMember,
  AgentWechatMediaAsset,
  AgentWechatMediaJob,
  AgentWechatMessage,
  AgentWechatOperation,
  AgentWechatSendIntent,
  AgentWechatThread,
  AgentWechatUpload,
  MediaSendRequest,
  TextSendRequest,
} from "./types.js";

/** Images are capped by WeChat itself at 26,214,383 bytes. */
export const MAX_IMAGE_BYTES = 26_214_383;

/** The daemon only listens on loopback; plain HTTP to anything else would send the owner token in the clear. */
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

const MAX_JSON_BYTES = 16 * 1024 * 1024;

const MAX_SSE_BYTES = 1024 * 1024;

/** A stream past this many bytes ends; the consumer reconnects from its cursor. */
const MAX_STREAM_BYTES = 1024 * 1024 * 1024;

const MAX_ERROR_BYTES = 64 * 1024;

/** A WeChat group holds at most 500 members; ten pages of 200 is a bound, not an expected size. */
const MAX_MEMBER_PAGES = 10;

const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;

const ERROR_CODE = /^[a-z0-9_]{1,80}$/;

export interface AgentWechatClientOptions {
  /** `http://127.0.0.1:6174` inside the runtime container. */
  readonly endpoint: string;
  /** The owner token, or where to read it. Read lazily and again after a 401, so the daemon may rotate it. */
  readonly token: string | (() => Promise<string>);
  /** The foundation's `httpFetch` (`purpose: "internal"`); tests pass a fake. */
  readonly fetch?: typeof httpFetch;
  /** Bounds a request, or for the event stream the wait for its headers. */
  readonly timeoutMs?: number;
  /** Server keepalive comments arrive every 15 s; a stream silent for this long is reconnected. */
  readonly streamIdleTimeoutMs?: number;
}

export interface EventQuery {
  /** Resume after this cursor. */
  readonly after?: string;
  /** Start at the end of the log (a consumer that has no cursor yet). */
  readonly newest?: boolean;
}

interface RequestInit_ {
  readonly body?: unknown;
  readonly form?: FormData;
  readonly key?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  /** The response body limit; JSON responses by default. */
  readonly maxBytes?: number;
  /** Long-lived: the timeout covers only the wait for the headers (the caller bounds idle time). */
  readonly stream?: boolean;
}

/** A daemon refusal, by its fixed snake_case code. The daemon never returns message text. */
export class AgentWechatError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`agent_wechat_${code}`);
    this.name = "AgentWechatError";
  }
}

/** Minimal client for the agent-wechat daemon's `/v1` API, shared by the WeChat adapter and the console. */
export class AgentWechatClient {
  public readonly endpoint: URL;
  private readonly fetcher: typeof httpFetch;
  private readonly timeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private cachedToken?: string;
  public constructor(private readonly options: AgentWechatClientOptions) {
    const url = new URL(options.endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError(AGENT_WECHAT_ERRORS.agent_wechat_endpoint_invalid, { effect: "none" });
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) throw new AppError(AGENT_WECHAT_ERRORS.agent_wechat_endpoint_not_loopback, { effect: "none" });
    if (url.username || url.password || url.search || url.hash) throw new AppError(AGENT_WECHAT_ERRORS.agent_wechat_endpoint_invalid, { effect: "none" });
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    this.endpoint = url;
    this.fetcher = options.fetch ?? httpFetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 45_000;
  }

  public async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.fetcher(new URL("health", this.endpoint), {
        purpose: "internal",
        timeoutMs: this.timeoutMs,
        maxBytes: MAX_ERROR_BYTES,
        signal,
      });
      await response.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  public status(): Promise<{ serverId: string }> {
    return this.json("GET", "v1/status");
  }

  public async accounts(): Promise<AgentWechatAccount[]> {
    return (await this.json<{ items: AgentWechatAccount[] }>("GET", "v1/accounts")).items;
  }

  /** The account with this ID or alias, if the daemon has it. */
  public async findAccount(account: string): Promise<AgentWechatAccount | undefined> {
    return (await this.accounts()).find((item) => item.id === account || item.alias === account);
  }

  public createAccount(alias: string): Promise<{ id: string }> {
    return this.json("POST", "v1/accounts", { body: { alias } });
  }

  /** Starts a login. With saved trust it succeeds without a QR code; otherwise it waits for a scan. */
  public login(account: string, key?: string): Promise<AgentWechatOperation> {
    return this.json("POST", `v1/accounts/${seg(account)}/auth/login`, { body: { qrRefresh: { mode: "auto", maxRefreshes: 3 } }, key });
  }

  public operation(account: string, id: string, signal?: AbortSignal): Promise<AgentWechatOperation> {
    return this.json("GET", `v1/accounts/${seg(account)}/operations/${seg(id)}`, { signal });
  }

  public cancelOperation(account: string, id: string): Promise<AgentWechatOperation> {
    return this.json("DELETE", `v1/accounts/${seg(account)}/operations/${seg(id)}`);
  }

  /** The login QR code as PNG. A newer code makes an older generation fail with `login_challenge_superseded`. */
  public async qr(account: string, operation: string, generation?: number): Promise<Uint8Array> {
    const query = generation === undefined ? "" : `?generation=${generation}`;
    const response = await this.send("GET", `v1/accounts/${seg(account)}/operations/${seg(operation)}/qr${query}`);
    if (!response.headers.get("content-type")?.startsWith("image/png")) {
      await response.body?.cancel();
      throw new AgentWechatError(502, "invalid_qr_response");
    }
    return readBounded(response, 1024 * 1024);
  }

  public logout(account: string, key: string): Promise<AgentWechatOperation> {
    return this.json("POST", `v1/accounts/${seg(account)}/logout`, { body: {}, key });
  }

  public message(account: string, id: string, signal?: AbortSignal): Promise<AgentWechatMessage> {
    return this.json("GET", `v1/accounts/${seg(account)}/messages/${seg(id)}`, { signal });
  }

  /** Newest first. */
  public async threadMessages(account: string, thread: string, limit: number, signal?: AbortSignal): Promise<AgentWechatMessage[]> {
    return (await this.json<{ items: AgentWechatMessage[] }>("GET", `v1/accounts/${seg(account)}/threads/${seg(thread)}/messages?limit=${limit}`, { signal }))
      .items;
  }

  public thread(account: string, id: string, signal?: AbortSignal): Promise<AgentWechatThread> {
    return this.json("GET", `v1/accounts/${seg(account)}/threads/${seg(id)}`, { signal });
  }

  public async groupMember(account: string, room: string, username: string, signal?: AbortSignal): Promise<AgentWechatGroupMember | undefined> {
    const lookup = await this.json<{ member: AgentWechatGroupMember | null }>(
      "GET",
      `v1/accounts/${seg(account)}/groups/${seg(room)}/members/${seg(username)}`,
      {
        signal,
      },
    );
    return lookup.member ?? undefined;
  }

  public group(account: string, room: string, signal?: AbortSignal): Promise<AgentWechatGroup> {
    return this.json("GET", `v1/accounts/${seg(account)}/groups/${seg(room)}`, { signal });
  }

  /** The group's saved member list, every page. It holds only members WeChat has sent; `refreshGroupMembers` asks for all. */
  public async groupMembers(account: string, room: string, signal?: AbortSignal): Promise<AgentWechatGroupMember[]> {
    const members: AgentWechatGroupMember[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const query = cursor ? `limit=200&cursor=${encodeURIComponent(cursor)}` : "limit=200";
      const result = await this.json<{ items: AgentWechatGroupMember[]; nextCursor?: string | null }>(
        "GET",
        `v1/accounts/${seg(account)}/groups/${seg(room)}/members?${query}`,
        { signal },
      );
      members.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return members;
  }

  /** Asks WeChat for the group's whole member list; the operation's result says `completeRoster`. */
  public refreshGroupMembers(account: string, room: string, signal?: AbortSignal): Promise<AgentWechatOperation> {
    return this.json("POST", `v1/accounts/${seg(account)}/groups/${seg(room)}/members/refresh`, { signal });
  }

  public contact(account: string, username: string, signal?: AbortSignal): Promise<AgentWechatContact> {
    return this.json("GET", `v1/accounts/${seg(account)}/contacts/${seg(username)}`, { signal });
  }

  /** Never downloads; lists the variants WeChat offers and whether each is cached. */
  public async mediaAssets(account: string, messageId: string, signal?: AbortSignal): Promise<AgentWechatMediaAsset[]> {
    return (await this.json<{ items: AgentWechatMediaAsset[] }>("GET", `v1/accounts/${seg(account)}/messages/${seg(messageId)}/media`, { signal })).items;
  }

  public transferMedia(
    account: string,
    messageId: string,
    quality: "best" | "original" | "standard" | "thumbnail",
    signal?: AbortSignal,
  ): Promise<AgentWechatMediaJob> {
    return this.json("POST", `v1/accounts/${seg(account)}/messages/${seg(messageId)}/media-transfers`, {
      body: { messageId, assetId: null, quality },
      signal,
    });
  }

  public job(account: string, id: string, signal?: AbortSignal): Promise<AgentWechatMediaJob> {
    return this.json("GET", `v1/accounts/${seg(account)}/jobs/${seg(id)}`, { signal });
  }

  /** Cached bytes only (404 `media_not_cached` otherwise). `preview` is a browser-readable copy of formats such as WXGF. */
  public async mediaContent(
    account: string,
    assetId: string,
    options: { readonly representation?: "original" | "preview"; readonly maxBytes?: number; readonly signal?: AbortSignal } = {},
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const query = options.representation === "preview" ? "?representation=preview" : "";
    const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
    const response = await this.send("GET", `v1/accounts/${seg(account)}/media/${seg(assetId)}/content${query}`, { signal: options.signal, maxBytes });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    return { bytes: await readBounded(response, maxBytes), contentType };
  }

  public async upload(account: string, bytes: Uint8Array, name: string, mediaType: string, signal?: AbortSignal): Promise<AgentWechatUpload> {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
    return this.json("POST", `v1/accounts/${seg(account)}/uploads`, { form, signal });
  }

  public sendText(account: string, request: TextSendRequest, key: string, signal?: AbortSignal): Promise<AgentWechatSendIntent> {
    return this.json("POST", `v1/accounts/${seg(account)}/sends`, { body: request, key, signal });
  }

  public sendMedia(account: string, request: MediaSendRequest, key: string, signal?: AbortSignal): Promise<AgentWechatMediaJob> {
    return this.json("POST", `v1/accounts/${seg(account)}/sends`, {
      body: { ...request, standardSourceId: null, thumbnailSourceId: null, playSeconds: null, durationMs: null, ...mediaQuality(request.kind) },
      key,
      signal,
    });
  }

  public sendIntent(account: string, id: string, signal?: AbortSignal): Promise<AgentWechatSendIntent> {
    return this.json("GET", `v1/accounts/${seg(account)}/sends/${seg(id)}`, { signal });
  }

  /** The send recorded under this idempotency key (a text intent or a media job). */
  public sendByKey(account: string, key: string, signal?: AbortSignal): Promise<AgentWechatSendIntent | AgentWechatMediaJob> {
    return this.json("GET", `v1/accounts/${seg(account)}/sends/by-idempotency-key?key=${encodeURIComponent(key)}`, { signal });
  }

  /** The newest event's cursor, where a consumer without a saved position starts. */
  public async newestCursor(account: string): Promise<string> {
    const page = await this.json<{ nextCursor: string }>("GET", `v1/accounts/${seg(account)}/events?newest=true&limit=1`);
    return decimal(page.nextCursor);
  }

  public ack(account: string, consumer: string, cursor: string): Promise<unknown> {
    return this.json("POST", `v1/accounts/${seg(account)}/consumers/${seg(consumer)}/ack`, { body: { cursor: decimal(cursor) } });
  }

  /**
   * The account's event stream. Yields until the server closes it or `signal` aborts. A cursor the log no longer
   * holds fails with `event_cursor_expired` (410), before or during the stream.
   */
  public async *events(account: string, query: EventQuery, signal?: AbortSignal): AsyncGenerator<AgentWechatEvent> {
    const search = query.after !== undefined ? `?after=${decimal(query.after)}` : query.newest ? "?newest=true" : "";
    const connection = new AbortController();
    const streamSignal = signal ? AbortSignal.any([signal, connection.signal]) : connection.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.send("GET", `v1/accounts/${seg(account)}/events/stream${search}`, {
        signal: streamSignal,
        headers: { Accept: "text/event-stream" },
        stream: true,
        maxBytes: MAX_STREAM_BYTES,
      });
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
        await response.cancel();
        throw new AgentWechatError(502, "invalid_event_stream");
      }
      reader = response.body?.getReader();
      if (!reader) throw new AgentWechatError(502, "invalid_event_stream");
      const decoder = new TextDecoder();
      let buffer = "",
        data: string[] = [],
        id = "",
        type = "";
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await idle(reader.read(), this.streamIdleTimeoutMs, () => connection.abort());
        } catch (error) {
          // The stream reached its byte bound: end it like a server close, and the consumer reconnects.
          if (error instanceof AppError && error.code === "network_response_too_large") return;
          throw error;
        }
        const { value, done } = chunk;
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BYTES) throw new AgentWechatError(502, "event_frame_too_large");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line) {
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("id:")) id = line.slice(3).trim();
            continue;
          }
          if (data.length) {
            const payload: unknown = JSON.parse(data.join("\n"));
            if (type === "error") {
              const code = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string" ? payload.error.code : "stream_failed";
              throw new AgentWechatError(code === "event_cursor_expired" ? 410 : 502, ERROR_CODE.test(code) ? code : "stream_failed");
            }
            if (!isRecord(payload) || typeof payload.kind !== "string" || !isRecord(payload.data)) throw new AgentWechatError(502, "invalid_event");
            yield {
              cursor: decimal(typeof payload.cursor === "string" ? payload.cursor : id),
              kind: payload.kind,
              data: payload.data,
              createdAt: typeof payload.createdAt === "string" ? payload.createdAt : "",
            };
          }
          data = [];
          id = "";
          type = "";
        }
      }
    } finally {
      connection.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  private async json<T>(method: string, path: string, init: RequestInit_ = {}): Promise<T> {
    const response = await this.send(method, path, init);
    if (response.status === 204) {
      await response.cancel();
      return undefined as T;
    }
    return JSON.parse(new TextDecoder().decode(await readBounded(response, MAX_JSON_BYTES))) as T;
  }

  private async send(method: string, path: string, init: RequestInit_ = {}): Promise<BoundedResponse> {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await this.token()}`);
      if (init.key !== undefined) headers.set("Idempotency-Key", idempotencyKey(init.key));
      let body: BodyInit | undefined;
      if (init.form) body = init.form;
      else if (init.body !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(init.body);
      }
      let response: BoundedResponse;
      try {
        response = await this.fetcher(new URL(path, this.endpoint), {
          purpose: "internal",
          method,
          headers,
          body,
          timeoutMs: this.timeoutMs,
          maxBytes: init.maxBytes ?? MAX_JSON_BYTES,
          ...(init.stream ? { deadline: "headers" as const } : {}),
          signal: init.signal,
        });
      } catch (error) {
        throw tooLarge(error);
      }
      if (response.ok) return response;
      const code = await errorCode(response);
      // A rotated token: read the file once more, then give up.
      if (response.status === 401 && attempt === 0 && typeof this.options.token === "function") {
        this.cachedToken = undefined;
        continue;
      }
      throw new AgentWechatError(response.status, code);
    }
  }

  private async token(): Promise<string> {
    if (typeof this.options.token === "string") return this.options.token;
    this.cachedToken ??= await this.options.token();
    return this.cachedToken;
  }
}

/** Read an owner token file the daemon accepts: 32–1024 printable ASCII characters. */
export async function readTokenFile(file: string): Promise<string> {
  const token = (await readFile(file, "utf8")).trim();
  if (token.length < 32 || token.length > 1024 || !/^[\x21-\x7e]+$/.test(token))
    throw new AppError(AGENT_WECHAT_ERRORS.agent_wechat_token_file_invalid, { effect: "none" });
  return token;
}

function mediaQuality(kind: MediaSendRequest["kind"]): Record<string, string> {
  return kind === "image" ? { imageQuality: "original" } : kind === "video" ? { videoQuality: "normal" } : {};
}

function seg(value: string): string {
  if (!value || value.length > 8192 || /[\0\r\n]/.test(value)) throw new AppError(AGENT_WECHAT_ERRORS.agent_wechat_path_segment_invalid, { effect: "none" });
  return encodeURIComponent(value);
}

function decimal(value: string): string {
  if (!DECIMAL.test(value)) throw new AppError(AGENT_WECHAT_ERRORS.agent_wechat_cursor_invalid, { effect: "none" });
  return value;
}

/** 1–200 printable ASCII characters (space allowed), as the daemon requires. */
function idempotencyKey(value: string): string {
  if (!value || value.length > 200 || !/^[\x20-\x7e]+$/.test(value))
    throw new AppError(AGENT_WECHAT_ERRORS.agent_wechat_idempotency_key_invalid, { effect: "none" });
  return value;
}

async function errorCode(response: BoundedResponse): Promise<string> {
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(await readBounded(response, MAX_ERROR_BYTES)));
    if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" && ERROR_CODE.test(body.error.code)) return body.error.code;
  } catch {
    // Never surface response text or token-bearing details.
  }
  return "request_failed";
}

async function readBounded(response: BoundedResponse, max: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > max) {
    await response.cancel();
    throw new AgentWechatError(413, "response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new AgentWechatError(413, "response_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw tooLarge(error);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function idle<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new AgentWechatError(504, "event_stream_idle"));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The foundation's size refusal, as the daemon client has always reported it. */
function tooLarge(error: unknown): unknown {
  return error instanceof AppError && error.code === "network_response_too_large" ? new AgentWechatError(413, "response_too_large") : error;
}
