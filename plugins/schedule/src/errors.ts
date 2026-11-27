import { PLATFORMS } from "@yesimbot/contracts/platforms";
import { AppError, defineErrors, toToolResult, type ToolFailure } from "@yesimbot/foundation";

/** The chats heartbeats run in, from the platform table (for example 「QQ 会话和网页私聊」). */
export const HEARTBEAT_CHATS = [
  ...PLATFORMS.filter((platform) => platform.heartbeat).map((platform) => `${platform.label} 会话`),
  ...PLATFORMS.filter((platform) => platform.ownerChat).map((platform) => `${platform.label}私聊`),
].join("和");

/** Where to go to create one (for example 「该 QQ 会话或网页私聊」). */
export const HEARTBEAT_TARGETS = [
  ...PLATFORMS.filter((platform) => platform.heartbeat).map((platform) => `该 ${platform.label} 会话`),
  ...PLATFORMS.filter((platform) => platform.ownerChat).map((platform) => `${platform.label}私聊`),
].join("或");

/**
 * The codes keep the names the schedule spec fixes and the console reads (`instance-work.ts`, `webui/schedules.ts`):
 * an AppError's `message` is its code, so the console's code matching still works.
 */
export const SCHEDULE_ERRORS = defineErrors({
  invalid_schedule: {
    model:
      "定时任务的内容不符合要求：标题最长 120 字，提示词最长 2000 字，做法记录最长 2000 字；at 须是未来的 RFC 3339 时刻，cron 须是五段式且相邻两次执行至少间隔 15 分钟；二者只能给一个。请修正后重试。",
    user: "定时任务的内容不符合要求。",
    status: 400,
  },
  invalid_purpose: { model: "purpose 只能是 task 或 heartbeat。", user: "任务用途不正确。", status: 400 },
  heartbeat_requires_qq: {
    model: `心跳仅支持${HEARTBEAT_CHATS}的周期任务。请先明确要接收心跳的目标会话，再到${HEARTBEAT_TARGETS}中创建；当前会话不能创建或改成心跳。`,
    user: `心跳仅支持${HEARTBEAT_CHATS}。`,
    status: 400,
  },
  heartbeat_requires_recurring: { model: "心跳必须使用周期规则 cron，不能使用一次性规则 at。", user: "心跳必须是周期任务。", status: 400 },
  schedule_limit_reached: { model: "当前会话已有 20 个启用的定时任务，请先取消或暂停一些再创建。", user: "当前会话的定时任务已达上限。", status: 409 },
  schedule_not_found: { model: "当前会话没有这个定时任务。", user: "找不到这个定时任务。", status: 404 },
  invalid_schedule_state: { model: "定时任务当前的状态不允许这个操作。", user: "定时任务当前的状态不允许这个操作。", status: 409 },
  schedule_changed: { model: "定时任务已被修改，请重新读取后再改。", user: "定时任务已被修改，请刷新后再试。", status: 409 },
  schedules_unavailable: { model: "定时任务服务暂时不可用。", user: "定时任务服务暂时不可用。", status: 503 },
});

const REJECTIONS: ReadonlySet<string> = new Set<ScheduleRejectionCode>([
  "invalid_schedule",
  "invalid_purpose",
  "heartbeat_requires_qq",
  "heartbeat_requires_recurring",
  "schedule_limit_reached",
  "schedule_not_found",
  "invalid_schedule_state",
]);

export type ScheduleRejectionCode = Exclude<keyof typeof SCHEDULE_ERRORS, "schedule_changed" | "schedules_unavailable">;

/** What a tool returns for a refusal made before anything was written. */
export type ScheduleToolRejection = ToolFailure & {
  executionStatus: "not_started";
  changed: false;
};

/** A refusal by a schedule guard before any database write; `detail` goes to the logs only. */
export function reject(code: ScheduleRejectionCode, detail: string): AppError {
  return new AppError(code, { effect: "none", detail });
}

/** True for the refusals `reject` raises; I/O failures and post-write failures never match. */
export function isRejection(cause: unknown): cause is AppError {
  return cause instanceof AppError && REJECTIONS.has(cause.code) && cause.effect === "none";
}

export function rejectionResult(cause: AppError): ScheduleToolRejection {
  return { ...toToolResult(cause), executionStatus: "not_started", changed: false };
}
