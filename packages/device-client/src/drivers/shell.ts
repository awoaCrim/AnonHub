import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { uuid, workspaceOwnerKey, type DeviceInvocation, type OperationResult } from "@yesimbot/contracts";
import { type Clock, newId, systemClock } from "@yesimbot/foundation";
import { z } from "zod/v4";

import { DEADLINE_REASON, type DeviceDriver } from "../driver.js";
import { prepareConversationWorkspace } from "./files.js";

/** At most this many background jobs run at once on a computer; finished ones are kept for reading. */
export const SHELL_JOB_RUNNING_LIMIT = 4;

/** A background job is stopped after this long, so a forgotten `tail -f` does not run forever. */
export const SHELL_JOB_MAX_LIFETIME_MS = 4 * 60 * 60_000;

/** Each foreground stream keeps its first and its latest bytes; a long output loses its middle, never the process. */
const STREAM_HEAD_BYTES = 128 * 1024;
const STREAM_TAIL_BYTES = 256 * 1024;
/** A job's combined output: its first bytes and a rolling window of the latest. */
const JOB_HEAD_BYTES = 64 * 1024;
const JOB_TAIL_BYTES = 2 * 1024 * 1024;
const JOB_READ_BYTES = 16 * 1024;
const JOB_READ_MAX_BYTES = 64 * 1024;
const JOB_WAIT_MAX_MS = 120_000;
/** `start` waits this long so a command that fails at once (not found, syntax) reports it directly. */
const JOB_START_WAIT_MS = 1_000;
const JOB_RETAINED_LIMIT = 16;
const STOP_GRACE_MS = 3_000;
/** After the shell exits, output still in the pipes gets this long; a grandchild holding them open is not waited for. */
const DRAIN_GRACE_MS = 1_000;

const commandField = z
  .string()
  .min(1)
  .max(65536)
  .refine((s) => !s.includes("\0"));
const cwdField = z
  .string()
  .max(4096)
  .refine((s) => !s.includes("\0") && isAbsolute(s))
  .optional();
const execSchema = z
  .object({
    command: commandField,
    cwd: cwdField,
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    /** Sent only by servers that know `shell-jobs`: past the timeout the command keeps running as a job. */
    continueAfterTimeout: z.boolean().optional(),
  })
  .strict();
const startSchema = z.object({ command: commandField, cwd: cwdField }).strict();
const jobSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("read"),
      id: uuid,
      waitMs: z.number().int().min(0).max(JOB_WAIT_MAX_MS).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(JOB_READ_MAX_BYTES).optional(),
    })
    .strict(),
  z.object({ action: z.literal("stop"), id: uuid }).strict(),
  z.object({ action: z.literal("list") }).strict(),
]);

type StopReason = "timeout" | "cancelled" | "stopped" | "max_lifetime" | "shutdown";

type Exit = { code: number | null; signal: NodeJS.Signals | null; failedToStart: boolean };

interface ShellJob {
  readonly id: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
  readonly process: ShellProcess;
  /** Combined-output offset up to which the bot has been shown the output. */
  cursor: number;
  lifetime?: ReturnType<typeof setTimeout>;
}

/**
 * Runs commands on the explicitly paired computer. No SSH credentials or owner-machine defaults.
 *
 * `exec` runs one foreground command at a time and reports how it ended: exit code, signal, or `timedOut` when it
 * was stopped at its timeout (it may have partly taken effect). With `continueAfterTimeout` a command still running
 * at the timeout is not stopped: it becomes a background job. `start` runs a command as a job at once; `job` reads,
 * waits for and stops the jobs of the calling conversation. Jobs live with this client and end when it stops.
 */
export class LocalShellDriver implements DeviceDriver {
  readonly capability = "computer.shell" as const;
  private foreground = false;
  private readonly jobs = new Map<string, ShellJob>();
  private readonly processes = new Set<ShellProcess>();
  private stopped = false;

  readonly methods: DeviceDriver["methods"] = {
    exec: { contexts: ["direct", "group"], execute: (invocation, signal) => this.exec(invocation, signal) },
    start: { contexts: ["direct", "group"], grant: "exec", execute: (invocation, signal) => this.start(invocation, signal) },
    job: { contexts: ["direct", "group"], grant: "exec", execute: (invocation, signal) => this.job(invocation, signal) },
  };

