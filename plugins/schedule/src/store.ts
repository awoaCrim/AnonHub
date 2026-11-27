import { platformDefinition, supportsHeartbeat } from "@yesimbot/contracts/platforms";
import { AppError, contentHash, newId, type Clock } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";

import { reject } from "./errors.js";
import { scheduleHostState } from "./host-state.js";
import { activeRun, newRun, retainRuns, runError, runSnapshot, type ScheduleRunReason } from "./run-history.js";
import {
  MAX_ENABLED_SCHEDULES,
  MAX_NOTES_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_TITLE_LENGTH,
  nextRunAt,
  REPLAY_GRACE_MS,
  validateCreate,
  validateRule,
  type ScheduleRule,
  type ScheduleRuleShape,
} from "./time.js";
import type { Schedule, ScheduleCreateInput, ScheduleLastResult, ScheduleRow, ScheduleRunsSnapshot, ScheduleState, ScheduleUpdateInput } from "./types.js";
export type ScheduleScope = ChannelContext & { readonly selfId: string; readonly channelId: string };

/** Equality filter over row columns; `sqliteScheduleTable` turns it into SQL. */
export type ScheduleQuery = Partial<Pick<ScheduleRow, "id" | "type" | "platform" | "selfId" | "channelId" | "state">>;

/** The one table the Store reads and writes; `sqliteScheduleTable` implements it. */
export interface ScheduleTable {
  get(query: ScheduleQuery): Promise<ScheduleRow[]>;
  create(row: ScheduleRow): Promise<void>;
  set(query: ScheduleQuery, patch: Partial<ScheduleRow>): Promise<void>;
  remove(query: ScheduleQuery): Promise<void>;
}

/** What startup repair did to one row, for the scheduler's log. */
export interface ScheduleRecovery {
  id: string;
  title: string;
  occurrenceAt: string;
  status: "missed" | "interrupted" | "replay";
}

/**
 * Single-table, channel-scoped Schedule persistence. Every mutation is
 * serialized through a model-owned promise tail, shared by Store instances
 * across plugin reloads, so management, recovery and older turn callbacks
 * cannot overwrite each other's writes. Reads wait on the same tail.
 */
export class ScheduleStore {
  private readonly mutations: { tail: Promise<void> };

  /** `host` outlives plugin reloads (the database service), so a finishing turn that still holds an older Store shares the write queue. */
  public constructor(
    private readonly table: ScheduleTable,
    private readonly clock: Clock,
    host: object = table,
  ) {
    this.mutations = scheduleHostState(host, "mutations", () => ({ tail: Promise.resolve() }));
  }

