import { AppError, defineErrors, errorEntry, type ErrorEffect } from "@yesimbot/foundation";

import { MAX_TASK_CONTINUATIONS, TASK_MINUTES } from "./limits.js";

/** Background tasks: delegations refused before anything ran, task operations, and why a worker stopped. */
export const TASK_ERRORS = defineErrors({
  task_time_limit_required: {
    model: "委派时要写 timeLimitMinutes：预计这件事要多少分钟。到时任务不会停，只会提醒你。",
    user: "委派时要写预计用时。",
    status: 400,
  },
  task_time_limit_invalid: {
    model: `时间限制要是 ${TASK_MINUTES.min}–${TASK_MINUTES.max} 之间的整数（分钟）。`,
    user: `时间限制要是 ${TASK_MINUTES.min}–${TASK_MINUTES.max} 分钟。`,
    status: 400,
  },
  task_not_running: {
    model: "这个任务现在没有在运行，不需要延长；要它接着做就用 task_control 的 update 补充说明。",
    user: "这个任务现在没有在运行。",
    status: 409,
  },
  task_instruction_html: {
    model:
      "委派说明里有整段 HTML，没有创建任务。渲染不需要后台：自己调用渲染工具，把完整 HTML 直接作为参数传入。确实要后台处理这段 HTML，就先写进工作目录，说明里只给路径。",
    user: "委派说明里有整段 HTML，没有创建任务。",
    status: 400,
  },
  task_continuation_limit: {
    model: `这项工作已经连续接续 ${MAX_TASK_CONTINUATIONS} 次仍未完成。不要再委派；向用户说明已完成的部分、卡在哪里和建议的下一步。`,
    user: `这项工作已经连续接续 ${MAX_TASK_CONTINUATIONS} 次仍未完成。`,
    status: 409,
  },
  task_model_not_allowed: {
    model: "后台任务所选模型已不在可用列表中，请检查模型设置。",
    user: "后台任务所选模型已不在可用列表中，请检查模型设置。",
    status: 400,
  },
  task_model_unavailable: { model: "后台任务模型当前不可用，请检查模型设置。", user: "后台任务模型当前不可用，请检查模型设置。", status: 503 },
  task_not_found: { model: "找不到这个任务。", user: "找不到这个任务。", status: 404 },
  task_already_finished: { model: "这个任务已经结束了。", user: "这个任务已经结束了。", status: 409 },
  task_service_stopping: { model: "后台任务服务正在停止。", user: "服务正在重启，稍后再试。", status: 503, retryable: true },
  task_handoff_note_invalid: { model: "交还说明要是不超过 8000 字的文字。", user: "交还说明太长了。", status: 400 },
  task_handoff_stale: { model: "这次交接已结束或已更新。", user: "这次交接已结束或已更新，请刷新任务状态。", status: 409 },
  task_handoff_not_ready: { model: "电脑还没交还或不在线。", user: "请先交还电脑并确认它在线。", status: 409 },
  task_queue_full: { model: "未完成的后台任务太多，先等一些结束。", user: "未完成的后台任务太多了。", status: 429 },
  task_store_invalid: { model: "任务记录文件已损坏。", user: "任务记录文件已损坏。", status: 500 },
  task_cancelled: { model: "任务已取消。", user: "任务已取消。", status: 409 },
  task_tool_denied: { model: "后台代理不能用这个工具。", user: "后台代理不能用这个工具。", status: 403 },
  task_conversation_missing: { model: "任务所属会话不存在，未能继续执行。", user: "任务所属会话不存在，未能继续执行。", status: 404 },
  task_bot_unavailable: { model: "任务所属机器人当前不可用。", user: "任务所属机器人当前不可用。", status: 503 },
  task_session_archived: { model: "任务所属会话已归档，未继续执行。", user: "任务所属会话已归档，未继续执行。", status: 409 },
  task_worker_report_missing: { model: "后台代理没有提交有效任务报告。", user: "后台代理没有提交有效任务报告。", status: 500 },
  task_worker_turn_failed: { model: "后台代理执行中断。", user: "后台代理执行中断。", status: 500 },
  task_worker_budget_exceeded: { model: "任务达到上下文预算，已停止继续请求。", user: "任务达到上下文预算。", status: 413 },
});

/** Refusals a task tool answers as a result instead of failing: nothing ran, and the model gets the registered advice. */
const REFUSALS: ReadonlySet<string> = new Set<string>([
  TASK_ERRORS.task_time_limit_required,
  TASK_ERRORS.task_time_limit_invalid,
  TASK_ERRORS.task_not_running,
  TASK_ERRORS.task_instruction_html,
  TASK_ERRORS.task_continuation_limit,
  TASK_ERRORS.task_model_not_allowed,
  TASK_ERRORS.task_model_unavailable,
]);

/** Why a worker stopped, named in the task result with its own sentence; anything else is `worker_failed`. */
const REPORTED: ReadonlySet<string> = new Set<string>([
  TASK_ERRORS.task_model_not_allowed,
  TASK_ERRORS.task_model_unavailable,
  TASK_ERRORS.task_conversation_missing,
  TASK_ERRORS.task_bot_unavailable,
  TASK_ERRORS.task_session_archived,
  TASK_ERRORS.task_worker_report_missing,
  TASK_ERRORS.task_worker_turn_failed,
]);

export type TaskErrorCode = (typeof TASK_ERRORS)[keyof typeof TASK_ERRORS];

/** A task error; by default nothing happened yet. */
export function taskError(code: TaskErrorCode, options: { readonly detail?: string; readonly cause?: unknown; readonly effect?: ErrorEffect } = {}): AppError {
  return new AppError(code, { effect: "none", ...options });
}

export function isTaskRefusal(cause: unknown): cause is AppError {
  return cause instanceof AppError && REFUSALS.has(cause.code);
}

/** `<sentence> [<code>]` for a failure the task result names, or `undefined`. */
export function reportedTaskFailure(cause: unknown): string | undefined {
  if (!(cause instanceof AppError) || !REPORTED.has(cause.code)) return undefined;
  return `${errorEntry(cause.code)!.model} [${cause.code}]`;
}
