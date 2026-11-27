import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { ScheduledTask, ScheduleRun, ScheduleRunsSnapshot, SchedulesSnapshot } from "../shared/schedules.js";
import { authorizeOwner } from "./plugins.js";

export const SCHEDULES_PATH = "/yesimbot/api/v1/schedules";

const runErrors: Record<string, string> = {
  turn_failed: "执行轮次失败，未确认任务完成。",
  turn_aborted: "执行轮次被中止，结果需要核实。",
  submission_failed: "无法提交计划执行，未确认任务完成。",
  runtime_closed: "运行环境已停止，本次执行被中断。",
  process_interrupted: "进程中断，执行结果需要核实；未自动重新执行。",
  conversation_busy: "当前会话正忙，本次检查已跳过。",
  previous_running: "上一次检查仍在执行，本次检查已跳过。",
  concurrency_limit: "同时执行的计划已达上限，本次已跳过。",
  overdue: "计划到期时运行环境不可用，已跳过。",
};

/** The optional plugin serializes changes with scheduler claims and rearms its timer. */
export interface ScheduleManager {
  list(): Promise<ScheduledTask[]>;
  runs?(id: string, before?: string): Promise<ScheduleRunsSnapshot>;
  update(id: string, revision: string, input: Record<string, unknown>): Promise<void>;
  delete(id: string, revision: string): Promise<void>;
}

export function installSchedules(ctx: Host, auth: AdminAuth, permitted: () => boolean) {
  ctx.server.get(`${SCHEDULES_PATH}/:id/runs`, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const allowed = () => {
      if (permitted()) return true;
      http.status = 403;
      http.body = { message: "not_permitted" };
      return false;
    };
    if (!allowed()) return;
    try {
      const id = http.params.id;
      const before = http.query.before;
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 128 ||
        (before !== undefined && (typeof before !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(before))) ||
        Object.keys(http.query).some((key) => key !== "before")
      )
        throw new Error("invalid_schedule_cursor");
      const manager = ctx.get("yesimbotSchedule") as ScheduleManager | undefined;
      if (!manager?.runs) throw new Error("schedules_unavailable");
      const snapshot = await manager.runs(id, before as string | undefined);
      if (!authorizeOwner(http, auth) || !allowed()) return;
      http.body = {
        runs: snapshot.runs.filter((run) => run.scheduleId === id).map(projectRun),
        nextCursor: snapshot.nextCursor,
        retainedLimit: snapshot.retainedLimit,
      } satisfies ScheduleRunsSnapshot;
    } catch (cause) {
      if (!authorizeOwner(http, auth) || !allowed()) return;
      const code = cause instanceof Error ? cause.message : "";
      const message = code === "schedule_not_found" ? code : code === "invalid_schedule_cursor" ? code : "schedules_unavailable";
      http.status = message === "schedule_not_found" ? 404 : message === "invalid_schedule_cursor" ? 400 : 503;
      http.body = { message };
    }
  });

  ctx.server.get(SCHEDULES_PATH, async (http) => {
    // Members are relayed to their own isolated runtime before this route. Never expose parent tasks.
    if (!authorizeOwner(http, auth)) return;
    const allowed = () => {
      if (permitted()) return true;
      http.status = 403;
      http.body = { message: "not_permitted" };
      return false;
    };
    if (!allowed()) return;
    try {
      const manager = ctx.get("yesimbotSchedule") as ScheduleManager | undefined;
      if (!manager) {
        http.body = { available: false, tasks: [] } satisfies SchedulesSnapshot;
        return;
      }
      const rows = await manager.list();
      if (!authorizeOwner(http, auth) || !allowed()) return;
      http.body = {
        available: true,
        tasks: rows.map(projectTask).sort((a, b) => {
          if (a.nextRunAt === null && b.nextRunAt !== null) return 1;
          if (a.nextRunAt !== null && b.nextRunAt === null) return -1;
          return (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "") || a.id.localeCompare(b.id);
        }),
      } satisfies SchedulesSnapshot;
    } catch {
      if (!authorizeOwner(http, auth) || !allowed()) return;
      http.status = 503;
      http.body = { message: "schedules_unavailable" };
    }
  });

  for (const operation of ["update", "delete"] as const) {
    ctx.server.post(`${SCHEDULES_PATH}/${operation}`, async (http) => {
      if (!authorizeOwner(http, auth, true)) return;
      const authorized = () => {
        if (!authorizeOwner(http, auth, true)) return false;
        if (permitted()) return true;
        http.status = 403;
        http.body = { message: "not_permitted" };
        return false;
      };
      if (!authorized()) return;
      let mutating = false;
      try {
        const input = (await readAdminLoginBody(http, 16 * 1024)) as Record<string, unknown>;
        if (
          !input ||
          typeof input.id !== "string" ||
          !input.id ||
          input.id.length > 128 ||
          typeof input.revision !== "string" ||
          !/^[a-f0-9]{64}$/.test(input.revision)
        )
          throw new Error("invalid_schedule");
        const keys = operation === "update" ? ["id", "revision", "patch"] : ["id", "revision"];
        if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("invalid_schedule");
        const patch = operation === "update" ? validatePatch(input.patch) : undefined;
        if (!authorized()) return;
        const manager = ctx.get("yesimbotSchedule") as ScheduleManager | undefined;
        if (!manager) throw new Error("schedules_unavailable");
        mutating = true;
        if (operation === "update") await manager.update(input.id, input.revision, patch!);
        else await manager.delete(input.id, input.revision);
        if (operation === "delete") {
          if (authorized()) http.body = { ok: true, id: input.id };
          return;
        }
        // The manager returns nothing from update, so read the saved row back in the list's view shape. A failed read-back only drops `task`.
        let task: ScheduledTask | undefined;
        try {
          const row = (await manager.list()).find((item) => item.id === input.id);
          if (row) task = projectTask(row);
        } catch {}
        if (authorized()) http.body = { ok: true, ...(task ? { task } : {}) };
      } catch (cause) {
        if (!authorized()) return;
        const message = scheduleErrorCode(cause, mutating);
        http.status = message === "schedule_changed" ? 409 : message === "schedule_not_found" ? 404 : message === "invalid_schedule" ? 400 : 503;
        http.body = { message };
      }
    });
  }
}

