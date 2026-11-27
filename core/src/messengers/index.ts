import { textPart } from "@yesimbot/contracts/parts";
import { WEB_CHAT, webChatConversation } from "@yesimbot/contracts/platforms";
import { AppError, logger, newId, systemClock, type Clock } from "@yesimbot/foundation";

import type { ChatAccount } from "../accounts.js";
import type { Channels } from "../channels/index.js";
import { type ChannelContext, contextFromRecord } from "../channels/index.js";
import type { ChannelAllowRule } from "../config.js";
import { CHANNEL_TYPE, type EventRecord, type MessageRecord } from "../messages/index.js";
import type { ChannelResources } from "../resources/index.js";
import type { PostOptions, Runtimes } from "../runtimes/index.js";
import type { TurnOutcome } from "../runtimes/types.js";
import { MESSENGER_ERRORS } from "./errors.js";

/** The private word's sender. It is not a chat member, so it never matches a tool rule's user. */
const OWNER_ID = "owner";

const log = logger("yesimbot.messenger");

/**
 * What became of a posted event: `closed` (the messenger was stopping, nothing ran), `wait` (stored
 * without a turn), `join` (added to the turn already running), or `run` with how that turn ended
 * (absent when the runtime does not report it).
 */
export type PostResult = { readonly kind: "closed" | "wait" | "join" } | { readonly kind: "run"; readonly outcome?: TurnOutcome };

/** What became of a private word: like {@link PostResult}, plus the stored message's ID. */
export type WhisperResult =
  | { readonly kind: "closed" }
  | { readonly kind: "wait" | "join"; readonly messageId: string }
  | { readonly kind: "run"; readonly messageId: string; readonly outcome?: TurnOutcome };

/** One input from a platform, before Core has admitted its conversation. */
export interface Inbound {
  /** The conversation it belongs to, as the platform side derived it. */
  readonly context: ChannelContext;
  /** The account that received it. */
  readonly selfId: string;
  /** For logs: the platform message or event ID. */
  readonly routeId: string;
  /** The record, made once the conversation is admitted; media are saved into `resources`. `null` drops the input. */
  translate(resources: ChannelResources): Promise<MessageRecord | EventRecord | null>;
}

export interface MessengerOptions {
  readonly allowedChannels: () => readonly ChannelAllowRule[] | undefined;
  readonly channels: Channels;
  readonly runtimes: Runtimes;
  /** The live account for a platform and account ID. */
  account(platform: string, selfId: string): ChatAccount | undefined;
  /** The account a shared conversation is assigned to; only that account takes its input. */
  assignee(context: ChannelContext): Promise<string | undefined>;
  readonly clock?: Clock;
}

/**
 * Admission and hand-off for every input and active post: reply scope, group assignment, the conversation's runtime.
 * It sees records only; the platform side (Koishi Sessions today, connectors later) makes them.
 */
export class Messenger {
  private readonly tasks = new Set<Promise<void>>();
  private readonly clock: Clock;
  private stopped = false;

  public constructor(private readonly options: MessengerOptions) {
    this.clock = options.clock ?? systemClock();
  }

  public get closed(): boolean {
    return this.stopped;
  }

  /** Admits one input and runs it. `strict` rethrows a failure, so a durable inbox keeps the input. */
  public async accept(inbound: Inbound, strict = false): Promise<void> {
    await this.track(this.route(inbound, strict));
  }

  /** Resolves when the started turn has finished (not merely been accepted). */
  public async post(event: EventRecord, options?: PostOptions): Promise<void> {
    await this.postAndReport(event, options);
  }

  /** `post`, resolving with what became of the event and, for a started turn, how it ended. */
  public async postAndReport(event: EventRecord, options?: PostOptions): Promise<PostResult> {
    if (this.stopped) return { kind: "closed" };
    const context = contextFromRecord(event);
    // Active posts bypass the reply scope, but never reach a web target that is not one of the
    // account holder's web conversations (group, notification channel or another sender).
    if (event.platform === WEB_CHAT.platform && (!context || !matchesAllowedChannel(context, undefined)))
      throw new AppError(MESSENGER_ERRORS.web_chat_target_denied, { effect: "none" });
    const bot = this.requireAccount(event.platform, event.selfId);
    const channel = await this.options.channels.resolve(context!);
    const runtime = await this.options.runtimes.get(channel, bot);
    const result = await runtime.post(event, options ?? { trigger: true, ifBusy: "defer" });
    log.debug("messenger.post", {
      eventType: event.eventType,
      platform: event.platform,
      channelId: event.channel.id,
      result: result.kind,
      eventId: result.eventId,
    });
    if (result.kind !== "run") return { kind: result.kind };
    await this.track(result.done);
    const outcome = await result.outcome?.catch(() => undefined);
    return outcome ? { kind: "run", outcome } : { kind: "run" };
  }

