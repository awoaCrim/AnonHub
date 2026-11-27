import type { Agent } from "@yesimbot/agent-runtime";
import { createEventEntry, createInternalEvent } from "@yesimbot/agent-runtime";
import type { Part } from "@yesimbot/contracts/parts";
import type { Logger } from "@yesimbot/foundation";

import type { WillBatchDecision, WillState } from "../agents/will.js";
import type { ChannelContext } from "../channels/index.js";
import type { MessageBatchController, MessageBatchInput } from "../message-batches/index.js";
import { isEvent, isMessage, type Event, type Message } from "../messages/index.js";
import { partView } from "../messages/parts.js";
import type { TurnLedger } from "./turn-ledger.js";
import type { ChannelRuntimeOptions, RuntimeResult } from "./types.js";

/**
 * Decides which inputs start a turn: asks Will, collects inputs the message-batch plugin holds back, and picks the
 * input a batch answers. Starting the turn itself stays with the runtime (`startAdmitted`).
 */
export class AdmissionGate {
  private controller: MessageBatchController | undefined;
  private readonly pendingInputs = new Map<string, MessageBatchInput>();

  public constructor(
    private readonly deps: {
      readonly options: ChannelRuntimeOptions;
      readonly context: ChannelContext;
      readonly selfId: string;
      readonly logger: Logger;
      readonly ledger: TurnLedger;
      readonly agent: () => Agent;
      readonly observe: (input: Message | Event) => void;
      readonly state: () => WillState;
      readonly schedule: <T>(task: () => Promise<T>) => Promise<T>;
      readonly stopped: () => boolean;
      readonly startAdmitted: (input: MessageBatchInput, reservationId?: string, batchInputs?: readonly MessageBatchInput[]) => Promise<RuntimeResult>;
    },
  ) {}

  /** Whether a message-batch plugin is holding inputs back. */
  public get batching(): boolean {
    return this.controller !== undefined;
  }

  public async setup(): Promise<void> {
    const plugin = this.deps.options.messageBatch;
    if (!plugin) return;
    const controller = await plugin.setup(this.deps.context, (messages) => this.flush(messages), {
      flushInputs: (inputs) => this.flush(inputs),
    });
    if (this.deps.stopped()) {
      await controller.stop?.();
      return;
    }
    this.controller = controller;
  }

  /** Detaches the plugin and drops held inputs; resolves when the plugin has stopped. */
  public stop(): Promise<void> {
    const controller = this.controller;
    this.controller = undefined;
    this.pendingInputs.clear();
    return Promise.resolve(controller?.stop?.()).catch((cause) => this.deps.logger.warn("runtime.message_batch_stop_failed", { cause }));
  }

  public enqueue(input: MessageBatchInput): boolean {
    const controller = this.controller;
    if (!controller) return false;
    if (!isMessage(input) && (!this.deps.options.will.decideBatch || !controller.enqueueEvent)) return false;
    this.pendingInputs.set(input.id, input);
    try {
      if (isMessage(input)) {
        controller.enqueue(input);
        return true;
      }
      const accepted = controller.enqueueEvent!(input);
      if (!accepted) this.pendingInputs.delete(input.id);
      return accepted;
    } catch (cause) {
      this.pendingInputs.delete(input.id);
      this.deps.observe(input);
      throw cause;
    }
  }

  public async decide(input: Message | Event): Promise<"wait" | "trigger"> {
    let decision: "wait" | "trigger";
    try {
      decision = await this.deps.options.will.decide(input, this.deps.state());
    } catch (cause) {
      this.deps.observe(input);
      throw cause;
    }
    await this.persistWillDecision(input.id, decision);
    return decision;
  }

  public async decideBatch(inputs: readonly MessageBatchInput[]): Promise<WillBatchDecision> {
    let decision: WillBatchDecision;
    try {
      decision = await this.deps.options.will.decideBatch!(inputs, this.deps.state());
    } catch (cause) {
      for (const input of inputs) this.deps.observe(input);
      throw cause;
    }
    await this.persistWillDecision(inputs.at(-1)!.id, decision.decision, {
      candidate: decision.candidate,
      reservationId: decision.reservationId,
    });
    return decision;
  }

  private async persistWillDecision(eventId: string, decision: "wait" | "trigger", batch?: Record<string, unknown>): Promise<void> {
    try {
      const debug = this.deps.options.will.debug?.();
      await this.deps.options.channel.conversation.storage.append(
        createEventEntry(createInternalEvent({ type: "will.decision", eventId, decision, debug: batch ? { ...debug, batch } : debug })),
      );
    } catch (cause) {
      this.deps.logger.warn("runtime.will_decision_persist_failed", { eventId, cause });
    }
  }

