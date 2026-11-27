import { AppError, defineErrors, errorFields, logger, type Logger } from "@yesimbot/foundation";
import type {
  ChannelContext,
  Event,
  Message,
  MessageBatchController,
  MessageBatchInput,
  MessageBatchPlugin,
  MessageBatchSetupExtensions,
} from "koishi-plugin-yesimbot/kernel";

import type { Config } from "./config.js";

export const DEBOUNCE_ERRORS = defineErrors({
  debounce_stopped: { model: "消息防抖已经停止。", user: "消息防抖已经停止。", status: 503 },
});

/** Starts a one-shot timer and returns its cancel; the host's timers go away with the plugin. */
export type ScheduleTimer = (callback: () => void, milliseconds: number) => () => void;

type FlushMessages = (messages: readonly Message[]) => Promise<void>;

type FlushInputs = (inputs: readonly MessageBatchInput[]) => Promise<void>;

export class MessageDebounceController implements MessageBatchController {
  private readonly inputs: MessageBatchInput[] = [];
  private timerDisposer: (() => void) | undefined;
  private generation = 0;
  private stopped = false;

  public constructor(
    private readonly schedule: ScheduleTimer,
    private readonly quietMilliseconds: number,
    private readonly flushMessages: FlushMessages,
    private readonly flushInputs: FlushInputs | undefined,
    private readonly logger: Logger,
    private readonly onStop: () => void,
  ) {}

  public enqueue(input: Message): void {
    if (this.stopped) return;
    this.inputs.push(input);
    this.refreshTimer();
  }

  public enqueueEvent(input: Event): boolean {
    if (this.stopped || !this.flushInputs || !isTargetedPoke(input)) return false;
    this.inputs.push(input);
    this.refreshTimer();
    return true;
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.timerDisposer?.();
    this.timerDisposer = undefined;
    this.inputs.length = 0;
    this.onStop();
  }

  private refreshTimer(): void {
    this.timerDisposer?.();
    const generation = ++this.generation;
    this.timerDisposer = this.schedule(() => this.expire(generation), this.quietMilliseconds);
  }

  private expire(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.timerDisposer = undefined;
    const snapshot = this.inputs.splice(0);
    if (snapshot.length === 0) return;
    const task = this.flushInputs ? this.flushInputs(snapshot) : this.flushMessages(snapshot as readonly Message[]);
    void task.catch((cause: unknown) => {
      this.logger.warn("message_debounce.flush_failed", { ...errorFields(cause) });
    });
  }
}

/** Per-conversation trailing-edge debounce for group messages and targeted pokes; direct chats never wait. */
export class MessageDebounce implements MessageBatchPlugin {
  public readonly priority = 1_000;

  private readonly controllers = new Set<MessageDebounceController>();
  private readonly logger: Logger = logger("yesimbot.message-debounce");
  private readonly quietMilliseconds: number;
  private stopped = false;

  public constructor(
    config: Config,
    private readonly schedule: ScheduleTimer,
  ) {
    this.quietMilliseconds = config.quietSeconds * 1_000;
  }

  public match(context: ChannelContext): boolean {
    return context.type !== "direct";
  }

  public setup(context: ChannelContext, flushMessages: FlushMessages, extensions?: MessageBatchSetupExtensions): MessageBatchController {
    if (this.stopped) throw new AppError(DEBOUNCE_ERRORS.debounce_stopped, { effect: "none" });
    let controller!: MessageDebounceController;
    controller = new MessageDebounceController(this.schedule, this.quietMilliseconds, flushMessages, extensions?.flushInputs, this.logger, () =>
      this.controllers.delete(controller),
    );
    this.controllers.add(controller);
    this.logger.debug("message_debounce.controller_created", {
      type: context.type,
      platform: context.platform,
      channelId: context.channelId,
      quietMilliseconds: this.quietMilliseconds,
      eventBatching: extensions !== undefined,
    });
    return controller;
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const controller of [...this.controllers]) controller.stop();
    this.controllers.clear();
  }
}

function isTargetedPoke(input: Event): boolean {
  const data = input.data as unknown as { readonly eventType?: string; readonly actorId?: unknown; readonly targetId?: unknown };
  return data.eventType === "notice.poke" && typeof data.actorId === "string" && data.actorId.length > 0 && data.targetId === input.data.selfId;
}