  /**
   * The account holder's private word to the bot in one conversation, from the WebUI. It is stored in that
   * conversation as a message marked `whisper` (nobody in the chat sees it, it stays in context) and always
   * starts a turn, after any running one. Resolves when that turn has ended.
   */
  public async whisper(context: ChannelContext, text: string, options: { readonly at?: number } = {}): Promise<WhisperResult> {
    if (this.stopped) return { kind: "closed" };
    if (context.platform === WEB_CHAT.platform) throw new AppError(MESSENGER_ERRORS.whisper_target_denied, { effect: "none" });
    const body = text.trim();
    if (!body) throw new AppError(MESSENGER_ERRORS.whisper_empty, { effect: "none" });
    const bot = this.requireAccount(context.platform, context.selfId!);
    const channel = await this.options.channels.resolve(context);
    const runtime = await this.options.runtimes.get(channel, bot);
    const messageId = `whisper-${newId()}`;
    const record: MessageRecord = {
      platform: context.platform,
      selfId: context.selfId!,
      channel: { id: context.channelId, type: context.type === "direct" ? CHANNEL_TYPE.direct : CHANNEL_TYPE.text },
      user: { id: OWNER_ID, name: "主人" },
      timestamp: options.at ?? this.clock.now(),
      messageId,
      parts: [textPart(body)],
      whisper: true,
    };
    const result = await runtime.post(record, { trigger: true, ifBusy: "defer", historyMode: "conversation" });
    log.debug("messenger.whisper", { platform: context.platform, channelId: context.channelId, result: result.kind });
    if (result.kind !== "run") return { kind: result.kind, messageId };
    await this.track(result.done);
    const outcome = await result.outcome?.catch(() => undefined);
    return outcome ? { kind: "run", messageId, outcome } : { kind: "run", messageId };
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.options.runtimes.stop();
    await Promise.allSettled([...this.tasks]);
  }

  private async route(inbound: Inbound, strict: boolean): Promise<void> {
    const { context, routeId } = inbound;
    if (!matchesAllowedChannel(context, this.options.allowedChannels())) return;
    try {
      await this.options.channels.start();
      if (context.type !== "direct") {
        const assignee = await this.options.assignee(context);
        if (!assignee || assignee !== inbound.selfId) throw new AppError(MESSENGER_ERRORS.messenger_assignee_denied, { effect: "none" });
      }
      const channel = await this.options.channels.resolve(context);
      const record = await inbound.translate(channel.resources);
      if (!record) return;
      log.debug("messenger.route.record", {
        routeId,
        recordType: "messageId" in record ? "message" : "event",
        platform: record.platform,
        selfId: record.selfId,
        channelId: record.channel.id,
      });
      const runtime = await this.options.runtimes.get(channel, this.requireAccount(record.platform, record.selfId));
      const result = await runtime.handle(record);
      log.debug("messenger.route.result", { routeId, result: result.kind, eventId: result.eventId });
      if (result.kind === "run") await result.done;
    } catch (cause) {
      log.warn("messenger.route_failed", { platform: context.platform, cause });
      if (strict) throw cause;
    }
  }

  private requireAccount(platform: string, selfId: string): ChatAccount {
    const account = this.options.account(platform, selfId);
    if (!account) throw new AppError(MESSENGER_ERRORS.messenger_account_unavailable, { effect: "none", detail: `${platform}:${selfId}` });
    return account;
  }

  private async track(task: Promise<void>): Promise<void> {
    this.tasks.add(task);
    try {
      await task;
    } finally {
      this.tasks.delete(task);
    }
  }
}

export function matchesAllowedChannel(ctx: ChannelContext, rules: readonly ChannelAllowRule[] | undefined): boolean {
  // Web conversations are the account holder's private chats with this bot, nothing else.
  if (ctx.platform === WEB_CHAT.platform)
    return ctx.type === "direct" && ctx.selfId === WEB_CHAT.selfId && webChatConversation(ctx.userId) !== undefined && ctx.channelId === ctx.userId;
  return (
    rules?.some(
      (rule) =>
        (rule.platform === "*" || rule.platform === ctx.platform) &&
        (rule.channelId === "*" || rule.channelId === ctx.channelId) &&
        (rule.isDirect === undefined || rule.isDirect === (ctx.type === "direct")),
    ) ?? false
  );
}
