import { newId } from "@yesimbot/foundation";

import type { ScheduleRow, ScheduleRunRecord, ScheduleRunsSnapshot } from "./types.js";

export const SCHEDULE_RUN_RETENTION = 100;

export const SCHEDULE_RUN_PAGE_SIZE = 20;

const reasons = {
  turn_failed: "执行轮次失败，未确认任务完成。",
  turn_aborted: "执行轮次被中止，结果需要核实。",
  submission_failed: "无法提交计划执行，未确认任务完成。",
  runtime_closed: "运行环境已停止，本次执行被中断。",
  process_interrupted: "进程中断，执行结果需要核实；未自动重新执行。",
  conversation_busy: "当前会话正忙，本次检查已跳过。",
  previous_running: "上一次检查仍在执行，本次检查已跳过。",
  concurrency_limit: "同时执行的计划已达上限，本次已跳过。",
  overdue: "计划到期时运行环境不可用，已跳过。",
} as const;

export type ScheduleRunReason = keyof typeof reasons;

export function runError(code: ScheduleRunReason): { code: ScheduleRunReason; message: string } {
  return { code, message: reasons[code] };
}

export function activeRun(run: ScheduleRunRecord): boolean {
  return run.status === "queued" || run.status === "running";
}

export function newRun(row: ScheduleRow, occurrenceAt: string, at: string, queued = true): ScheduleRunRecord {
  return {
    id: newId(),
    scheduleId: row.id,
    sequence: Math.max(0, ...(row.runs ?? []).map((run) => run.sequence)) + 1,
    occurrenceAt,
    recordedAt: at,
    ...(queued ? { queuedAt: at } : {}),
    status: "queued",
    purpose: row.purpose ?? "task",
    delivery: row.delivery ?? "channel",
  };
}

/** Never evict an in-flight receipt just because a later occurrence finished first. */
export function retainRuns(runs: readonly ScheduleRunRecord[]): ScheduleRunRecord[] {
  let retained = 0;
  return [...runs].sort((a, b) => b.sequence - a.sequence).filter((run) => activeRun(run) || ++retained <= SCHEDULE_RUN_RETENTION);
}

export function runSnapshot(row: ScheduleRow, before?: string): ScheduleRunsSnapshot {
  let upper = Infinity;
  if (before !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(before)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(before, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== row.id || !Number.isSafeInteger(value[1]) || value[1] < 1) throw new Error();
      upper = value[1];
    } catch {
      throw new Error("invalid_schedule_cursor");
    }
  }
  const ordered = [...(row.runs ?? [])].filter((run) => run.sequence < upper).sort((a, b) => b.sequence - a.sequence);
  const page = ordered.slice(0, SCHEDULE_RUN_PAGE_SIZE);
  return {
    runs: page.map(({ sequence: _sequence, ...run }) => structuredClone(run)),
    nextCursor: ordered.length > page.length ? Buffer.from(JSON.stringify([row.id, page.at(-1)!.sequence])).toString("base64url") : null,
    retainedLimit: SCHEDULE_RUN_RETENTION,
  };
}
