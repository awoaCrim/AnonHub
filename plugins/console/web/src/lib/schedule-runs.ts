import type { ScheduleRun } from "../../../src/shared/schedules";

const clock = (seconds: boolean) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
const minuteClock = clock(false),
  secondClock = clock(true);

/** Schedules use Beijing time, independent of the browser's local timezone. */
export function formatScheduleTime(value: string, seconds = false): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? (seconds ? secondClock : minuteClock).format(date) : "时间不可读";
}

export function runLabel(run: ScheduleRun): string {
  if (run.status === "completed" && run.purpose === "heartbeat" && run.notified !== undefined) return run.notified ? "已通知" : "无需通知";
  return {
    queued: "等待执行",
    running: "执行中",
    accepted: "结果未知",
    completed: "已结束",
    undelivered: "未发送回复",
    failed: "执行失败",
    missed: "未执行",
    interrupted: "已中断",
  }[run.status];
}

export function runDescription(run: ScheduleRun): string {
  switch (run.status) {
    case "queued":
      return "已进入队列，尚未开始执行。";
    case "running":
      return "本轮正在执行。";
    case "accepted":
      return "已提交执行，未收到可确认的最终结果。";
    case "completed":
      if (run.purpose === "heartbeat")
        return run.notified ? "本次检查已结束，并发送了通知。" : run.notified === false ? "本次检查已结束，未发送通知。" : "本次检查已结束。";
      return run.delivery === "silent" ? "本轮已结束，按计划静默执行。" : "本轮已结束。具体任务结果请以所属会话的回复或对应服务记录为准。";
    case "undelivered":
      return "本轮已结束，但没有向所属会话发送回复。";
    case "failed":
      return "本轮执行失败。";
    case "missed":
      return "本次计划没有执行。";
    case "interrupted":
      return "本轮在完成前中断。";
  }
}

export function runDuration(run: ScheduleRun): string {
  // Recovery records when an interruption was discovered, not when execution stopped.
  if (!run.startedAt || !run.finishedAt || run.error?.code === "process_interrupted") return "—";
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "不足 1 秒";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function runInProgress(run: ScheduleRun): boolean {
  return run.status === "queued" || run.status === "running";
}
