import type { AgentTool } from "@yesimbot/agent-runtime";
import type { TaskRecord } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import type { Host } from "./host.js";
import { projectRun, projectTask, scheduleErrorCode, validatePatch, type ScheduleManager } from "./webui/schedules.js";

/** Fixed task and schedule failures a tool may name; anything else is `instance_operation_failed`. */
export const WORK_ERRORS = [
  "task_not_found",
  "task_handoff_stale",
  "task_handoff_not_ready",
  "task_model_not_allowed",
  "task_model_unavailable",
  "schedule_changed",
  "schedule_not_found",
  "schedules_unavailable",
  "invalid_schedule",
  "schedules_not_permitted",
] as const;

const TASK_ID = /^[a-f0-9-]{36}$/;

const FINISHED_SHOWN = 20;

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "unknown"]);

/** The instance-management tool factory: authentication, role and error handling are its own. */
export type InstanceToolFactory = (
  name: string,
  description: string,
  write: boolean,
  shape: z.ZodRawShape,
  action: (value: Record<string, unknown>, authorize: () => void) => Promise<unknown> | unknown,
) => AgentTool;

/**
 * The account holder's background tasks and schedules across every conversation of this instance, as the
 * 任务 and 定时任务 pages show and change them. The per-conversation `task_*` and `schedule_*` tools stay as they are.
 */
