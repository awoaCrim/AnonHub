import { errorFields, logger, type Clock, type Logger } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";

import type { PendingStore } from "./store/pending.js";
import type { PendingMemory } from "./types.js";

/** Source messages a batch may cover; also caps the conversation read for that batch. */
export const MAX_MESSAGES_PER_BATCH = 300;
/** Pending remember requests consolidated in one maintenance run. */
const MAX_PENDING_PER_BATCH = 10;

/** Starts a one-shot (or repeating) timer and returns its cancel; the host's timers go away with the plugin. */
export type MemoryTimer = (callback: () => void, milliseconds: number) => () => void;

export interface MemorySchedulerHost {
  readonly clock: Clock;
  readonly timer: MemoryTimer;
  readonly interval: MemoryTimer;
  readonly logger?: Logger;
}

export class MemoryScheduler {
  private cancelTimer?: () => void;
  private cancelSweep?: () => void;
  private stopped = false;
  private running?: Promise<void>;
  private readonly log: Logger;

  public constructor(
    private readonly pending: Pick<PendingStore, "nextDueAt" | "list" | "nextBatch" | "complete" | "fail">,
    private readonly run: (channel: ChannelContext, batch: readonly PendingMemory[]) => Promise<void>,
    private readonly host: MemorySchedulerHost,
    private readonly sweep?: () => Promise<void>,
  ) {
    this.log = host.logger ?? logger("yesimbot.memorizer");
  }

  public async start(): Promise<void> {
    this.stopped = false;
    await this.arm();
    if (this.sweep) {
      await this.sweep();
      this.cancelSweep = this.host.interval(
        () => void this.sweep!().catch((cause: unknown) => this.log.warn("scheduler.sweep_failed", { ...errorFields(cause) })),
        24 * 60 * 60 * 1_000,
      );
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.cancelSweep?.();
    this.cancelSweep = undefined;
    await this.running;
  }

  public async runDue(now = this.host.clock.now()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runDueInner(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  public async arm(): Promise<void> {
    if (this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const due = await this.pending.nextDueAt();
    if (due === undefined) return;
    this.cancelTimer = this.host.timer(() => void this.runDue(), Math.max(0, due - this.host.clock.now()));
  }

  private async runDueInner(now: number): Promise<void> {
    const channels = new Map<string, ChannelContext>();
    for (const item of await this.pending.list()) {
      if (!item.suspended && item.nextAttemptAt <= now) channels.set(channelKey(item.channel), item.channel);
    }
    for (const channel of channels.values()) {
      const batch = await this.pending.nextBatch(channel, MAX_PENDING_PER_BATCH, MAX_MESSAGES_PER_BATCH);
      if (!batch.length) continue;
      try {
        await this.run(channel, batch);
        await this.pending.complete(batch.map((item) => item.id));
      } catch (cause) {
        this.log.warn("scheduler.batch_failed", { ...errorFields(cause), count: batch.length });
        await this.pending.fail(
          batch.map((item) => item.id),
          cause,
          this.host.clock.now(),
        );
      }
    }
    await this.arm();
  }
}

function channelKey(context: ChannelContext): string {
  return context.type === "direct"
    ? `${context.type}\u0000${context.platform}\u0000${context.selfId}\u0000${context.channelId}`
    : `${context.type}\u0000${context.platform}\u0000${context.selfId}\u0000${context.guildId}\u0000${context.channelId}`;
}
