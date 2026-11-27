export type ScheduleState = "enabled" | "paused" | "cancelled" | "completed";

export type ScheduleDelivery = "channel" | "silent";

/** A host-observed occurrence, separate from the schedule's latest-result summary. */
export type ScheduleRun = {
  id: string;
  scheduleId: string;
  occurrenceAt: string;
  recordedAt: string;
  /** Absent for an occurrence skipped before admission. */
  queuedAt?: string;
  /** Present only after Core reports the actual turn start. */
  startedAt?: string;
  /** Unknown outcomes do not claim that the turn finished. */
  finishedAt?: string;
  turnId?: string;
  status: "queued" | "running" | "accepted" | "completed" | "undelivered" | "failed" | "missed" | "interrupted";
  purpose: "task" | "heartbeat";
  delivery: ScheduleDelivery;
  notified?: boolean;
  /** Fixed safe descriptions, never provider errors or model output. */
  error?: { code: string; message: string };
};

/** A monotonic position makes pagination stable while new occurrences arrive. */
export type ScheduleRunRecord = ScheduleRun & {
  sequence: number;
};

export type ScheduleRunsSnapshot = {
  runs: ScheduleRun[];
  nextCursor: string | null;
  /** Completed/unknown records retained per schedule; active records are also kept. */
  retainedLimit: number;
};

/**
 * `submitting` lasts for the whole turn. `completed`: the turn finished and replied (or was silent by
 * choice). `undelivered`: it finished without sending anything. `accepted`: submitted, outcome unknown
 * (rows written before outcomes were reported). `failed`: rejected, or the turn failed. `interrupted`:
 * stopped or aborted before finishing. `missed`: never ran.
 */
export type ScheduleLastResult = {
  occurrenceAt: string;
  status: "submitting" | "accepted" | "completed" | "undelivered" | "failed" | "missed" | "interrupted";
  finishedAt?: string;
  /** Whether this check produced a platform notification. */
  notified?: boolean;
  error?: { name: string; message: string };
};

export type Schedule = {
  id: string;
  type: "channel" | "guild" | "direct" | "shared";
  platform: string;
  selfId: string;
  channelId: string;
  /** The private chat's user for direct schedules, so a due run lands in that same conversation. */
  userId?: string;
  title: string;
  prompt: string;
  /** The bot's own notes on how this task was done before; never the owner's title or prompt. */
  notes?: string;
  purpose?: "task" | "heartbeat";
  delivery: ScheduleDelivery;
  state: ScheduleState;
  /** Null while the schedule is paused, cancelled, or completed. */
  nextRunAt: string | null;
  lastResult?: ScheduleLastResult;
  createdAt: string;
  updatedAt: string;
} & ({ kind: "once"; at: string; cron?: never } | { kind: "cron"; cron: string; at?: never });

export type ScheduleCreateInput = { title: string; prompt: string; delivery?: ScheduleDelivery; purpose?: "task" | "heartbeat" } & (
  | { kind: "once"; at: string; cron?: never }
  | { kind: "cron"; cron: string; at?: never }
);

/** `notes: ""` clears the notes. */
export type ScheduleUpdateInput = { title?: string; prompt?: string; notes?: string; delivery?: ScheduleDelivery; purpose?: "task" | "heartbeat" } & (
  | { kind?: "once"; at?: string; cron?: never }
  | { kind?: "cron"; cron?: string; at?: never }
);

/**
 * The compact, tool-facing view of a Schedule: identity, lifecycle, and next
 * execution only. Raw scope coordinates, rule, prompt, and audit fields are
 * intentionally absent so Agent tool output stays small and channel-bound.
 */
export type ScheduleProjection = {
  id: string;
  title: string;
  purpose?: "task" | "heartbeat";
  delivery: ScheduleDelivery;
  kind: "once" | "cron";
  state: ScheduleState;
  nextRunAt: string | null;
  lastResult?: ScheduleLastResult;
};

/**
 * The physical row of `schedule_tasks` table. It keeps the
 * raw scope coordinates and both rule columns; exactly one of `at`/`cron` is
 * non-null for a given `kind`.
 */
export type ScheduleRow = {
  id: string;
  type: "channel" | "guild" | "direct" | "shared";
  platform: string;
  selfId: string;
  channelId: string;
  /** Null on rows written before it was stored, and for non-direct schedules. */
  userId: string | null;
  title: string;
  prompt: string;
  notes: string | null;
  purpose?: "task" | "heartbeat";
  delivery: ScheduleDelivery;
  kind: "once" | "cron";
  at: string | null;
  cron: string | null;
  state: ScheduleState;
  nextRunAt: string | null;
  lastResult: ScheduleLastResult | null;
  /** Missing on legacy rows; those summaries are never backfilled as history. */
  runs?: ScheduleRunRecord[] | null;
  createdAt: string;
  updatedAt: string;
};

declare module "koishi-plugin-yesimbot/kernel" {
  interface EventMap {
    "schedule.due": { schedule: { id: string; title: string; kind: "once" | "cron"; scheduledFor: string }; user?: { id: string } };
  }
}
