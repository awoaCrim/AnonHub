/** Read-only view of persisted tasks in the current runtime, across all conversations. */
export interface ScheduledTask {
  id: string;
  revision: string;
  title: string;
  prompt: string;
  /** The bot's own notes on how it did this task before (做法记录). */
  notes: string | null;
  platform: string;
  selfId: string;
  channelId: string;
  type: "channel" | "guild" | "direct" | "shared";
  kind: "once" | "cron";
  at: string | null;
  cron: string | null;
  state: "enabled" | "paused" | "cancelled" | "completed";
  purpose?: "task" | "heartbeat";
  delivery: "channel" | "silent";
  nextRunAt: string | null;
  /** ISO times the schedule was created and last edited; absent from older servers. */
  createdAt?: string;
  updatedAt?: string;
  lastResult: {
    occurrenceAt: string;
    status: "submitting" | "accepted" | "completed" | "undelivered" | "failed" | "missed" | "interrupted";
    finishedAt?: string;
    notified?: boolean;
  } | null;
}

export interface SchedulesSnapshot {
  available: boolean;
  tasks: ScheduledTask[];
}

/** Host observations of an occurrence; completion does not prove an external action succeeded. */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  occurrenceAt: string;
  recordedAt: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  turnId?: string;
  status: "queued" | "running" | "accepted" | "completed" | "undelivered" | "failed" | "missed" | "interrupted";
  purpose: "task" | "heartbeat";
  delivery: "channel" | "silent";
  notified?: boolean;
  /** Fixed safe description, without provider details or model output. */
  error?: { code: string; message: string };
}

export interface ScheduleRunsSnapshot {
  runs: ScheduleRun[];
  nextCursor: string | null;
  /** Recent terminal/unknown records; active receipts are retained in addition. */
  retainedLimit: number;
}