/** A schedule change's failure as one of its fixed codes; the manager's own words never pass through. */
export function scheduleErrorCode(cause: unknown, mutating: boolean): "schedule_changed" | "schedule_not_found" | "schedules_unavailable" | "invalid_schedule" {
  const code = cause instanceof Error ? cause.message : "";
  const invalid =
    code === "invalid_schedule" ||
    /^(title must|prompt must|notes must|schedule must|at |cron |invalid cron|invalid delivery|invalid purpose|heartbeat requires)/.test(code) ||
    code.endsWith("cannot change its rule");
  if (code === "schedule_changed" || code === "schedule_not_found" || code === "schedules_unavailable") return code;
  return invalid || !mutating ? "invalid_schedule" : "schedules_unavailable";
}

export function projectRun(run: ScheduleRun): ScheduleRun {
  const code = run.error?.code;
  const error = code && Object.hasOwn(runErrors, code) ? { code, message: runErrors[code] } : undefined;
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    occurrenceAt: run.occurrenceAt,
    recordedAt: run.recordedAt,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    turnId: run.turnId,
    status: run.status,
    purpose: run.purpose,
    delivery: run.delivery,
    notified: run.notified,
    ...(error ? { error } : {}),
  };
}

export function validatePatch(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_schedule");
  const patch = value as Record<string, unknown>;
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !["title", "prompt", "notes", "purpose", "delivery", "kind", "at", "cron"].includes(key)))
    throw new Error("invalid_schedule");
  // Notes may be cleared with an empty string.
  if ("notes" in patch && (typeof patch.notes !== "string" || patch.notes.length > 2000)) throw new Error("invalid_schedule");
  for (const [key, limit] of [
    ["title", 120],
    ["prompt", 2000],
    ["at", 40],
    ["cron", 200],
  ] as const) {
    if (key in patch && (typeof patch[key] !== "string" || !patch[key].trim() || patch[key].length > limit)) throw new Error("invalid_schedule");
  }
  if ("purpose" in patch && patch.purpose !== "task" && patch.purpose !== "heartbeat") throw new Error("invalid_schedule");
  if ("delivery" in patch && patch.delivery !== "channel" && patch.delivery !== "silent") throw new Error("invalid_schedule");
  if ("kind" in patch || "at" in patch || "cron" in patch) {
    if (
      !(patch.kind === "once" && typeof patch.at === "string" && !("cron" in patch)) &&
      !(patch.kind === "cron" && typeof patch.cron === "string" && !("at" in patch))
    )
      throw new Error("invalid_schedule");
  }
  return patch;
}

export function projectTask(row: ScheduledTask): ScheduledTask {
  return {
    id: row.id,
    revision: row.revision,
    title: row.title,
    prompt: row.prompt,
    notes: row.notes ?? null,
    platform: row.platform,
    selfId: row.selfId,
    channelId: row.channelId,
    type: row.type,
    kind: row.kind,
    at: row.at ?? null,
    cron: row.cron ?? null,
    state: row.state,
    purpose: row.purpose ?? "task",
    delivery: row.delivery ?? "channel",
    nextRunAt: row.nextRunAt,
    ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}),
    ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    // Raw provider errors and future private table fields are not part of the UI response.
    lastResult: row.lastResult
      ? { occurrenceAt: row.lastResult.occurrenceAt, status: row.lastResult.status, finishedAt: row.lastResult.finishedAt, notified: row.lastResult.notified }
      : null,
  };
}
