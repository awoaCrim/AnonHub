import { AppError, errorFields, type Clock } from "@yesimbot/foundation";
import { AgentWechatError, type AgentWechatAccount, type AgentWechatClient, type AgentWechatEvent, type AgentWechatMessage } from "@yesimbot/wechat-transport";
import type { Part } from "koishi-plugin-yesimbot/kernel";

import { isGroupThread, type Config } from "./config.js";
import { WECHAT_ERRORS } from "./errors.js";
import { messageParts, messageQuote, readMessageFile, readMessageImage, type InboundQuote } from "./inbound.js";
import { log } from "./log.js";
import { remoteMediaFetcher, type RemoteMediaFetcher } from "./media.js";
import { GroupRosters, type GroupRoster } from "./members.js";
import { remember, sendParts } from "./outbound.js";
import { sleep } from "./sleep.js";
import { ConsumerStateFile } from "./state.js";

/** A message that waited longer than this (the adapter was down) is not answered hours late. */
const FRESH_MS = 10 * 60_000;

const PRESENCE_MS = 30_000;

const NAME_TTL_MS = 5 * 60_000;

const MISS_TTL_MS = 30_000;

const EVENT_ATTEMPTS = 3;

/** One admitted incoming message, ready for Core: no Koishi, no Satori. */
export interface InboundMessage {
  /** WeChat's server ID (decimal), else the daemon's own message ID. */
  readonly id: string;
  readonly timestamp: number;
  readonly user: { readonly id: string; readonly name?: string };
  /** The group, for a group message. */
  readonly group?: { readonly id: string; readonly name?: string };
  readonly channel: { readonly id: string; readonly direct: boolean; readonly name?: string };
  readonly parts: Part[];
  readonly quote?: InboundQuote;
}

/** Whether the bot is usable, and the account it speaks for; `error` is set when the daemon is unreachable or refuses us. */
export interface Presence {
  readonly selfId?: string;
  readonly online: boolean;
  readonly error?: string;
}

/** What the connection needs from the platform shell (the connector). */
export interface BridgeHost {
  /** The logged-in wxid, once the daemon has reported it. */
  selfId(): string | undefined;
  /** True while the bot is online. */
  online(): boolean;
  presence(next: Presence): void;
  /** Resolves after Core has kept the message in its durable history; throws when it could not. */
  receive(message: InboundMessage): Promise<void>;
}

export interface ConnectionOptions {
  readonly api: AgentWechatClient;
  readonly config: Pick<Config, "allowedRooms" | "allowedPeers" | "account">;
  readonly host: BridgeHost;
  readonly clock: Clock;
  /** Where the event position is saved. */
  readonly stateDirectory: string;
  readonly fetchMedia?: RemoteMediaFetcher;
}

/**
 * Follows the daemon account's event log and turns new incoming messages from the allowed chats into `InboundMessage`s.
 * Progress is saved after Core has taken each message, so a restart resumes where it stopped; a message is never
 * skipped silently, and one that keeps failing is logged and passed over so it cannot block the chat.
 */
