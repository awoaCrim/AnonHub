import type { Agent, AgentPlugin } from "@yesimbot/agent-runtime";
import { AppError, retry, type Logger } from "@yesimbot/foundation";

import type { WillEngine, WillReservationOutcome } from "../agents/will.js";
import type { MessageBatchInput } from "../message-batches/index.js";
import { isEvent, type Event, type Message } from "../messages/index.js";
import { RUNTIME_ERRORS } from "./errors.js";
import type { ChannelRuntimeOptions, RuntimeResult } from "./types.js";

export interface TurnDeliveryTracker {
  readonly reservationId?: string;
  /** User input may only join a visible conversation containing user messages. */
  readonly acceptsUserInput: boolean;
  /** Only Will-admitted, unbatched handle messages may supersede another ordinary chat. */
  chatInputs?: readonly MessageBatchInput[];
  needsStepCommit?: boolean;
  interruptRequested?: boolean;
  turnId?: string;
  delivered: boolean;
  active: boolean;
  deliveredMessageId?: string;
  settled: boolean;
  settlement?: Promise<void>;
}

/**
 * Per-turn delivery state of one channel: which tracker belongs to which turn, which turns were superseded by newer
 * user input or are silent, the one queued ordinary chat turn that newer input may still join, and the Will
 * reservation each turn settles exactly once.
 */
export class TurnLedger {
  private readonly trackers = new Map<string, TurnDeliveryTracker>();
  private pending: { readonly turnId: string; readonly tracker: TurnDeliveryTracker } | undefined;
  private readonly superseded = new Set<string>();
  /** Turns started by a silent post; authored `send_message` is blocked for them. */
  private readonly silent = new Set<string>();

  public constructor(
    private readonly deps: {
      /** The agent is built after the ledger, because its plugins come from it. */
      readonly agent: () => Agent;
      readonly will: WillEngine;
      readonly logger: Logger;
      readonly abortReply: (turnId: string) => void;
      readonly announceEnd: (turnId: string) => void;
      readonly channelOutputTools: ChannelRuntimeOptions["channelOutputTools"];
    },
  ) {}

  public trackerOf(turnId: string): TurnDeliveryTracker | undefined {
    return this.trackers.get(turnId);
  }

  public activeTracker(): TurnDeliveryTracker | undefined {
    const active = this.deps.agent().getActiveTurnId();
    return active === null ? undefined : this.trackers.get(active);
  }

  public isSuperseded(turnId: string): boolean {
    return this.superseded.has(turnId);
  }

  public isSilent(turnId: string): boolean {
    return this.silent.has(turnId);
  }

  public markSilent(turnId: string): void {
    this.silent.add(turnId);
  }

  public setPending(turnId: string, tracker: TurnDeliveryTracker): void {
    this.pending = { turnId, tracker };
  }

  public clearPending(): void {
    this.pending = undefined;
  }

  public bind(tracker: TurnDeliveryTracker, turnId: string): void {
    if (tracker.turnId && tracker.turnId !== turnId) {
      this.deps.logger.warn("runtime.will_reservation_turn_mismatch", {
        expectedTurnId: tracker.turnId,
        actualTurnId: turnId,
        reservationId: tracker.reservationId,
      });
      return;
    }
    const existing = this.trackers.get(turnId);
    if (existing && existing !== tracker) {
      this.deps.logger.warn("runtime.delivery_tracker_collision", { turnId, reservationId: tracker.reservationId });
      return;
    }
    tracker.turnId = turnId;
    this.trackers.set(turnId, tracker);
  }

  /** Forgets a finished turn's tracker, silence and supersession. */
  public release(tracker: TurnDeliveryTracker): void {
    if (!tracker.turnId) return;
    this.silent.delete(tracker.turnId);
    if (this.trackers.get(tracker.turnId) === tracker) this.trackers.delete(tracker.turnId);
    this.superseded.delete(tracker.turnId);
  }

  /** Records the first delivered message of an active turn and commits its Will reservation. */
  public recordDelivered(turnId: string, messageId: string): void {
    const tracker = this.trackers.get(turnId);
    if (!tracker?.active || tracker.settled || tracker.delivered) return;
    tracker.delivered = true;
    tracker.deliveredMessageId = messageId;
    if (tracker.reservationId) {
      const settlement = this.settle(tracker, { kind: "commit", turnId, messageId });
      void settlement.catch(() => undefined);
    }
  }

  public settle(tracker: TurnDeliveryTracker, outcome: WillReservationOutcome): Promise<void> {
    if (!tracker.reservationId || tracker.settled) return Promise.resolve();
    if (tracker.settlement) return tracker.settlement;
    const settlement = this.settleReservation(tracker.reservationId, outcome).then(() => {
      tracker.settled = true;
    });
    let tracked!: Promise<void>;
    tracked = settlement.finally(() => {
      if (tracker.settlement === tracked) tracker.settlement = undefined;
    });
    tracker.settlement = tracked;
    return tracked;
  }

  public async settleAtTerminal(tracker: TurnDeliveryTracker, outcome: WillReservationOutcome): Promise<void> {
    const active = tracker.settlement;
    if (active) await active.catch(() => undefined);
    if (!tracker.settled) await this.settle(tracker, outcome);
  }

