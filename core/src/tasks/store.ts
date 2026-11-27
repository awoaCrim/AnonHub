import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { newId, readJson, systemClock, writeFileAtomic, type Clock } from "@yesimbot/foundation";

import { TASK_ERRORS, taskError } from "./errors.js";
import { TASK_MINUTES } from "./limits.js";
import { isTaskSource, type TaskSource } from "./source.js";

export type TaskKind = "computer" | "content" | "service";

export type TaskStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface TaskHandoff {
  id: string;
  state: "pending" | "resolved" | "cancelled";
  instruction: string;
  deviceId?: string;
  requestedAt: number;
  resolvedAt?: number;
}

export interface TaskRecord {
  id: string;
  key: string;
  channel: string;
  session: string;
  kind: TaskKind;
  instruction: string;
  /** Pinned canonical model reference. Absent on records created before model selection existed. */
  modelRef?: string;
  /**
   * Minutes after which the main conversation hears that a run is still going, chosen by it at delegation; absent on
   * older records. The task is never stopped for it (user, 2026-11-20: 「超时/步数超了仅提醒主bot…不强制结束」).
   */
  timeLimitMinutes?: number;
  /** When the running run is next reported as overtime; set when a run starts, moved by each notice and extension. */
  deadlineAt?: number;
  /** Captured by task_create; never accepted as a tool argument. */
  source?: TaskSource;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  progress?: string;
  handoff?: TaskHandoff;
  result?: string;
  /** Host-confirmed internal pause; this does not request human control of a device. */
  pauseReason?: "context_budget";
  artifacts?: string[];
  notification?: "pending" | "claimed" | "delivered" | "unknown" | "obsolete";
  /** Carries on unfinished work: created in the turn that received that task's result (`depth` counts the chain). */
  continues?: { taskId: string; depth: number };
  /** A budget-paused task whose remaining work a later task took over; it no longer waits for anything. */
  continuedBy?: string;
  /**
   * When the owner archived this finished task: the console no longer lists it, task_status still does
   * (user, 2026-11-26: 「后台任务，允许归档，归档后webui上看不到了，但是bot仍然可以通过命令查询」).
   */
  archivedAt?: number;
}