export class WechatConnection {
  readonly api: AgentWechatClient;
  /** NativeMessage IDs by WeChat server ID, for quote replies. */
  readonly quotes = new Map<string, string>();
  private readonly rosters: GroupRosters;
  private readonly names = new Map<string, { value?: string; expires: number }>();
  private readonly config: ConnectionOptions["config"];
  private readonly host: BridgeHost;
  private readonly clock: Clock;
  private readonly stateDirectory: string;
  private readonly fetchMedia: RemoteMediaFetcher;
  private controller?: AbortController;
  private running?: Promise<void>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private accountId?: string;
  constructor(options: ConnectionOptions) {
    this.api = options.api;
    this.config = options.config;
    this.host = options.host;
    this.clock = options.clock;
    this.stateDirectory = options.stateDirectory;
    this.fetchMedia = options.fetchMedia ?? remoteMediaFetcher();
    this.rosters = new GroupRosters(options.clock);
  }

  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.presenceTimer = setInterval(() => void this.refreshPresence(), PRESENCE_MS);
    this.running = this.run(controller.signal);
  }

  async stop(): Promise<void> {
    clearInterval(this.presenceTimer);
    this.controller?.abort();
    this.controller = undefined;
    await this.running?.catch((error: unknown) => log.debug("connection.stop_failed", { ...errorFields(error) }));
    this.running = undefined;
  }

  assertTarget(channelId: string): void {
    const allowed = isGroupThread(channelId) ? this.config.allowedRooms : this.config.allowedPeers;
    if (!allowed.includes(channelId)) throw new AppError(WECHAT_ERRORS.wechat_target_not_allowed, { effect: "none" });
  }

  async send(channelId: string, content: readonly Part[]): Promise<string[]> {
    this.assertTarget(channelId);
    if (!this.accountId || !this.host.online()) throw new AppError(WECHAT_ERRORS.wechat_not_logged_in, { effect: "none" });
    return sendParts(
      { api: this.api, account: this.accountId, threadId: channelId, quotes: this.quotes, clock: this.clock, fetchMedia: this.fetchMedia },
      content,
    );
  }

  /** The members of an allowed group (`wechat_group_members`). */
  async groupMembers(room: string, signal?: AbortSignal): Promise<GroupRoster> {
    this.assertTarget(room);
    if (!isGroupThread(room)) throw new AppError(WECHAT_ERRORS.wechat_target_not_allowed, { effect: "none" });
    if (!this.accountId || !this.host.online()) throw new AppError(WECHAT_ERRORS.wechat_not_logged_in, { effect: "none" });
    return this.rosters.read(this.api, this.accountId, room, this.host.selfId() || undefined, signal);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        const account = await this.api.findAccount(this.config.account);
        this.presence(account);
        if (!account) {
          // The console creates the account and logs it in; wait for it.
          await sleep(5000, signal);
          continue;
        }
        this.accountId = account.id;
        const { serverId } = await this.api.status();
        const state = new ConsumerStateFile(this.stateDirectory, serverId, account.id);
        let cursor = await state.load();
        if (cursor === undefined) {
          // First start: messages from now on, not the daemon's whole log. Saved at once so a restart misses nothing.
          cursor = await this.api.newestCursor(account.id);
          await state.save(cursor);
        }
        try {
          for await (const event of this.api.events(account.id, { after: cursor }, signal)) {
            delay = 1000;
            await this.handleWithRetry(account.id, event, signal);
            cursor = event.cursor;
            await state.save(cursor);
          }
        } catch (error) {
          if (!(error instanceof AgentWechatError && error.code === "event_cursor_expired")) throw error;
          // The daemon dropped events this adapter had not read (it keeps the newest 10,000). Continue from now.
          log.warn("events.cursor_expired", { cursor });
          await state.save(await this.api.newestCursor(account.id));
        }
      } catch (error) {
        if (signal.aborted) return;
        // The daemon is down or refuses this token. Other refusals (a dropped stream) reconnect quietly.
        if (!(error instanceof AgentWechatError) || error.status === 401 || error.status === 403)
          this.host.presence({ online: false, error: error instanceof AgentWechatError ? "微信服务拒绝访问" : "微信服务暂不可用" });
        log.debug("events.stream_ended", { ...errorFields(error) });
        await sleep(delay, signal).catch((aborted: unknown) => log.debug("events.backoff_aborted", { ...errorFields(aborted) }));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private async handleWithRetry(account: string, event: AgentWechatEvent, signal: AbortSignal): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.handle(account, event, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (attempt >= EVENT_ATTEMPTS) {
          log.warn("events.skipped", { cursor: event.cursor, kind: event.kind, attempts: attempt, ...errorFields(error) });
          return;
        }
        await sleep(1000 * attempt, signal);
      }
    }
  }

  private async handle(account: string, event: AgentWechatEvent, signal: AbortSignal): Promise<void> {
    if (event.kind === "account.updated") return this.refreshPresence();
    if (event.kind !== "message.committed") return;
    const { messageId, origin, direction } = event.data;
    // Catch-up batches are old history, and outgoing messages are the account's own (this bot or the phone).
    if (origin !== "live" || direction !== "incoming" || typeof messageId !== "string") return;
    await this.receive(account, await this.api.message(account, messageId, signal), signal);
  }

  private async receive(account: string, message: AgentWechatMessage, signal: AbortSignal): Promise<void> {
    const selfId = this.host.selfId();
    if (!selfId || message.direction !== "incoming" || !message.senderId || message.senderId === selfId) return;
    const group = isGroupThread(message.threadId);
    // A direct chat is the peer's own thread; an allowed group admits its members.
    if (group ? !this.config.allowedRooms.includes(message.threadId) : !this.config.allowedPeers.includes(message.threadId)) return;
    if (!group && message.senderId !== message.threadId) return;
    const now = this.clock.now();
    const sent = message.createdAt ? Date.parse(message.createdAt) : now;
    if (Number.isFinite(sent) && now - sent > FRESH_MS) return;
    if (message.serverId) remember(this.quotes, message.serverId, message.id);
    const media = { clock: this.clock, signal };
    const parts = await messageParts(message, selfId, {
      image: (item) =>
        readMessageImage(this.api, account, item, media).catch((error: unknown) => {
          log.debug("media.image_unreadable", { messageId: item.id, ...errorFields(error) });
          return undefined;
        }),
      file: (item) =>
        readMessageFile(this.api, account, item, media).catch((error: unknown) => {
          log.debug("media.file_unreadable", { messageId: item.id, ...errorFields(error) });
          return { failure: "download_failed" as const };
        }),
    });
    const quote = messageQuote(message);
    if (!parts?.length) return;
    const [userName, roomName] = await Promise.all([
      this.name(`member:${message.threadId}:${message.senderId}`, async () => {
        if (!group) return (await this.api.contact(account, message.senderId!, signal)).displayName;
        const member = await this.api.groupMember(account, message.threadId, message.senderId!, signal);
        return member?.roomDisplayName || member?.displayName;
      }),
      group ? this.name(`room:${message.threadId}`, async () => (await this.api.thread(account, message.threadId, signal)).displayName) : undefined,
    ]);
    // Core keeps the message in its durable history before progress is saved.
    await this.host.receive({
      id: message.serverId ?? message.id,
      timestamp: Number.isFinite(sent) ? sent : now,
      user: { id: message.senderId, ...(userName ? { name: userName } : {}) },
      ...(group ? { group: { id: message.threadId, ...(roomName ? { name: roomName } : {}) } } : {}),
      channel: { id: message.threadId, direct: !group, ...(roomName ? { name: roomName } : {}) },
      parts,
      ...(quote ? { quote } : {}),
    });
  }

  /** Display names are a convenience: a failed lookup falls back to the wxid and is retried a little later. */
  private async name(key: string, lookup: () => Promise<string | null | undefined>): Promise<string | undefined> {
    const cached = this.names.get(key);
    if (cached && cached.expires > this.clock.now()) return cached.value;
    let value: string | undefined;
    try {
      value = (await lookup())?.trim() || undefined;
    } catch (error) {
      log.debug("names.lookup_failed", { key, ...errorFields(error) });
      value = undefined;
    }
    this.names.delete(key);
    this.names.set(key, { value, expires: this.clock.now() + (value ? NAME_TTL_MS : MISS_TTL_MS) });
    if (this.names.size > 512) this.names.delete(this.names.keys().next().value!);
    return value;
  }

  private async refreshPresence(): Promise<void> {
    try {
      this.presence(await this.api.findAccount(this.config.account));
    } catch (error) {
      log.debug("presence.refresh_failed", { ...errorFields(error) });
      this.host.presence({ online: false, error: "微信服务暂不可用" });
    }
  }

  /** Online only while the account is logged in and connected to WeChat. Not logged in is not an error. */
  private presence(account: AgentWechatAccount | undefined): void {
    if (account) this.accountId = account.id;
    this.host.presence({
      ...(account?.ownUsername ? { selfId: account.ownUsername } : {}),
      online: !!account?.ownUsername && account.authenticated && account.connection === "online",
    });
  }
}
