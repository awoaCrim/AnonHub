import type { TurnResult } from "@yesimbot/agent-runtime";
import { REPLY_TRIGGER_DEFAULTS, type ReplyTriggerConfig } from "@yesimbot/contracts/reply-triggers";

import type { ChannelContext } from "../channels/index.js";
import type { MessageBatchInput } from "../message-batches/index.js";
import { CHANNEL_TYPE, isMessage, type Event, type Message } from "../messages/index.js";
import { partView } from "../messages/parts.js";
import type { Awaitable } from "../types.js";

export const defaultWillEngine: WillEngine = {
  decide(input: Message | Event, _state: WillState): "wait" | "trigger" {
    if (!isMessage(input)) return "wait";
    if (input.data.channel.type === CHANNEL_TYPE.direct) return "trigger";
    return input.data.parts.some((part) => isMentionOf(partView(part), input.data.selfId)) ? "trigger" : "wait";
  },
  debug(): WillDebug {
    return {
      engine: "default",
      config: { direct: "trigger", mention: "trigger", group: "wait" },
    };
  },
};

export type WillReservationOutcome =
  | { readonly kind: "commit"; readonly turnId: string; readonly messageId: string }
  | {
      readonly kind: "release";
      readonly turnId?: string;
      readonly reason: "done-without-delivery" | "failed" | "aborted" | "consume-failed" | "start-failed" | "joined-active-turn" | "coalesced-pending-turn";
    };

export interface WillState {
  readonly activeTurnId: string | null;
}

export interface WillBatchDecision {
  readonly decision: "wait" | "trigger";
  readonly candidate?: {
    readonly inputId: string;
    readonly authorId: string;
    readonly score: number;
    readonly probability: number;
  };
  readonly reservationId?: string;
}

export interface WillEngine {
  decide(input: Message | Event, state: WillState): Awaitable<"wait" | "trigger">;
  decideBatch?(inputs: readonly MessageBatchInput[], state: WillState): Awaitable<WillBatchDecision>;
  settleReservation?(reservationId: string, outcome: WillReservationOutcome): Awaitable<void>;
  observe?(result: TurnResult): Awaitable<void>;
  debug?(): WillDebug | undefined;
}

export interface WillDebug {
  readonly engine: "default" | "routing" | "willingness";
  readonly config?: Record<string, unknown>;
  readonly score?: number;
  readonly probability?: number;
}

export interface WillPlugin {
  readonly priority: number;
  /** Whether this plugin decides when the bot replies in this conversation. */
  match(context: ChannelContext): boolean;
  setup(context: ChannelContext): Awaitable<WillEngine>;
}

/** Specific events take precedence over the ordinary-group fallback. Quoted content never triggers mentions/images. */
export function fixedReplyEngine(config: ReplyTriggerConfig): WillEngine {
  const rules = { ...REPLY_TRIGGER_DEFAULTS, ...config.rules };
  return {
    decide(input, state) {
      if (!config.platforms.includes(input.data.platform)) return defaultWillEngine.decide(input, state);
      if (!isMessage(input)) {
        return input.data.eventType === "notice.poke" && input.data.targetId === input.data.selfId && rules.poke ? "trigger" : "wait";
      }
      if (input.data.channel.type === CHANNEL_TYPE.direct) return rules.direct ? "trigger" : "wait";
      const elements = input.data.parts.map(partView);
      const matches: boolean[] = [];
      if (elements.some((e) => isMentionOf(e, input.data.selfId))) matches.push(rules.mention);
      if (elements.some((e) => e.type === "at" && e.attrs.type === "all")) matches.push(rules.all);
      if (elements.some((e) => e.type === "at" && e.attrs.type === "here")) matches.push(rules.online);
      if (input.data.quote || elements.some((e) => e.type === "quote" || e.type === "reply")) matches.push(rules.quote);
      if (elements.some((e) => e.type === "img" || e.type === "image")) matches.push(rules.image);
      return (matches.length ? matches.some(Boolean) : rules.group) ? "trigger" : "wait";
    },
    debug: () => ({ engine: "routing", config: { ...rules } }),
  };
}

function isMentionOf(element: { readonly type: string; readonly attrs: { readonly [key: string]: unknown } }, userId: string): boolean {
  return element.type === "at" && String(element.attrs.id) === userId;
}