  constructor(
    private readonly workspaceRoot: string,
    private readonly conversationDirectory = false,
    private readonly clock: Clock = systemClock(),
  ) {}

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.processes].map((running) => running.kill("shutdown")));
    for (const job of this.jobs.values()) clearTimeout(job.lifetime);
  }

  private async exec(invocation: DeviceInvocation, signal: AbortSignal): Promise<OperationResult> {
    const parsed = execSchema.safeParse(invocation.input);
    if (!parsed.success) return { status: "rejected", code: "invalid_shell_input" };
    if (this.stopped || this.foreground || signal.aborted) return { status: "rejected", code: "shell_unavailable" };
    this.foreground = true;
    try {
      const input = parsed.data;
      const cwd = await this.workingDirectory(input.cwd, invocation);
      if (this.stopped || signal.aborted) return { status: "rejected", code: "shell_unavailable" };
      const running = this.spawn(input.command, cwd);
      const outcome = await settle(running, Math.min(input.timeoutMs ?? 60_000, Math.max(1, invocation.expiresAt - this.clock.now())), signal);
      const background = outcome === "timeout" && input.continueAfterTimeout === true && !this.stopped;
      if (background && this.runningJobs() < SHELL_JOB_RUNNING_LIMIT) {
        const job = this.adopt(running, invocation, input.command, cwd, running.combined.total);
        return { status: "succeeded", output: { running: true, jobId: job.id, ...streams(running), cwd, durationMs: running.durationMs() } };
      }
      if (outcome !== "exited") await running.kill(outcome);
      const exit = running.result;
      // Still alive after SIGKILL (uninterruptible I/O): whether it goes on to change anything is unknown.
      if (!exit) return { status: "unknown", code: "shell_kill_unconfirmed" };
      if (exit.failedToStart) return { status: "failed", code: "shell_start_failed" };
      return {
        status: "succeeded",
        output: {
          exitCode: exit.code,
          ...(exit.signal ? { signal: exit.signal } : {}),
          ...(running.stopReason === "timeout" ? { timedOut: true } : running.stopReason ? { stopped: running.stopReason } : {}),
          ...(background ? { backgroundUnavailable: "shell_jobs_busy" } : {}),
          ...streams(running),
          cwd,
          durationMs: running.durationMs(),
        },
      };
    } finally {
      this.foreground = false;
    }
  }

  private async start(invocation: DeviceInvocation, signal: AbortSignal): Promise<OperationResult> {
    const parsed = startSchema.safeParse(invocation.input);
    if (!parsed.success) return { status: "rejected", code: "invalid_shell_input" };
    if (this.stopped || signal.aborted) return { status: "rejected", code: "shell_unavailable" };
    if (this.runningJobs() >= SHELL_JOB_RUNNING_LIMIT) return { status: "rejected", code: "shell_jobs_busy" };
    const cwd = await this.workingDirectory(parsed.data.cwd, invocation);
    // Checked again after the await: another start may have taken the last slot meanwhile.
    if (this.stopped || signal.aborted) return { status: "rejected", code: "shell_unavailable" };
    if (this.runningJobs() >= SHELL_JOB_RUNNING_LIMIT) return { status: "rejected", code: "shell_jobs_busy" };
    const running = this.spawn(parsed.data.command, cwd);
    const job = this.adopt(running, invocation, parsed.data.command, cwd, 0);
    await Promise.race([running.exit, delay(JOB_START_WAIT_MS), aborted(signal)]);
    if (running.result?.failedToStart) {
      this.jobs.delete(job.id);
      return { status: "failed", code: "shell_start_failed" };
    }
    return { status: "succeeded", output: view(job, readNew(job, JOB_READ_BYTES)) };
  }

  private async job(invocation: DeviceInvocation, signal: AbortSignal): Promise<OperationResult> {
    const parsed = jobSchema.safeParse(invocation.input);
    if (!parsed.success) return { status: "rejected", code: "invalid_shell_input" };
    const input = parsed.data;
    const scope = scopeOf(invocation);
    if (input.action === "list")
      return { status: "succeeded", output: { jobs: [...this.jobs.values()].filter((job) => job.scope === scope).map((job) => summary(job)) } };
    const job = this.jobs.get(input.id);
    // Another conversation's job does not exist for this one.
    if (!job || job.scope !== scope) return { status: "rejected", code: "shell_job_not_found" };
    if (input.action === "stop") {
      await job.process.stop("stopped");
      return { status: "succeeded", output: view(job, readNew(job, JOB_READ_BYTES)) };
    }
    if (input.waitMs && job.process.running) await Promise.race([job.process.exit, delay(input.waitMs), aborted(signal)]);
    const limit = input.limit ?? JOB_READ_BYTES;
    return { status: "succeeded", output: view(job, input.offset === undefined ? readNew(job, limit) : readRange(job, input.offset, limit)) };
  }

  private spawn(command: string, cwd: string): ShellProcess {
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args =
      process.platform === "win32"
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]
        : ["-c", command];
    const running = new ShellProcess(
      this.clock,
      spawn(shell, args, {
        cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    this.processes.add(running);
    void running.exit.then(() => this.processes.delete(running));
    return running;
  }

  private adopt(running: ShellProcess, invocation: DeviceInvocation, command: string, cwd: string, cursor: number): ShellJob {
    const job: ShellJob = { id: newId(), scope: scopeOf(invocation), command, cwd, process: running, cursor };
    job.lifetime = setTimeout(() => void running.stop("max_lifetime"), Math.max(1, SHELL_JOB_MAX_LIFETIME_MS - running.durationMs()));
    job.lifetime.unref();
    void running.exit.then(() => {
      clearTimeout(job.lifetime);
      this.prune();
    });
    this.jobs.set(job.id, job);
    this.prune();
    return job;
  }

  /** Forgets the oldest finished jobs beyond the retention limit; running jobs are never forgotten. */
  private prune(): void {
    const finished = [...this.jobs.values()].filter((job) => !job.process.running).sort((a, b) => a.process.startedAt - b.process.startedAt);
    for (const job of finished.slice(0, Math.max(0, this.jobs.size - JOB_RETAINED_LIMIT))) this.jobs.delete(job.id);
  }

  private runningJobs(): number {
    return [...this.jobs.values()].filter((job) => job.process.running).length;
  }

  private async workingDirectory(cwd: string | undefined, invocation: DeviceInvocation): Promise<string> {
    return cwd ?? (this.conversationDirectory ? await prepareConversationWorkspace(this.workspaceRoot, invocation.conversation) : this.workspaceRoot);
  }
}

/**
 * Keeps the first bytes of an output and a rolling window of the latest, with absolute offsets. Bytes between the
 * two are dropped and counted; the process keeps running.
 */
class OutputLog {
  total = 0;
  private head = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private tailBytes = 0;

  constructor(
    private readonly headLimit: number,
    private readonly tailLimit: number,
  ) {}

  append(data: Buffer): void {
    this.total += data.length;
    if (this.head.length < this.headLimit) {
      const take = Math.min(data.length, this.headLimit - this.head.length);
      this.head = Buffer.concat([this.head, data.subarray(0, take)]);
      data = data.subarray(take);
    }
    if (!data.length) return;
    this.chunks.push(data);
    this.tailBytes += data.length;
    while (this.chunks.length > 1 && this.tailBytes - this.chunks[0]!.length >= this.tailLimit) this.tailBytes -= this.chunks.shift()!.length;
  }

  /** Retained bytes of [from, to); `missing` counts the bytes of that range that were dropped. */
  read(from: number, to = this.total): { bytes: Buffer; missing: number } {
    from = Math.min(Math.max(0, from), this.total);
    to = Math.min(Math.max(from, to), this.total);
    const tailStart = this.total - this.tailBytes;
    const parts: Buffer[] = [];
    if (from < this.head.length) parts.push(this.head.subarray(from, Math.min(to, this.head.length)));
    const missing = Math.max(0, Math.min(to, tailStart) - Math.max(from, this.head.length));
    const tailFrom = Math.max(from, tailStart);
    if (to > tailFrom) parts.push(Buffer.concat(this.chunks).subarray(tailFrom - tailStart, to - tailStart));
    return { bytes: Buffer.concat(parts), missing };
  }

  /** The whole retained output as text, marking where the middle was dropped. */
  text(): { text: string; omitted: number } {
    const { bytes, missing } = this.read(0);
    if (!missing) return { text: bytes.toString("utf8"), omitted: 0 };
    return { text: `${this.head.toString("utf8")}\n[… ${missing} bytes omitted …]\n${Buffer.concat(this.chunks).toString("utf8")}`, omitted: missing };
  }
}

/** One shell process and everything it printed; it ends on the shell's exit plus a short drain, not on pipe close. */
class ShellProcess {
  readonly stdout = new OutputLog(STREAM_HEAD_BYTES, STREAM_TAIL_BYTES);
  readonly stderr = new OutputLog(STREAM_HEAD_BYTES, STREAM_TAIL_BYTES);
  readonly combined = new OutputLog(JOB_HEAD_BYTES, JOB_TAIL_BYTES);
  readonly startedAt: number;
  readonly exit: Promise<Exit>;
  endedAt?: number;
  result?: Exit;
  stopReason?: StopReason;

  constructor(
    private readonly clock: Clock,
    readonly child: ChildProcess,
  ) {
    this.startedAt = clock.now();
    const capture = (target: OutputLog) => (data: Buffer) => {
      target.append(data);
      this.combined.append(data);
    };
    child.stdout?.on("data", capture(this.stdout));
    child.stderr?.on("data", capture(this.stderr));
    this.exit = new Promise<Exit>((resolve) => {
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const finish = (result: Exit) => {
        if (this.result) return;
        this.result = result;
        this.endedAt = this.clock.now();
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(result);
      };
      child.on("error", () => {
        if (child.pid === undefined) finish({ code: null, signal: null, failedToStart: true });
      });
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        setTimeout(() => finish({ ...exited!, failedToStart: false }), DRAIN_GRACE_MS).unref();
      });
      child.on("close", (code, signal) => finish({ ...(exited ?? { code, signal }), failedToStart: false }));
    });
  }

  get running(): boolean {
    return !this.result;
  }

  durationMs(): number {
    return (this.endedAt ?? this.clock.now()) - this.startedAt;
  }

  /** Kills the whole process tree and waits briefly for it to end. */
  async kill(reason: StopReason): Promise<void> {
    if (!this.running) return;
    this.stopReason ??= reason;
    killTree(this.child);
    await Promise.race([this.exit, delay(5_000)]);
  }

  /** Asks the tree to end (SIGTERM), then kills what is left after a grace period. */
  async stop(reason: StopReason): Promise<void> {
    if (!this.running) return;
    this.stopReason ??= reason;
    if (process.platform !== "win32") {
      signalTree(this.child, "SIGTERM");
      if (await Promise.race([this.exit.then(() => true), delay(STOP_GRACE_MS).then(() => false)])) return;
    }
    await this.kill(reason);
  }
}

