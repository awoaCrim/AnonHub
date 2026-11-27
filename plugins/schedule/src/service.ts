import type { AgentPlugin } from "@yesimbot/agent-runtime";
import { AppError, logger, type Clock, type Logger } from "@yesimbot/foundation";
import { protectPluginTools, type ChannelContext, type ChannelPlugin, type ChatAccount } from "koishi-plugin-yesimbot/kernel";

import type { Config } from "./config.js";
import { isRejection } from "./errors.js";
import { ScheduleScheduler, type DuePoster, type ScheduleTimer } from "./scheduler.js";
import { ScheduleStore, type ScheduleScope, type ScheduleTable } from "./store.js";
import { createScheduleTools } from "./tools.js";
import type { Schedule, ScheduleRunsSnapshot, ScheduleUpdateInput } from "./types.js";

/** What the console's schedule pages call; the glue publishes it as the `yesimbotSchedule` service. */
export interface ScheduleManager {
  list(): Promise<Array<Schedule & { revision: string }>>;
  runs(id: string, before?: string): Promise<ScheduleRunsSnapshot>;
  update(id: string, revision: string, input: ScheduleUpdateInput): Promise<void>;
  delete(id: string, revision: string): Promise<void>;
}

/** The part of Core's `ctx.yesimbot` the schedule needs. */
export interface ScheduleHostApi {
  readonly agent: { use(plugin: ChannelPlugin): () => void };
  readonly identity: { conversation(scope: ChannelContext): Promise<Parameters<typeof protectPluginTools>[1]> };
  readonly messenger: DuePoster;
}

export interface ScheduleServiceDeps {
  readonly table: ScheduleTable;
  readonly host: ScheduleHostApi;
  readonly timer: ScheduleTimer;
  readonly clock: Clock;
  /** Outlives plugin reloads (the shared SQLite handle): finishing turns of an older plugin share its write queue. */
  readonly stateHost?: object;
  /** Publishes the manager for the console and returns its disposer. */
  readonly publish: (manager: ScheduleManager) => () => void;
  readonly logger?: Logger;
}

/**
 * The Schedule capability. It recovers and arms the earliest-due timer on `start`, registers one
 * current-channel AgentPlugin factory and publishes the console's manager. `stop` closes scheduler admission and clears
 * the timer while leaving persisted rows intact.
 */
export class ScheduleService implements ChannelPlugin {
  public readonly id = "yesimbot-schedule";
  public readonly store: ScheduleStore;

  private readonly log: Logger;
  private scheduler?: ScheduleScheduler;
  private disposeAgentPlugin?: () => void;
  private disposeManagement?: () => void;
  private started = false;
  private generation = 0;

  public constructor(
    private readonly deps: ScheduleServiceDeps,
    private readonly config: Partial<Config> = {},
  ) {
    this.log = deps.logger ?? logger("yesimbot.schedule");
    this.store = new ScheduleStore(deps.table, deps.clock, deps.stateHost ?? deps.table);
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    let scheduler: ScheduleScheduler | undefined;
    try {
      scheduler = new ScheduleScheduler(this.store, {
        messenger: this.deps.host.messenger,
        timer: this.deps.timer,
        clock: this.deps.clock,
        logger: this.log,
      });
      this.scheduler = scheduler;
      await scheduler.start();
      if (!this.started || generation !== this.generation) {
        scheduler.stop();
        return;
      }
      this.disposeAgentPlugin = this.deps.host.agent.use(this);
      this.disposeManagement = this.deps.publish(this.manager());
      this.log.info("service.started");
    } catch (cause) {
      scheduler?.stop();
      if (generation === this.generation) {
        this.started = false;
        this.scheduler = undefined;
      }
      throw cause;
    }
  }

  public async setup(scope: ChannelContext, bot: ChatAccount): Promise<AgentPlugin | null> {
    if (!this.scheduler) return null;
    const scheduleScope = { ...scope, selfId: bot.selfId } as ScheduleScope;
    return protectPluginTools(
      {
        name: "schedule",
        tools: () => createScheduleTools(scheduleScope, this.store, () => this.scheduler?.rearm() ?? Promise.resolve()),
      } satisfies AgentPlugin,
      await this.deps.host.identity.conversation(scheduleScope),
      this.id,
    );
  }

  public stop(): void {
    this.started = false;
    this.generation++;
    this.disposeManagement?.();
    this.disposeManagement = undefined;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    this.scheduler?.stop();
    this.scheduler = undefined;
    this.log.info("service.stopped");
  }

  private manager(): ScheduleManager {
    const available = () => {
      if (!this.started) throw new AppError("schedules_unavailable", { effect: "none" });
    };
    return {
      list: () => this.store.listAll(),
      runs: (id, before) => {
        available();
        return this.store.listRunsManaged(id, before);
      },
      update: async (id, revision, input) => {
        available();
        try {
          await this.store.updateManaged(id, revision, input);
        } catch (cause) {
          // The console reads one fixed code for every refused edit.
          if (isRejection(cause) && cause.code !== "schedule_not_found") throw new AppError("invalid_schedule", { effect: "none", cause });
          throw cause;
        }
        await this.rearm();
      },
      delete: async (id, revision) => {
        available();
        await this.store.deleteManaged(id, revision);
        await this.rearm();
      },
    };
  }

  private async rearm(): Promise<void> {
    await this.scheduler?.rearm();
  }
}
