import type { AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { createRandomId, type TurnResult } from "@yesimbot/agent-runtime";
import { type Clock, type Logger } from "@yesimbot/foundation";

import { isWebChatAccount } from "../accounts.js";
import { createReplyTools } from "../agents/reply-tools.js";
import type { DeliveredNotice, SendFailedNotice } from "../agents/tools.js";
import { createWebReplyTools } from "../agents/web-reply.js";
import { beginReplyJournal } from "../conversations/reply-journal.js";
import type { ChannelRuntimeOptions } from "./types.js";

/** What the runtime needs from its message sender, whichever platform it serves. */
interface ReplySender {
  finishTurn(turnId: string): Promise<void>;
  invalidate(): void;
  settle(): Promise<void>;
  abortTurn(turnId: string): void;
}

/**
 * The runtime's one message sender, and the reply-proof writes it starts. Chat platforms get the authored `parts`
 * sender; web chat gets its own `send_message` (one literal Markdown message per call). Either way only what the
 * sender delivers reaches the user.
 */
export class ReplyDelivery {
  public readonly tools: AgentTool[];
  private readonly sender: ReplySender;
  private readonly proofWrites = new Set<Promise<void>>();

  public constructor(deps: {
    readonly options: ChannelRuntimeOptions;
    readonly web: boolean;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly stopped: () => boolean;
    /** Whether `turnId` may still reach the channel: not stopped, silent, superseded or replaced. */
    readonly turnAllowed: (turnId: string) => boolean;
    readonly onDelivered: (notice: DeliveredNotice) => void;
    readonly onFailed: (notice: SendFailedNotice) => void;
  }) {
    const { options } = deps;
    const channelId = options.channel.context.channelId;
    if (deps.web && isWebChatAccount(options.bot)) {
      const web = createWebReplyTools({
        bot: options.bot,
        channelId,
        resources: options.channel.resources,
        innerThought: options.config.customInnerThought === true,
        allowed: deps.turnAllowed,
        onDelivered: deps.onDelivered,
        onFailed: deps.onFailed,
      });
      this.sender = web;
      this.tools = web.tools;
      return;
    }
    const conversation = options.channel.conversation;
    const set = createReplyTools({
      clock: deps.clock,
      bot: options.bot,
      channelId,
      resources: options.channel.resources,
      pacing: options.config.pacing,
      innerThought: options.config.customInnerThought,
      stillAllowed: () => !deps.stopped() && (options.replyStillCurrent?.() ?? true),
      ...(options.sticker ? { sticker: options.sticker } : {}),
      journal: {
        begin: (input) => {
          const sessionId = conversation.currentSessionId();
          return beginReplyJournal({
            ...input,
            clock: deps.clock,
            sink: conversation.replyProofSink(),
            onWrite: (task) => {
              this.proofWrites.add(task);
              void task.then(
                () => this.proofWrites.delete(task),
                () => this.proofWrites.delete(task),
              );
            },
            sessionId,
            generation: conversation.storageGeneration,
            invocationId: createRandomId(),
          });
        },
      },
      onDelivered: deps.onDelivered,
      onFailed: deps.onFailed,
      onWarn: (reason, detail) => deps.logger.warn(reason, detail),
    });
    // The silent-turn boundary is rechecked at admission and before every transport.
    set.setTurnAllowed(deps.turnAllowed);
    this.sender = {
      finishTurn: (turnId) => set.finishTurn(turnId),
      invalidate: () => set.invalidate(),
      settle: () => set.coordinator.settle(),
      abortTurn: (turnId) => set.coordinator.abortTurn(turnId),
    };
    this.tools = set.tools;
  }

  public abortTurn(turnId: string): void {
    this.sender.abortTurn(turnId);
  }

  public invalidate(): void {
    this.sender.invalidate();
  }

  /** Waits for every send and reply-proof write still in flight. */
  public async settle(): Promise<void> {
    await this.sender.settle();
    await Promise.allSettled([...this.proofWrites]);
  }

  public plugin(): AgentPlugin {
    return {
      name: "core.reply-lifecycle",
      onTurnFinish: async (_result: TurnResult, context: { turnId: string }) => {
        await this.sender.finishTurn(context.turnId);
        await Promise.allSettled([...this.proofWrites]);
      },
    };
  }
}