  public create(scope: ScheduleScope, input: ScheduleCreateInput): Promise<Schedule> {
    return this.mutate(async () => {
      const now = this.now();
      validateCreate(input, now);
      validatePurpose(input.purpose, scope.platform, scope.type, input.kind);
      await this.assertEnabledCapacity(scope);
      const rule: ScheduleRule = input.kind === "once" ? { kind: "once", at: input.at } : { kind: "cron", cron: input.cron };
      const row: ScheduleRow = {
        id: newId(),
        type: scope.type,
        platform: scope.platform,
        selfId: scope.selfId,
        channelId: scope.channelId,
        userId: scope.type === "direct" ? (directUserId(scope.platform, scope.channelId, scope.userId) ?? null) : null,
        title: input.title,
        prompt: input.prompt,
        notes: null,
        purpose: input.purpose ?? "task",
        delivery: input.delivery ?? "channel",
        kind: rule.kind,
        at: rule.kind === "once" ? rule.at : null,
        cron: rule.kind === "cron" ? rule.cron : null,
        state: "enabled",
        nextRunAt: nextRunAt(rule, now),
        lastResult: null,
        runs: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.table.create(row);
      return toSchedule(row);
    });
  }

  public list(scope: ScheduleScope): Promise<Schedule[]> {
    return this.mutate(async () => {
      const rows = await this.table.get(scopeQuery(scope));
      return rows.map(toSchedule).sort(compareByNextRun);
    });
  }

  public update(scope: ScheduleScope, id: string, input: ScheduleUpdateInput): Promise<Schedule> {
    return this.mutate(async () => this.updateRow(await this.fetchRow(scope, id), input));
  }

  /** Runtime-local administrative API. Never exposed as a cross-channel agent tool. */
  public listAll(): Promise<Array<Schedule & { revision: string }>> {
    return this.mutate(async () =>
      (await this.table.get({})).map((row) => {
        const task = toSchedule(row);
        return { ...task, revision: scheduleRevision(task) };
      }),
    );
  }

  public updateManaged(id: string, revision: string, input: ScheduleUpdateInput): Promise<void> {
    return this.mutate(async () => {
      const row = await this.managedRow(id, revision);
      await this.updateRow(row, input);
    });
  }

  /** Exact conversation-scoped history; a foreign schedule ID never widens that scope. */
  public listRuns(scope: ScheduleScope, id: string, before?: string): Promise<ScheduleRunsSnapshot> {
    return this.mutate(async () => runSnapshot(await this.fetchRow(scope, id), before));
  }

  /** Owner-only, runtime-local management surface, like listAll. */
  public listRunsManaged(id: string, before?: string): Promise<ScheduleRunsSnapshot> {
    return this.mutate(async () => {
      const row = (await this.table.get({ id }))[0];
      if (!row) throw new AppError("schedule_not_found", { effect: "none" });
      return runSnapshot(row, before);
    });
  }

  public deleteManaged(id: string, revision: string): Promise<void> {
    return this.mutate(async () => {
      await this.managedRow(id, revision);
      await this.table.remove({ id });
    });
  }

  private async managedRow(id: string, revision: string): Promise<ScheduleRow> {
    const row = (await this.table.get({ id }))[0];
    if (!row) throw new AppError("schedule_not_found", { effect: "none" });
    if (scheduleRevision(toSchedule(row)) !== revision) throw new AppError("schedule_changed", { effect: "none" });
    return row;
  }

  private async updateRow(row: ScheduleRow, input: ScheduleUpdateInput): Promise<Schedule> {
    const ruleChanged = input.kind !== undefined || input.at !== undefined || input.cron !== undefined;
    if (ruleChanged && (row.state === "cancelled" || row.state === "completed")) {
      throw reject("invalid_schedule_state", `schedule ${row.id} cannot change its rule`);
    }
    const purpose = input.purpose ?? row.purpose ?? "task";
    const title = input.title ?? row.title;
    const prompt = input.prompt ?? row.prompt;
    const delivery = input.delivery ?? row.delivery ?? "channel";
    if (!title.trim()) throw reject("invalid_schedule", "title must not be empty");
    if (!prompt.trim()) throw reject("invalid_schedule", "prompt must not be empty");
    if (delivery !== "channel" && delivery !== "silent") throw reject("invalid_schedule", "invalid delivery");
    if (title.length > MAX_TITLE_LENGTH) {
      throw reject("invalid_schedule", `title must not exceed ${MAX_TITLE_LENGTH} characters`);
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw reject("invalid_schedule", `prompt must not exceed ${MAX_PROMPT_LENGTH} characters`);
    }
    if (input.notes !== undefined && typeof input.notes !== "string") throw reject("invalid_schedule", "notes must be a string");
    if (input.notes !== undefined && input.notes.length > MAX_NOTES_LENGTH) {
      throw reject("invalid_schedule", `notes must not exceed ${MAX_NOTES_LENGTH} characters`);
    }
    const notes = input.notes === undefined ? (row.notes ?? null) : input.notes.trim() ? input.notes.trim() : null;
    const now = this.now();
    let kind: "once" | "cron" = row.kind;
    let at: string | null = row.at;
    let cron: string | null = row.cron;
    let next: string | null = row.nextRunAt;
    if (ruleChanged) {
      const rule: ScheduleRuleShape =
        input.at !== undefined
          ? { kind: input.kind ?? row.kind, at: input.at }
          : input.cron !== undefined
            ? { kind: input.kind ?? row.kind, cron: input.cron }
            : { kind: input.kind ?? row.kind, at: row.at ?? undefined, cron: row.cron ?? undefined };
      validateRule(rule, now);
      kind = rule.kind;
      at = rule.kind === "once" ? rule.at : null;
      cron = rule.kind === "cron" ? rule.cron : null;
      if (row.state === "enabled") next = nextRunAt(rule, now);
    }
    validatePurpose(purpose, row.platform, row.type, kind);
    const updatedAt = this.now().toISOString();
    await this.table.set({ id: row.id }, { purpose, title, prompt, notes, delivery, kind, at, cron, nextRunAt: next, updatedAt });
    return toSchedule({ ...row, purpose, title, prompt, notes, delivery, kind, at, cron, nextRunAt: next, updatedAt });
  }

  public pause(scope: ScheduleScope, id: string): Promise<Schedule> {
    return this.mutate(async () => {
      const row = await this.fetchRow(scope, id);
      if (row.state !== "enabled") throw reject("invalid_schedule_state", `schedule ${id} is not enabled`);
      const updatedAt = this.now().toISOString();
      await this.table.set({ ...scopeQuery(scope), id }, { state: "paused", nextRunAt: null, updatedAt });
      return toSchedule({ ...row, state: "paused", nextRunAt: null, updatedAt });
    });
  }

  public resume(scope: ScheduleScope, id: string): Promise<Schedule> {
    return this.mutate(async () => {
      const row = await this.fetchRow(scope, id);
      if (row.state !== "paused") throw reject("invalid_schedule_state", `schedule ${id} is not paused`);
      await this.assertEnabledCapacity(scope);
      const now = this.now();
      const rule = ruleOfRow(row);
      if (rule.kind === "once" && Date.parse(rule.at) <= now.getTime()) {
        throw reject("invalid_schedule_state", `schedule ${id} has no future occurrence`);
      }
      const next = nextRunAt(rule, now);
      const updatedAt = this.now().toISOString();
      await this.table.set({ ...scopeQuery(scope), id }, { state: "enabled", nextRunAt: next, updatedAt });
      return toSchedule({ ...row, state: "enabled", nextRunAt: next, updatedAt });
    });
  }

  public cancel(scope: ScheduleScope, id: string): Promise<Schedule> {
    return this.mutate(async () => {
      const row = await this.fetchRow(scope, id);
      if (row.state !== "enabled" && row.state !== "paused") {
        throw reject("invalid_schedule_state", `schedule ${id} cannot be cancelled`);
      }
      const updatedAt = this.now().toISOString();
      await this.table.set({ ...scopeQuery(scope), id }, { state: "cancelled", nextRunAt: null, updatedAt });
      return toSchedule({ ...row, state: "cancelled", nextRunAt: null, updatedAt });
    });
  }

  /** Enabled rows across every channel, earliest next run first. */
  public listEnabled(): Promise<Schedule[]> {
    return this.mutate(async () => {
      const rows = await this.table.get({ state: "enabled" });
      return rows.map(toSchedule).sort(compareByNextRun);
    });
  }

  /**
   * Durably claims the due occurrence `occurrenceAt` of `id`: the row must
   * still be enabled with a matching `nextRunAt`. The claim writes the
   * `submitting` latest result and advances the rule before returning the
   * claimed row — a once schedule is completed, a cron schedule moves to its
   * next occurrence. Returns null when the occurrence is not claimable, so
   * duplicate wakes can never claim the same occurrence twice.
   */
  public claim(id: string, occurrenceAt: string): Promise<Schedule | null> {
    return this.mutate(async () => {
      const rows = await this.table.get({ id });
      const row = rows[0];
      if (!row || row.state !== "enabled" || row.nextRunAt !== occurrenceAt) return null;
      const now = this.now();
      const rule = ruleOfRow(row);
      const state: ScheduleState = rule.kind === "once" ? "completed" : "enabled";
      const next = rule.kind === "once" ? null : nextRunAt(rule, now);
      if (row.purpose === "heartbeat" && row.lastResult?.status === "submitting") {
        // Keep the running check's receipt; do not overwrite it or queue another check.
        const skipped = {
          ...newRun(row, occurrenceAt, now.toISOString(), false),
          status: "missed" as const,
          finishedAt: now.toISOString(),
          error: runError("previous_running"),
        };
        await this.table.set({ id }, { nextRunAt: next, runs: retainRuns([...(row.runs ?? []), skipped]) });
        return null;
      }
      const lastResult: ScheduleLastResult = { occurrenceAt, status: "submitting" };
      const updatedAt = now.toISOString();
      const runs = retainRuns([...(row.runs ?? []), newRun(row, occurrenceAt, updatedAt)]);
      await this.table.set({ id }, { state, nextRunAt: next, lastResult, runs, updatedAt });
      return toSchedule({ ...row, state, nextRunAt: next, lastResult, updatedAt });
    });
  }

  /** Core's actual turn.start, never inferred from successful admission or queueing. */
  public started(id: string, occurrenceAt: string, turn: { turnId: string; startedAt: string }): Promise<void> {
    return this.mutate(async () => {
      const row = (await this.table.get({ id }))[0];
      if (!row) return;
      const run = row.runs?.find((run) => run.occurrenceAt === occurrenceAt && activeRun(run));
      if (!run || run.startedAt) return;
      const runs = row.runs!.map((candidate) => (candidate.id === run.id ? { ...candidate, status: "running" as const, ...turn } : candidate));
      await this.table.set({ id }, { runs });
    });
  }

  /**
   * Finalizes the matching in-flight receipt, even if a newer occurrence was
   * claimed meanwhile. The latest summary is updated only for its own
   * occurrence, so a late finish cannot overwrite a newer claim. `status` is
   * the durable outcome of the turn (see
   * `ScheduleLastResult`), or `missed` when no concurrent trigger slot was
   * available.
   */
  public finish(
    id: string,
    occurrenceAt: string,
    status: Exclude<ScheduleLastResult["status"], "submitting">,
    error?: { name: string; message: string },
    notified?: boolean,
    reason?: ScheduleRunReason,
  ): Promise<Schedule | null> {
    return this.mutate(async () => {
      const rows = await this.table.get({ id });
      const row = rows[0];
      if (!row) return null;
      const result = row.lastResult;
      const latest = result?.status === "submitting" && result.occurrenceAt === occurrenceAt;
      const run = row.runs?.find((run) => run.occurrenceAt === occurrenceAt && activeRun(run));
      if (!latest && !run) return null;
      const now = this.now();
      const updatedAt = now.toISOString();
      const lastResult: ScheduleLastResult | null = latest ? { ...result, status, finishedAt: updatedAt } : row.lastResult;
      if (latest && lastResult) {
        if (error !== undefined) lastResult.error = error;
        if (notified !== undefined) lastResult.notified = notified;
      }
      const runs = retainRuns(
        (row.runs ?? []).map((candidate) =>
          candidate.id === run?.id
            ? {
                ...candidate,
                status,
                ...(status !== "accepted" ? { finishedAt: updatedAt } : {}),
                ...(notified !== undefined ? { notified } : {}),
                ...(reason ? { error: runError(reason) } : {}),
              }
            : candidate,
        ),
      );
      // Older overlapping turns keep their own receipt without replacing the latest summary.
      await this.table.set({ id }, { ...(latest ? { lastResult, updatedAt } : {}), runs });
      return toSchedule({ ...row, lastResult, ...(latest ? { updatedAt } : {}) });
    });
  }

  /**
   * Startup repair for every persisted row. In-flight receipts without a
   * live process owner become `interrupted` and are never resubmitted. A
   * schedule-only reload keeps turns still owned by the same Core. Of the
   * occurrences that came due while the bot was down, one
   * at most `REPLAY_GRACE_MS` late stays as the next run, so the scheduler runs
   * it once right after start; older ones become one `missed` result: a once
   * schedule is completed, a cron schedule advances to its first future
   * occurrence.
   */
  public recover(now: Date, isLive: (id: string, occurrenceAt: string) => boolean = () => false): Promise<ScheduleRecovery[]> {
    return this.mutate(async () => {
      const rows = await this.table.get({});
      const nowMs = now.getTime();
      const updatedAt = now.toISOString();
      const repairs: ScheduleRecovery[] = [];
      for (const row of rows) {
        // A plugin reload leaves its admitted turns alive in Core. Only unowned receipts were lost.
        const interrupted = (row.runs ?? []).filter((run) => activeRun(run) && !isLive(row.id, run.occurrenceAt));
        const interruptedIds = new Set(interrupted.map((run) => run.id));
        const recoveredRuns = retainRuns(
          (row.runs ?? []).map((run) =>
            interruptedIds.has(run.id) ? { ...run, status: "interrupted" as const, finishedAt: updatedAt, error: runError("process_interrupted") } : run,
          ),
        );
        const runPatch: Partial<ScheduleRow> = interrupted.length ? { runs: recoveredRuns } : {};
        for (const run of interrupted) {
          repairs.push({ id: row.id, title: row.title, occurrenceAt: run.occurrenceAt, status: "interrupted" });
        }
        const result = row.lastResult;
        const latestLive = result?.status === "submitting" && isLive(row.id, result.occurrenceAt);
        const overdue = row.state === "enabled" && row.nextRunAt !== null && Date.parse(row.nextRunAt) < nowMs;
        // A late occurrence still runs: the one occurrence inside the grace window, if any.
        const replay = overdue ? graceOccurrence(row, nowMs) : undefined;
        if (result?.status === "submitting" && !latestLive) {
          const lastResult: ScheduleLastResult = { ...result, status: "interrupted", finishedAt: updatedAt };
          if (!interrupted.some((run) => run.occurrenceAt === result.occurrenceAt)) {
            repairs.push({ id: row.id, title: row.title, occurrenceAt: result.occurrenceAt, status: "interrupted" });
          }
          if (overdue) {
            await this.table.set({ id: row.id }, { ...runPatch, nextRunAt: replay ?? nextRunAt(ruleOfRow(row), now), lastResult, updatedAt });
            if (replay) repairs.push({ id: row.id, title: row.title, occurrenceAt: replay, status: "replay" });
          } else {
            await this.table.set({ id: row.id }, { ...runPatch, lastResult, updatedAt });
          }
          continue;
        }
        if (!overdue) {
          if (interrupted.length) await this.table.set({ id: row.id }, runPatch);
          continue;
        }
        if (replay) {
          repairs.push({ id: row.id, title: row.title, occurrenceAt: replay, status: "replay" });
          if (replay !== row.nextRunAt) {
            // Earlier occurrences of a cron schedule are skipped; the claim of `replay` records the run.
            repairs.push({ id: row.id, title: row.title, occurrenceAt: row.nextRunAt!, status: "missed" });
            const skipped = {
              ...newRun({ ...row, runs: recoveredRuns }, row.nextRunAt!, updatedAt, false),
              status: "missed" as const,
              finishedAt: updatedAt,
              error: runError("overdue"),
            };
            await this.table.set({ id: row.id }, { nextRunAt: replay, updatedAt, runs: retainRuns([...recoveredRuns, skipped]) });
          } else if (interrupted.length) {
            await this.table.set({ id: row.id }, runPatch);
          }
          continue;
        }
        const lastResult: ScheduleLastResult = latestLive ? result! : { occurrenceAt: row.nextRunAt!, status: "missed", finishedAt: updatedAt };
        const skipped = {
          ...newRun({ ...row, runs: recoveredRuns }, row.nextRunAt!, updatedAt, false),
          status: "missed" as const,
          finishedAt: updatedAt,
          error: runError("overdue"),
        };
        const runs = retainRuns([...recoveredRuns, skipped]);
        repairs.push({ id: row.id, title: row.title, occurrenceAt: row.nextRunAt!, status: "missed" });
        if (row.kind === "once") {
          await this.table.set({ id: row.id }, { state: "completed", nextRunAt: null, lastResult, runs, updatedAt });
        } else {
          await this.table.set({ id: row.id }, { nextRunAt: nextRunAt(ruleOfRow(row), now), lastResult, runs, updatedAt });
        }
      }
      return repairs;
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.tail.then(operation, operation);
    this.mutations.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private now(): Date {
    return new Date(this.clock.now());
  }

  private async assertEnabledCapacity(scope: ScheduleScope): Promise<void> {
    const enabled = await this.table.get({ ...scopeQuery(scope), state: "enabled" });
    if (enabled.length >= MAX_ENABLED_SCHEDULES) {
      throw reject("schedule_limit_reached", `channel already has ${MAX_ENABLED_SCHEDULES} enabled schedules`);
    }
  }

  private async fetchRow(scope: ScheduleScope, id: string): Promise<ScheduleRow> {
    const rows = await this.table.get({ ...scopeQuery(scope), id });
    if (!rows.length) throw reject("schedule_not_found", `schedule ${id} not found`);
    return rows[0];
  }
}

/**
 * The user of a direct schedule, i.e. the live private chat's conversation key. A platform with a direct-chat
 * prefix (OneBot's `private:<user>`) has rows written before the user was stored (and turns that already ran under
 * the channel id) mapped back to that user. Other platforms keep exactly what they stored.
 */
export function directUserId(platform: string, channelId: string, userId?: string | null): string | undefined {
  if (userId && userId !== channelId) return userId;
  const prefix = platformDefinition(platform)?.directChannelPrefix;
  if (prefix && channelId.startsWith(prefix) && channelId.length > prefix.length) return channelId.slice(prefix.length);
  return userId ?? undefined;
}

function scopeQuery(scope: ScheduleScope): ScheduleQuery {
  return { type: scope.type, platform: scope.platform, selfId: scope.selfId, channelId: scope.channelId };
}

/** The occurrence of an overdue row at most `REPLAY_GRACE_MS` before `nowMs`, if there is one. */
function graceOccurrence(row: ScheduleRow, nowMs: number): string | undefined {
  const earliest = nowMs - REPLAY_GRACE_MS;
  if (Date.parse(row.nextRunAt!) >= earliest) return row.nextRunAt!;
  if (row.kind === "once") return undefined;
  // Cron occurrences are at least 15 minutes apart, so the window holds one at most.
  const candidate = nextRunAt(ruleOfRow(row), new Date(earliest - 1));
  return Date.parse(candidate) <= nowMs ? candidate : undefined;
}

function ruleOfRow(row: ScheduleRow): ScheduleRule {
  return row.kind === "once" ? { kind: "once", at: row.at! } : { kind: "cron", cron: row.cron! };
}

function toSchedule(row: ScheduleRow): Schedule {
  const base = {
    id: row.id,
    type: row.type,
    platform: row.platform,
    selfId: row.selfId,
    channelId: row.channelId,
    ...(row.userId ? { userId: row.userId } : {}),
    title: row.title,
    prompt: row.prompt,
    ...(row.notes ? { notes: row.notes } : {}),
    purpose: row.purpose ?? "task",
    delivery: row.delivery ?? "channel",
    state: row.state,
    nextRunAt: row.nextRunAt,
    lastResult: row.lastResult ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return row.kind === "once" ? { ...base, kind: "once", at: row.at! } : { ...base, kind: "cron", cron: row.cron! };
}

function compareByNextRun(a: Schedule, b: Schedule): number {
  if (a.nextRunAt === null && b.nextRunAt === null) return a.id.localeCompare(b.id);
  if (a.nextRunAt === null) return 1;
  if (b.nextRunAt === null) return -1;
  return a.nextRunAt.localeCompare(b.nextRunAt) || a.id.localeCompare(b.id);
}

function scheduleRevision(task: Schedule): string {
  return contentHash(JSON.stringify(task));
}

function validatePurpose(purpose: unknown, platform: string, type: string, kind: string): void {
  if (purpose !== undefined && purpose !== "task" && purpose !== "heartbeat") throw reject("invalid_purpose", "invalid purpose");
  if (purpose !== "heartbeat") return;
  // The code keeps its historical name: journals may already hold it, and it still means "not a heartbeat conversation".
  if (!supportsHeartbeat(platform, type)) {
    throw reject("heartbeat_requires_qq", `${platform}/${type} does not support heartbeats`);
  }
  if (kind !== "cron") throw reject("heartbeat_requires_recurring", "heartbeat needs a cron rule");
}