function scopeOf(invocation: DeviceInvocation): string {
  return workspaceOwnerKey({ kind: "conversation", conversation: invocation.conversation });
}

function streams(running: ShellProcess) {
  const stdout = running.stdout.text(),
    stderr = running.stderr.text();
  return { stdout: stdout.text, stderr: stderr.text, truncated: stdout.omitted + stderr.omitted > 0 };
}

/** Output the bot has not seen yet; when there is more than `limit`, the latest part. The cursor moves to the end. */
function readNew(job: ShellJob, limit: number) {
  const to = job.process.combined.total;
  const from = Math.max(job.cursor, to - limit);
  const range = readRange(job, from, limit);
  const skipped = from - Math.min(job.cursor, to);
  job.cursor = to;
  return { ...range, omittedBytes: range.omittedBytes + skipped };
}

function readRange(job: ShellJob, offset: number, limit: number) {
  const from = Math.min(offset, job.process.combined.total);
  const to = Math.min(from + limit, job.process.combined.total);
  const { bytes, missing } = job.process.combined.read(from, to);
  return { output: bytes.toString("utf8"), from, to, omittedBytes: missing };
}

function summary(job: ShellJob) {
  const running = job.process;
  return {
    jobId: job.id,
    state: running.running ? "running" : running.stopReason ? "stopped" : "exited",
    command: job.command.length > 200 ? `${job.command.slice(0, 200)}…` : job.command,
    cwd: job.cwd,
    ...(running.result ? { exitCode: running.result.code, ...(running.result.signal ? { signal: running.result.signal } : {}) } : {}),
    ...(running.stopReason ? { stopReason: running.stopReason } : {}),
    startedAt: new Date(running.startedAt).toISOString(),
    durationMs: running.durationMs(),
    totalBytes: running.combined.total,
  };
}

function view(job: ShellJob, range: { output: string; from: number; to: number; omittedBytes: number }) {
  return { ...summary(job), output: range.output, outputFrom: range.from, outputTo: range.to, omittedBytes: range.omittedBytes };
}

/** How waiting for a foreground command ended. A passed invocation deadline counts as its timeout. */
function settle(running: ShellProcess, timeoutMs: number, signal: AbortSignal): Promise<"exited" | "timeout" | "cancelled"> {
  if (!running.running) return Promise.resolve("exited");
  return new Promise((resolve) => {
    const settleWith = (outcome: "exited" | "timeout" | "cancelled") => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => settleWith(signal.reason === DEADLINE_REASON ? "timeout" : "cancelled");
    const timer = setTimeout(() => settleWith("timeout"), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    void running.exit.then(() => settleWith("exited"));
    if (signal.aborted) onAbort();
  });
}

function delay(ms: number): Promise<void> {
  return wait(ms, undefined, { ref: false });
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else signalTree(child, "SIGKILL");
}
