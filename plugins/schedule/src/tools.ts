import type { AgentTool } from "@yesimbot/agent-runtime";
import { isOwnerChat, platformLabel, supportsHeartbeat } from "@yesimbot/contracts/platforms";
import { toToolResult, type ToolFailure } from "@yesimbot/foundation";
import { z } from "zod/v4";

import { HEARTBEAT_TARGETS, isRejection, rejectionResult, type ScheduleToolRejection } from "./errors.js";
import type { ScheduleStore, ScheduleScope } from "./store.js";
import type { Schedule, ScheduleCreateInput, ScheduleProjection, ScheduleUpdateInput } from "./types.js";

const LIST_SCHEMA = z.strictObject({});

const DELIVERY_DESCRIPTION =
  "输出方式。普通任务：channel 发送到当前频道，silent 仅执行不发送消息。心跳：silent 为静默心跳，只隐藏检查过程，有值得告知的结论照常发消息；channel 为显式心跳，在对话里唤醒 bot。";

type CreateToolInput = z.infer<ReturnType<typeof createSchema>>;

type UpdateToolInput = z.infer<ReturnType<typeof updateSchema>>;

/** The fields were updated but the state change that followed was refused. */
type PartialRejection = ToolFailure & { executionStatus: "partial"; changed: true; schedule: ScheduleProjection };

type MutationResult = ScheduleProjection | ScheduleToolRejection | PartialRejection;

/**
 * Builds the three current-channel Schedule management tools for an AgentPlugin
 * runtime. Every tool operates on the factory's captured ChannelContext only:
 * no schema accepts a scope, channel, or Session parameter, and every Store
 * call passes the captured scope.
 */
export function createScheduleTools(scope: ScheduleScope, store: ScheduleStore, rearm?: () => Promise<void>): AgentTool[] {
  return [createTool(scope, store, rearm), listTool(scope, store), updateTool(scope, store, rearm)];
}

/** Flat create input: title, prompt, and exactly one canonical rule form. */
function createSchema(scope: ScheduleScope) {
  return z
    .strictObject({
      title: z.string().min(1).max(120).describe("任务标题，最长 120 字符"),
      prompt: z.string().min(1).max(2000).describe("到期时交给 Agent 的提示词，最长 2000 字符"),
      purpose: purposeSchema(scope).optional(),
      delivery: z.enum(["channel", "silent"]).describe(DELIVERY_DESCRIPTION).optional(),
      at: z.iso.datetime({ offset: true }).describe("一次性执行：一个未来的 RFC 3339 时刻，如 2030-01-01T08:00:00+08:00").optional(),
      cron: z.string().describe("周期执行：Asia/Shanghai 时区的五段式 cron 表达式（分 时 日 月 周），相邻两次执行至少间隔 15 分钟").optional(),
    })
    .refine((input) => (input.at === undefined) !== (input.cron === undefined), { message: "at 与 cron 必须且只能提供一个" });
}

/** Flat update input: id plus optional title/prompt and at most one rule form. */
function updateSchema(scope: ScheduleScope) {
  return (
    z
      .strictObject({
        id: z.string().describe("要更新的定时任务 ID"),
        title: z.string().min(1).max(120).describe("新标题，最长 120 字符").optional(),
        prompt: z.string().min(1).max(2000).describe("新提示词，最长 2000 字符").optional(),
        notes: z
          .string()
          .max(2000)
          .describe(
            "你自己的做法记录，整段替换，空字符串清空：怎么做成的、用哪个工具、点哪里、避开什么。到期时会附在任务后面。不得记录密码、cookie、token 或验证码",
          )
          .optional(),
        purpose: purposeSchema(scope).optional(),
        delivery: z
          .enum(["channel", "silent"])
          .describe("新的" + DELIVERY_DESCRIPTION)
          .optional(),
        at: z.iso.datetime({ offset: true }).describe("新的一次性执行时刻（RFC 3339，需在未来）").optional(),
        cron: z.string().describe("新的五段式 cron 表达式（Asia/Shanghai，最小间隔 15 分钟）").optional(),
        state: z.enum(["enabled", "paused", "cancelled"]).describe("目标状态：enabled 恢复已暂停的任务，paused 暂停，cancelled 取消（不可逆）").optional(),
      })
      // Rule replacement is optional, but at most one of at/cron may be present.
      .refine((input) => input.at === undefined || input.cron === undefined, { message: "at 与 cron 至多提供一个" })
  );
}

function purposeSchema(scope: ScheduleScope) {
  const heartbeat = supportsHeartbeat(scope.platform, scope.type);
  return z
    .enum(heartbeat ? (["task", "heartbeat"] as const) : (["task"] as const))
    .describe(
      heartbeat
        ? `task 为普通任务；heartbeat 为当前${heartbeatLabel(scope)}的定时心跳，按上下文和记忆检查相关新进展，有值得通知的变化才发言。只能配合 cron 使用，例如每半小时 */30 * * * *。`
        : `当前会话仅支持 task 普通任务。心跳须先明确接收目标，再到${HEARTBEAT_TARGETS}中创建；此工具不能指定其他会话。`,
    );
}

function heartbeatLabel(scope: ScheduleScope): string {
  return isOwnerChat(scope.platform, scope.type) ? "网页私聊" : `${platformLabel(scope.platform)} 会话`;
}