  public flush(inputs: readonly MessageBatchInput[]): Promise<void> {
    const snapshot = [...inputs];
    if (snapshot.length === 0) return Promise.resolve();
    return this.deps.schedule(async () => {
      if (this.deps.stopped()) return;
      const pending: MessageBatchInput[] = [];
      for (const input of snapshot) {
        if (this.pendingInputs.get(input.id) !== input) continue;
        this.pendingInputs.delete(input.id);
        pending.push(input);
      }
      if (pending.length === 0) return;
      const latest = pending.at(-1)!;

      if (this.deps.options.will.decideBatch) {
        let decision: WillBatchDecision;
        try {
          decision = await this.decideBatch(pending);
        } catch (cause) {
          this.deps.logger.warn("runtime.message_batch_will_failed", { eventId: latest.id, cause });
          return;
        }
        if (decision.decision === "wait") {
          for (const input of pending) this.deps.observe(input);
          this.deps.logger.debug("runtime.message_batch_flush", { size: pending.length, trigger: false, latestEventId: latest.id });
          return;
        }
        const result = await this.startBatchDecision(pending, decision);
        this.deps.logger.debug("runtime.message_batch_flush", {
          size: pending.length,
          trigger: true,
          latestEventId: latest.id,
          candidate: decision.candidate,
          reservationId: decision.reservationId,
          result: result.kind,
          activeTurnId: this.deps.state().activeTurnId,
        });
        return;
      }

      const triggering: MessageBatchInput[] = [];
      for (const input of pending) {
        if (this.deps.stopped()) return;
        let decision: "wait" | "trigger";
        try {
          decision = await this.decide(input);
        } catch (cause) {
          this.deps.logger.warn("runtime.message_batch_will_failed", { eventId: input.id, cause });
          continue;
        }
        if (this.deps.stopped()) return;
        if (decision === "trigger") triggering.push(input);
      }
      if (triggering.length === 0 || this.deps.stopped()) {
        for (const input of pending) this.deps.observe(input);
        this.deps.logger.debug("runtime.message_batch_flush", { size: pending.length, trigger: false, latestEventId: latest.id });
        return;
      }
      const selected = this.selectBatchRequest(pending, triggering);
      this.logBatchRequest(pending, selected.reason, selected.input);
      const result = await this.deps.startAdmitted(selected.input, undefined, pending);
      this.deps.logger.debug("runtime.message_batch_flush", {
        size: pending.length,
        trigger: true,
        latestEventId: latest.id,
        result: result.kind,
        activeTurnId: this.deps.state().activeTurnId,
      });
    });
  }

  /** Select by request direction, never by whether the sender has a tool grant. */
  private selectBatchRequest(inputs: readonly MessageBatchInput[], triggering = inputs): { input: MessageBatchInput; reason: string } {
    if (this.deps.context.type !== "direct") {
      for (let index = triggering.length - 1; index >= 0; index -= 1) {
        const input = triggering[index]!;
        if (isEvent(input) || input.data.quote?.author?.id === this.deps.selfId || mentionsBot(input.data.parts, this.deps.selfId)) {
          return { input, reason: "addressed-trigger" };
        }
      }
    }
    return { input: inputs.at(-1)!, reason: this.deps.context.type === "direct" ? "direct-latest" : "latest-fallback" };
  }

  private logBatchRequest(inputs: readonly MessageBatchInput[], reason: string, selected?: MessageBatchInput): void {
    this.deps.logger.info("runtime.message_batch_request", {
      platform: this.deps.context.platform.slice(0, 128),
      channelId: this.deps.context.channelId.slice(0, 128),
      selfId: this.deps.selfId.slice(0, 128),
      inputIds: inputs.slice(0, 32).map((input) => input.id.slice(0, 128)),
      inputCount: inputs.length,
      selectedInputId: selected?.id.slice(0, 128),
      reason,
    });
  }

  public async startBatchDecision(inputs: readonly MessageBatchInput[], decision: WillBatchDecision): Promise<RuntimeResult> {
    const candidate = decision.candidate;
    const selected = candidate
      ? {
          input: inputs.find(
            (input) =>
              typeof candidate.authorId === "string" &&
              candidate.authorId.length > 0 &&
              input.id === candidate.inputId &&
              batchInputAuthor(input, this.deps.selfId) === candidate.authorId,
          ),
          reason: "will-candidate",
        }
      : this.selectBatchRequest(inputs);
    if (!selected.input || this.deps.stopped()) {
      for (const input of inputs) this.deps.observe(input);
      this.logBatchRequest(inputs, this.deps.stopped() ? "stopped" : "invalid-candidate");
      if (decision.reservationId) {
        await this.deps.ledger.settleReservation(decision.reservationId, { kind: "release", reason: "start-failed" }).catch((cause) => {
          this.deps.logger.warn("runtime.will_reservation_settlement_failed", { reservationId: decision.reservationId, cause });
        });
      }
      return { kind: "wait", eventId: inputs.at(-1)!.id };
    }
    this.logBatchRequest(inputs, selected.reason, selected.input);
    let result: RuntimeResult;
    try {
      result = await this.deps.startAdmitted(selected.input, decision.reservationId, inputs);
    } catch (cause) {
      if (decision.reservationId) {
        await this.deps.ledger.settleReservation(decision.reservationId, { kind: "release", reason: "start-failed" }).catch(() => undefined);
      }
      throw cause;
    }
    return result;
  }
}

function mentionsBot(parts: readonly Part[], selfId: string): boolean {
  return parts.some((part) => {
    const element = partView(part);
    if (element.type === "quote" || element.type === "reply") return false;
    if (element.type === "at" && element.attrs.type !== "all" && element.attrs.type !== "here" && String(element.attrs.id ?? "") === selfId) return true;
    return mentionsBot(element.children, selfId);
  });
}

function batchInputAuthor(input: MessageBatchInput, selfId: string): string | undefined {
  if (isMessage(input)) return input.data.user.id || undefined;
  const data = input.data as unknown as { readonly eventType?: string; readonly actorId?: unknown; readonly targetId?: unknown };
  return data.eventType === "notice.poke" && data.targetId === selfId && typeof data.actorId === "string" && data.actorId.length > 0 ? data.actorId : undefined;
}