export function createWorkTools(ctx: Host, tool: InstanceToolFactory, schedulesPermitted: () => boolean): { reads: AgentTool[]; writes: AgentTool[] } {
  const tasks = () => ctx.yesimbot.tasks;
  const schedules = () => {
    if (!schedulesPermitted()) throw Error("schedules_not_permitted");
    const manager = ctx.get("yesimbotSchedule") as ScheduleManager | undefined;
    if (!manager) throw Error("schedules_unavailable");
    return manager;
  };
  const taskId = (value: unknown) => {
    if (typeof value !== "string" || !TASK_ID.test(value)) throw Error("invalid_instance_request");
    return value;
  };
  const scheduleId = (value: unknown) => {
    if (typeof value !== "string" || !value || value.length > 128) throw Error("invalid_instance_request");
    return value;
  };
  const scheduleRevision = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw Error("invalid_instance_request");
    return value;
  };
  const changeSchedule = async (change: () => Promise<void>) => {
    try {
      await change();
    } catch (cause) {
      throw Error(scheduleErrorCode(cause, true), { cause });
    }
  };

  const reads = [
    tool(
      "instance_tasks",
      "查看本实例所有会话的后台任务（任务页上的全部任务），不只是当前会话。不带 id 返回简表：未结束的全部，已结束的最近 20 个，说明、进度和结果只取开头，conversation 是任务所属会话；带 id 返回该任务的完整说明、进度、结果和待处理的人工交接。",
      false,
      { id: z.string().max(36).optional() },
      async (value) => {
        const rows = [...(await tasks().store.list())].sort((a, b) => b.updatedAt - a.updatedAt);
        if (value.id !== undefined) {
          const row = rows.find((item) => item.id === taskId(value.id));
          if (!row) throw Error("task_not_found");
          return fullTask(row);
        }
        const finished = (row: TaskRecord) => TERMINAL.has(row.status) || row.continuedBy !== undefined;
        const open = rows.filter((row) => !finished(row)),
          closed = rows.filter(finished);
        return {
          tasks: [...open, ...closed.slice(0, FINISHED_SHOWN)].map((row) => ({
            id: row.id,
            conversation: row.channel,
            kind: row.kind,
            status: row.status,
            instruction: clip(row.instruction),
            ...(row.progress ? { progress: clip(row.progress) } : {}),
            ...(row.result ? { result: clip(row.result) } : {}),
            ...(row.handoff?.state === "pending" ? { handoff: { id: row.handoff.id, state: row.handoff.state } } : {}),
            ...(row.continuedBy ? { continuedBy: row.continuedBy } : {}),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
          ...(closed.length > FINISHED_SHOWN ? { olderFinished: closed.length - FINISHED_SHOWN } : {}),
        };
      },
    ),
    tool(
      "instance_schedules",
      "查看本实例所有会话的定时任务和心跳（定时任务页上的全部），不只是当前会话。不带 id 返回列表（提示词只取开头），带 id 返回该计划的完整内容和最近的执行记录（before 翻到更早一页）。修改和删除要用这里拿到的 revision。lastResult 只说明那一轮是否结束、是否发了消息，不代表外部操作已成功。",
      false,
      { id: z.string().max(128).optional(), before: z.string().max(256).optional() },
      async (value) => {
        const manager = schedules();
        const rows = (await manager.list()).map(projectTask);
        if (value.id === undefined) {
          if (value.before !== undefined) throw Error("invalid_instance_request");
          return { schedules: rows.map((row) => ({ ...row, prompt: clip(row.prompt, 120)!, notes: clip(row.notes ?? undefined, 120) ?? null })) };
        }
        const row = rows.find((item) => item.id === scheduleId(value.id));
        if (!row) throw Error("schedule_not_found");
        if (value.before !== undefined && (typeof value.before !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.before)))
          throw Error("invalid_instance_request");
        const runs = manager.runs ? await manager.runs(row.id, value.before as string | undefined) : undefined;
        return {
          schedule: row,
          ...(runs ? { runs: runs.runs.filter((run) => run.scheduleId === row.id).map(projectRun), nextCursor: runs.nextCursor } : {}),
        };
      },
    ),
  ];

  const writes = [
    tool(
      "instance_task_control",
      "管理本实例任一会话的后台任务：cancel 取消（已经发生的外部操作不会撤销）；update 把补充说明交给它（instruction）；resolve_handoff 在用户说已完成人工处理后继续（handoffId 取自 instance_tasks，instruction 可写处理说明）。先用 instance_tasks 看清是哪个任务。",
      true,
      {
        id: z.string().max(36),
        action: z.enum(["cancel", "update", "resolve_handoff"]),
        instruction: z.string().max(8000).optional(),
        handoffId: z.string().max(36).optional(),
      },
      async (value, authorize) => {
        const id = taskId(value.id);
        const instruction = typeof value.instruction === "string" ? value.instruction.trim() : value.instruction;
        if (instruction !== undefined && typeof instruction !== "string") throw Error("invalid_instance_request");
        authorize();
        try {
          if (value.action === "cancel") return await tasks().cancel(id);
          if (value.action === "update") {
            if (!instruction) throw Error("invalid_instance_request");
            return await tasks().update(id, instruction);
          }
          if (value.action === "resolve_handoff") return await tasks().resolveHandoff(id, taskId(value.handoffId), instruction ?? "");
        } catch (cause) {
          // A task model error carries its code; the plain ones are their message.
          const code = cause instanceof Error ? ("code" in cause && typeof cause.code === "string" ? cause.code : cause.message) : "";
          throw Error(code, { cause });
        }
        throw Error("invalid_instance_request");
      },
    ),
    tool(
      "instance_schedule_update",
      "修改本实例任一会话的一个定时任务或心跳；必须携带 instance_schedules 拿到的最新 revision。patch 可含 title、prompt、notes、delivery（channel|silent）、purpose（task|heartbeat）和规则（kind=once 配 at，或 kind=cron 配 cron），只改给出的字段。标题和提示词是用户定的，只在用户要求时改。冲突（schedule_changed）时重新读取。",
      true,
      { id: z.string().max(128), revision: z.string().max(64), patch: z.record(z.string(), z.unknown()) },
      async (value, authorize) => {
        const id = scheduleId(value.id),
          revision = scheduleRevision(value.revision);
        let patch: Record<string, unknown>;
        try {
          patch = validatePatch(value.patch);
        } catch {
          throw Error("invalid_schedule");
        }
        const manager = schedules();
        authorize();
        await changeSchedule(() => manager.update(id, revision, patch));
        const row = (await manager.list().catch(() => [])).find((item) => item.id === id);
        return { ok: true, ...(row ? { schedule: projectTask(row) } : {}) };
      },
    ),
    tool(
      "instance_schedule_delete",
      "删除本实例任一会话的一个定时任务或心跳及其记录，删除后不会再触发；必须携带最新 revision。只想暂时不执行时，用户若没说删除，先确认。",
      true,
      { id: z.string().max(128), revision: z.string().max(64) },
      async (value, authorize) => {
        const id = scheduleId(value.id),
          revision = scheduleRevision(value.revision);
        const manager = schedules();
        authorize();
        await changeSchedule(() => manager.delete(id, revision));
        return { ok: true, id };
      },
    ),
  ];
  return { reads, writes };
}

const clip = (text: string | undefined, points = 100) => {
  if (text === undefined) return undefined;
  const chars = Array.from(text);
  return chars.length > points ? `${chars.slice(0, points).join("")}…` : text;
};

/** One task in full, without its internal key, captured source or notification bookkeeping. */
function fullTask(row: TaskRecord) {
  return {
    id: row.id,
    conversation: row.channel,
    session: row.session,
    kind: row.kind,
    status: row.status,
    instruction: row.instruction,
    ...(row.modelRef ? { model: row.modelRef } : {}),
    ...(row.progress ? { progress: row.progress } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.handoff ? { handoff: row.handoff } : {}),
    ...(row.pauseReason ? { pauseReason: row.pauseReason } : {}),
    ...(row.continues ? { continues: row.continues } : {}),
    ...(row.continuedBy ? { continuedBy: row.continuedBy } : {}),
    ...(row.artifacts?.length ? { artifacts: row.artifacts } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