function toProjection(schedule: Schedule): ScheduleProjection {
  return {
    id: schedule.id,
    title: schedule.title,
    ...(schedule.purpose === "heartbeat" ? { purpose: "heartbeat" as const } : {}),
    delivery: schedule.delivery,
    kind: schedule.kind,
    state: schedule.state,
    nextRunAt: schedule.nextRunAt,
    lastResult: schedule.lastResult,
  };
}

async function mutateSchedule(change: () => Promise<Schedule>, rearm: (() => Promise<void>) | undefined): Promise<MutationResult> {
  let schedule: Schedule;
  try {
    schedule = await change();
  } catch (cause) {
    if (!isRejection(cause)) throw cause;
    return rejectionResult(cause);
  }
  // A failure here follows a database write. Keep it outside the pre-write rejection boundary.
  await rearm?.();
  return toProjection(schedule);
}

function createTool(scope: ScheduleScope, store: ScheduleStore, rearm: (() => Promise<void>) | undefined): AgentTool<CreateToolInput, MutationResult> {
  return {
    name: "schedule_create",
    description:
      (supportsHeartbeat(scope.platform, scope.type)
        ? `在当前${heartbeatLabel(scope)}创建定时任务，或 purpose=heartbeat 创建当前会话的心跳（例如 cron=*/30 * * * *）。`
        : `在当前会话创建普通定时任务。当前会话不支持心跳；请先明确目标，再到${HEARTBEAT_TARGETS}中创建心跳，此工具不能指定其他会话。`) +
      "at（一次性执行）或 cron（周期执行）二选一。delivery 可选 channel（默认，发送结果）或 silent（普通任务仅执行不发消息；心跳只隐藏检查过程，有结论照常发消息）。时间统一按 Asia/Shanghai 解释；at 使用 RFC 3339 时刻，cron 使用五段式表达式。",
    inputSchema: createSchema(scope),
    execute: async (input) => {
      const createInput: ScheduleCreateInput =
        input.at !== undefined
          ? { title: input.title, prompt: input.prompt, delivery: input.delivery, purpose: input.purpose, kind: "once", at: input.at }
          : { title: input.title, prompt: input.prompt, delivery: input.delivery, purpose: input.purpose, kind: "cron", cron: input.cron! };
      return mutateSchedule(() => store.create(scope, createInput), rearm);
    },
  };
}

function listTool(scope: ScheduleScope, store: ScheduleStore): AgentTool<Record<string, never>, ScheduleProjection[]> {
  return {
    name: "schedule_list",
    description:
      "列出当前会话的全部计划，包括普通定时任务和心跳。查询是否开启心跳时先调用本工具，以 purpose=heartbeat 和 state=enabled 判断，不能只看标题。空列表只表示当前会话没有计划，不代表系统没有心跳功能，也不能据此判断其他会话。返回 id、标题、用途、输出方式、类型（once/cron）、状态、下次执行时间和最近结果。lastResult 只记录 Agent 轮次是否结束和是否发出消息；completed 不代表签到、领取或其他外部操作成功。外部结果须核对网站或对应工具返回，不能由此推断已完成或编造奖励。",
    inputSchema: LIST_SCHEMA,
    execute: async () => (await store.list(scope)).map(toProjection),
  };
}

function updateTool(scope: ScheduleScope, store: ScheduleStore, rearm: (() => Promise<void>) | undefined): AgentTool<UpdateToolInput, MutationResult> {
  return {
    name: "schedule_update",
    description:
      "更新当前频道一个定时任务的标题、提示词、做法记录、输出方式、执行规则或状态。规则替换时 at 与 cron 至多提供一个；未提供的字段保持不变。标题和提示词是用户定的，只在用户要求时修改；做法记录 notes 是你自己的。" +
      "state 改变状态，可以和其他字段一起给（先改字段，再改状态）：enabled 恢复已暂停的任务并计算下一个未来执行时刻；paused 暂停启用中的任务，保留规则与最近结果，不再触发；" +
      "cancelled 取消启用或暂停的任务，本次及以后都不会再触发，不可逆，已取消的任务不能再恢复或改规则，只在确定不要了时用。",
    inputSchema: updateSchema(scope),
    execute: async ({ id, title, prompt, notes, delivery, purpose, at, cron, state }) => {
      let patch: ScheduleUpdateInput = {};
      if (at !== undefined) patch = { kind: "once", at };
      else if (cron !== undefined) patch = { kind: "cron", cron };
      if (title !== undefined) patch = { ...patch, title };
      if (prompt !== undefined) patch = { ...patch, prompt };
      if (notes !== undefined) patch = { ...patch, notes };
      if (purpose !== undefined) patch = { ...patch, purpose };
      if (delivery !== undefined) patch = { ...patch, delivery };
      const fields = Object.keys(patch).length > 0;
      if (state === undefined) return mutateSchedule(() => store.update(scope, id, patch), rearm);
      let schedule: Schedule | undefined;
      try {
        if (fields) schedule = await store.update(scope, id, patch);
        if (schedule?.state !== state) {
          schedule = state === "enabled" ? await store.resume(scope, id) : state === "paused" ? await store.pause(scope, id) : await store.cancel(scope, id);
        }
      } catch (cause) {
        if (!isRejection(cause)) throw cause;
        if (!schedule) return rejectionResult(cause);
        // The fields are already written: say so, and keep the schedule armed as it now stands.
        await rearm?.();
        return { ...toToolResult(cause), executionStatus: "partial", changed: true, schedule: toProjection(schedule) };
      }
      await rearm?.();
      return toProjection(schedule);
    },
  };
}
