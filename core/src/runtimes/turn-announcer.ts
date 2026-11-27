import { type Logger } from "@yesimbot/foundation";

import type { ChannelContext } from "../channels/index.js";
import type { CoreEventBus } from "../events.js";

/**
 * Tells listeners (typing, activity) when a turn starts and ends. Every announced start is cleared exactly once.
 * Observational only: a failing listener must never break the turn or its terminal settlement.
 */
export class TurnAnnouncer {
  private readonly announced = new Set<string>();
  /** Turns whose process is not shown (no typing or activity); their messages are still delivered. */
  private readonly quiet = new Set<string>();
  /** Web turns currently showing a pre-tool sentence as activity, cleared by the next step. */
  private readonly webActivity = new Set<string>();

  public constructor(
    private readonly events: CoreEventBus,
    private readonly context: ChannelContext,
    private readonly logger: Logger,
    private readonly isSuperseded: (turnId: string) => boolean,
  ) {}

  public announce(turnId: string, active: boolean, activity?: string): void {
    if (active) {
      if (this.isSuperseded(turnId) || this.quiet.has(turnId)) return;
      this.announced.add(turnId);
    } else {
      this.webActivity.delete(turnId);
      if (!this.announced.delete(turnId)) return;
    }
    try {
      this.events.emit("yesimbot/turn", { context: this.context, turnId, active, ...(activity ? { activity } : {}) });
    } catch (cause) {
      this.logger.warn("runtime.turn_listener_failed", { turnId, active, cause });
    }
  }

  public isQuiet(turnId: string): boolean {
    return this.quiet.has(turnId);
  }

  public markQuiet(turnId: string): void {
    this.quiet.add(turnId);
  }

  public clearQuiet(turnId: string): void {
    this.quiet.delete(turnId);
  }

  public markWebActivity(turnId: string): void {
    this.webActivity.add(turnId);
  }

  /** True when the turn was showing activity, which this clears. */
  public takeWebActivity(turnId: string): boolean {
    return this.webActivity.delete(turnId);
  }
}