  public async settleReservation(reservationId: string, outcome: WillReservationOutcome): Promise<void> {
    const { will, logger } = this.deps;
    const settle = will.settleReservation;
    if (!settle) throw new AppError(RUNTIME_ERRORS.runtime_setup_conflict, { effect: "none", detail: "reservation without settlement" });
    await retry(
      async (attempt) => {
        try {
          await settle.call(will, reservationId, outcome);
        } catch (cause) {
          logger.warn("runtime.will_reservation_settlement_retry", { reservationId, outcome, attempt, cause });
          throw cause;
        }
      },
      { attempts: 3, classify: () => "transient", effect: "idempotent", backoff: { baseMs: 0, factor: 1, maxMs: 0, jitter: false } },
    );
  }

  /** Lets a newer ordinary chat input replace the queued turn's input; undefined when no queued turn took it. */
  public async joinPending(input: Message, batchInputs: readonly MessageBatchInput[], reservationId?: string): Promise<RuntimeResult | undefined> {
    const pending = this.pending;
    if (pending && this.deps.agent().replaceQueued(pending.turnId, input, { contextMessages: batchInputs.filter((candidate) => candidate !== input) })) {
      pending.tracker.chatInputs = [...new Set([...(pending.tracker.chatInputs ?? []), ...batchInputs, input])];
      this.supersede(pending.turnId);
      if (reservationId) {
        await this.settleReservation(reservationId, { kind: "release", turnId: pending.turnId, reason: "coalesced-pending-turn" });
      }
      return { kind: "join", eventId: input.id, turnId: pending.turnId };
    }
    this.pending = undefined;
    return undefined;
  }

  /** Supersedes every other active ordinary chat turn; returns the events they had joined, to carry into the new turn. */
  public supersede(exceptTurnId?: string): Event[] {
    const agent = this.deps.agent();
    const joinedEvents: Event[] = [];
    for (const [turnId, tracker] of this.trackers) {
      if (turnId === exceptTurnId || !tracker.active || !tracker.chatInputs) continue;
      const first = !this.superseded.has(turnId);
      this.superseded.add(turnId);
      // Release even an input interrupted before admission as history. Re-submitting old inputs
      // as new live context would reserve visible history again and move it after its tool result.
      // A late web consumer may outlive its Agent turn; never add its input to another turn's live
      // collector. Only the active owner can still have joined inputs awaiting admission.
      if (first && agent.getActiveTurnId() === turnId) {
        for (const input of tracker.chatInputs) agent.observe(input);
        // Unprocessed joined events are omitted by historical projection, so retain them as live
        // replacement context. prepareStep removes events once their owning turn admitted them.
        joinedEvents.push(...tracker.chatInputs.filter(isEvent));
      }
      this.deps.abortReply(turnId);
      this.deps.announceEnd(turnId);
      if (!tracker.needsStepCommit) this.interruptSuperseded(turnId, tracker);
    }
    return [...new Set(joinedEvents)];
  }

  private interruptSuperseded(turnId: string, tracker: TurnDeliveryTracker): void {
    const agent = this.deps.agent();
    if (tracker.interruptRequested || agent.getActiveTurnId() !== turnId || !this.superseded.has(turnId)) return;
    tracker.interruptRequested = true;
    void agent.interrupt("new-user-message").catch((cause) => this.deps.logger.warn("runtime.input_interrupt_failed", { turnId, cause }));
  }

  public supersessionPlugin(): AgentPlugin {
    let dispose: (() => void) | undefined;
    return {
      name: "core.input-supersession",
      init: ({ channel }) => {
        dispose = channel.subscribe("internal", (event) => {
          if (event.type === "turn.start" && this.pending?.turnId === event.turnId) this.pending = undefined;
          if (event.type === "tool.start") {
            const tracker = this.trackers.get(event.turnId);
            if (tracker?.chatInputs) tracker.needsStepCommit = true;
          }
          if (event.type !== "turn.step") return;
          const tracker = this.trackers.get(event.turnId);
          if (!tracker) return;
          // afterToolCall runs before the journal and SDK pair are stored. turn.step is emitted
          // only after the complete native step is durable, so a replacement can safely read it.
          tracker.needsStepCommit = false;
          if (this.superseded.has(event.turnId)) this.interruptSuperseded(event.turnId, tracker);
        });
      },
      beforeToolCall: (_call, context) => {
        if (this.superseded.has(context.turnId)) return { type: "block", reason: "本轮已有新的用户消息，停止旧回复和后续工具调用。", retry: false };
        return { type: "allow" };
      },
      prepareStep: (_messages, context) => {
        const tracker = this.trackers.get(context.turnId);
        if (!tracker?.chatInputs || !context.messages) return;
        const admitted = new Set(context.messages.map((message) => message.id));
        tracker.chatInputs = tracker.chatInputs.filter((input) => !isEvent(input) || !admitted.has(input.id));
      },
      stop: () => dispose?.(),
    };
  }

  /** Silent posts must not reach the channel, so `send_message` is refused for their turns. */
  public silentTurnPlugin(): AgentPlugin {
    return {
      name: "core.silent-turn",
      beforeToolCall: (call, context) => {
        const channelOutput = call.toolName === "send_message" || (this.deps.channelOutputTools?.has(call.toolName) ?? false);
        return channelOutput && this.silent.has(context.turnId)
          ? { type: "block", reason: "本轮是静默后台任务，不能向频道发送消息或调用频道输出工具。完成任务后调用 finish 结束本轮。" }
          : { type: "allow" };
      },
    };
  }
}