/** One instance-owned journal. Serialize every mutation; publish only after the atomic write. */
export class TaskStore {
  /** Tasks this load found cut off by a process loss (running or queued before), for their result to say how far they got. */
  readonly interrupted: string[] = [];
  private records = new Map<string, TaskRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  private loaded?: Promise<void>;
  private closed = false;
  constructor(
    private readonly directory: string,
    private readonly clock: Clock = systemClock(),
  ) {}
  load(): Promise<void> {
    return (this.loaded ??= (async () => {
      const rows = await readJson(join(this.directory, "tasks.json"), { parse: (value) => value as TaskRecord[] });
      if (!rows) return;
      if (
        !Array.isArray(rows) ||
        rows.some((row) => !row || !/^[a-f0-9-]{36}$/.test(row.id) || typeof row.channel !== "string" || typeof row.instruction !== "string")
      )
        throw taskError(TASK_ERRORS.task_store_invalid, { detail: "rows" });
      for (const row of rows) {
        if (row.modelRef !== undefined && (typeof row.modelRef !== "string" || !row.modelRef || row.modelRef.length > 512))
          throw taskError(TASK_ERRORS.task_store_invalid, { detail: "modelRef" });
        if (row.source !== undefined && !isTaskSource(row.source)) throw taskError(TASK_ERRORS.task_store_invalid, { detail: "source" });
        if (
          row.continues !== undefined &&
          (!row.continues ||
            !/^[a-f0-9-]{36}$/.test(row.continues.taskId) ||
            !Number.isSafeInteger(row.continues.depth) ||
            row.continues.depth < 1 ||
            row.continues.depth > 100)
        )
          throw taskError(TASK_ERRORS.task_store_invalid, { detail: "continuation" });
        if (row.continuedBy !== undefined && (typeof row.continuedBy !== "string" || !/^[a-f0-9-]{36}$/.test(row.continuedBy)))
          throw taskError(TASK_ERRORS.task_store_invalid, { detail: "continuation" });
        if (row.pauseReason !== undefined && row.pauseReason !== "context_budget") throw taskError(TASK_ERRORS.task_store_invalid, { detail: "pauseReason" });
        if (row.archivedAt !== undefined && !Number.isSafeInteger(row.archivedAt)) throw taskError(TASK_ERRORS.task_store_invalid, { detail: "archivedAt" });
        if (!withinBudget(row.timeLimitMinutes, TASK_MINUTES) || (row.deadlineAt !== undefined && !Number.isSafeInteger(row.deadlineAt)))
          throw taskError(TASK_ERRORS.task_store_invalid, { detail: "timeLimitMinutes" });
        const h = row.handoff;
        if (
          h &&
          (!/^[a-f0-9-]{36}$/.test(h.id) ||
            !["pending", "resolved", "cancelled"].includes(h.state) ||
            typeof h.instruction !== "string" ||
            !h.instruction.trim() ||
            h.instruction.length > 2000 ||
            !Number.isFinite(h.requestedAt) ||
            (h.deviceId !== undefined && !/^[a-f0-9-]{36}$/.test(h.deviceId)))
        )
          throw taskError(TASK_ERRORS.task_store_invalid, { detail: "handoff" });
      }
      this.records = new Map(rows.map((row) => [row.id, row]));
      for (const record of this.records.values()) {
        // Never replay operations automatically after a process loss. The main conversation is told instead and checks
        // what happened itself (user, 2026-11-20: 「任何任务都不在需要我核实，让主bot核实就行了」); a task that was
        // still running had not handed anything over yet, so this is its only result.
        if (["running", "queued"].includes(record.status)) {
          this.interrupted.push(record.id);
          record.status = "unknown";
          record.result = "进程中断，执行结果需要核实；未自动重新执行。";
          record.notification ??= "pending";
        }
        if (record.notification === "claimed") record.notification = "unknown";
      }
      await this.persist(this.records);
    })());
  }
  async list(channel?: string): Promise<TaskRecord[]> {
    await this.load();
    await this.tail;
    return [...this.records.values()]
      .filter((row) => !channel || row.channel === channel)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => structuredClone(row));
  }
  async get(id: string): Promise<TaskRecord | undefined> {
    await this.load();
    await this.tail;
    const row = this.records.get(id);
    return row && structuredClone(row);
  }
  async findByKey(channel: string, key: string): Promise<TaskRecord | undefined> {
    await this.load();
    await this.tail;
    const row = [...this.records.values()].find((record) => record.channel === channel && record.key === key);
    return row && structuredClone(row);
  }
  async create(
    input: Pick<TaskRecord, "key" | "channel" | "session" | "kind" | "instruction"> &
      Pick<Partial<TaskRecord>, "source" | "modelRef" | "continues" | "timeLimitMinutes">,
  ): Promise<{ record: TaskRecord; created: boolean }> {
    await this.load();
    return this.mutate((rows) => {
      const existing = [...rows.values()].find((row) => row.channel === input.channel && row.key === input.key);
      if (existing) return { record: structuredClone(existing), created: false };
      if ([...rows.values()].filter((row) => !terminalTask(row.status)).length >= 64) throw taskError(TASK_ERRORS.task_queue_full);
      const record: TaskRecord = { ...input, id: newId(), status: "queued", createdAt: this.clock.now(), updatedAt: this.clock.now() };
      rows.set(record.id, record);
      return { record: structuredClone(record), created: true };
    });
  }
  async update(id: string, change: (record: TaskRecord) => void): Promise<TaskRecord> {
    await this.load();
    return this.mutate((rows) => {
      const row = rows.get(id);
      if (!row) throw taskError(TASK_ERRORS.task_not_found);
      change(row);
      // A task that starts again is no longer archived: the console shows it while it runs.
      if (!finishedTask(row)) delete row.archivedAt;
      row.updatedAt = this.clock.now();
      return structuredClone(row);
    });
  }
  /**
   * Archives these finished tasks, or brings them back, in one write; a task still open, already in that state or
   * unknown is left as it is. Returns the IDs it changed.
   */
  async archive(ids: readonly string[], archived: boolean): Promise<string[]> {
    await this.load();
    return this.mutate((rows) => {
      const changed: string[] = [];
      for (const id of new Set(ids)) {
        const row = rows.get(id);
        if (!row || !finishedTask(row) || !!row.archivedAt === archived) continue;
        if (archived) row.archivedAt = this.clock.now();
        else delete row.archivedAt;
        changed.push(id);
      }
      return changed;
    });
  }
  /** Waits for every write already queued; any later mutation is refused, so nothing touches the directory afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
  private mutate<T>(change: (rows: Map<string, TaskRecord>) => T): Promise<T> {
    if (this.closed) return Promise.reject(taskError(TASK_ERRORS.task_service_stopping));
    const operation = this.tail.then(async () => {
      const draft = new Map([...this.records].map(([id, row]) => [id, structuredClone(row)]));
      const result = change(draft);
      await this.persist(draft);
      this.records = draft;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async persist(rows: Map<string, TaskRecord>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(this.directory, "tasks.json"), JSON.stringify([...rows.values()]) + "\n");
  }
}

export const terminalTask = (status: TaskStatus) => ["succeeded", "failed", "cancelled", "unknown"].includes(status);

/** Nothing more will happen: it ended, or a later task carries on its work. */
export const finishedTask = (row: Pick<TaskRecord, "status" | "continuedBy">) => terminalTask(row.status) || row.continuedBy !== undefined;

/** An optional whole number within the bounds. */
export function withinBudget(value: unknown, bounds: { readonly min: number; readonly max: number }): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max);
}
