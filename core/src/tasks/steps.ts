import { open } from "node:fs/promises";

import { systemClock, type Clock } from "@yesimbot/foundation";

import { operationFailed } from "../computer-activity.js";

/** Longer strings keep their start and end: the end of a command's output usually says how it went. */
const CLIP_FROM = 4500;
const CLIP_HEAD = 1500;
const CLIP_TAIL = 2500;
/** What one read takes of a transcript's growth; the rest comes with the next read. */
const READ_BYTES = 32 * 1024 * 1024;

/**
 * One tool call of an agent for people to read: what it asked for and what came back (user, 2026-11-20: 「我点开这个后台任务
 * 不就是为了看进度吗？至少我得知道，执行了哪些命令，正在执行什么命令吧？」). Values are cut down by `workValue`.
 */
export interface WorkStep {
  /** The tool call ID. */
  id: string;
  tool: string;
  input: unknown;
  /** `unknown`: written without a result (the run stopped while it ran). */
  status: "running" | "ok" | "failed" | "unknown";
  output?: unknown;
  /** When it started (calls under way) or when its step was written. */
  at?: number;
}

/**
 * A transcript's tool calls as it grows: each read parses only the lines appended since the last one (the agent's JSONL
 * storage only appends). A call is written together with its result when its step ends.
 */
export class TranscriptSteps {
  private offset = 0;
  private steps: WorkStep[] = [];
  private byId = new Map<string, WorkStep>();

  constructor(private readonly path: string) {}

  async read(): Promise<readonly WorkStep[]> {
    const handle = await open(this.path, "r").catch(() => undefined);
    if (!handle) return this.steps;
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.steps = [];
        this.byId = new Map();
      }
      const length = Math.min(size - this.offset, READ_BYTES);
      if (length <= 0) return this.steps;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      // A line longer than a whole read is skipped rather than read forever.
      if (end < 0) {
        if (bytesRead === READ_BYTES) this.offset += bytesRead;
        return this.steps;
      }
      this.offset += end + 1;
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) this.add(line);
      return this.steps;
    } finally {
      await handle.close();
    }
  }

  private add(line: string) {
    let entry: { type?: unknown; data?: { role?: unknown; content?: unknown; timestamp?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry?.type !== "message" || !Array.isArray(entry.data?.content)) return;
    const { role, timestamp } = entry.data;
    for (const part of entry.data.content as Record<string, unknown>[]) {
      if (typeof part?.toolCallId !== "string") continue;
      if (role === "assistant" && part.type === "tool-call" && !this.byId.has(part.toolCallId)) {
        const step: WorkStep = {
          id: part.toolCallId,
          tool: String(part.toolName),
          input: workValue(part.input ?? part.args),
          status: "unknown",
          ...(typeof timestamp === "number" ? { at: timestamp } : {}),
        };
        this.byId.set(step.id, step);
        this.steps.push(step);
      }
      const step = this.byId.get(part.toolCallId);
      if (role !== "tool" || part.type !== "tool-result" || !step) continue;
      const result = toolResult(part.output ?? part.result);
      step.output = result.output;
      step.status = result.failed ? "failed" : "ok";
    }
  }
}

/** The calls of the step under way: the transcript gets them only when the step ends. */
export class LiveSteps {
  private readonly calls = new Map<string, WorkStep>();

  public constructor(private readonly clock: Clock = systemClock()) {}

  started(id: string, tool: string, input: unknown, at = this.clock.now()) {
    this.calls.set(id, { id, tool, input: workValue(input), status: "running", at });
  }

  ended(id: string, output: unknown, failed: boolean) {
    const step = this.calls.get(id);
    if (!step) return;
    step.output = workValue(output);
    step.status = failed ? "failed" : "ok";
  }

  /** The step was written to the transcript, which now holds its finished calls. */
  written() {
    for (const [id, step] of this.calls) if (step.status !== "running") this.calls.delete(id);
  }

  list(): WorkStep[] {
    return [...this.calls.values()].map((step) => ({ ...step }));
  }
}

/** Written steps in order, then the calls under way that the transcript does not have yet. */
export function mergeSteps(written: readonly WorkStep[], live: readonly WorkStep[]): WorkStep[] {
  const liveById = new Map(live.map((step) => [step.id, step]));
  const known = new Set(written.map((step) => step.id));
  return [
    ...written.map((step) => (step.status === "unknown" ? liveById.get(step.id) : undefined) ?? { ...step }),
    ...live.filter((step) => !known.has(step.id)),
  ];
}

/** A value cut down for display: long strings keep their start and end; binary content and deep nesting are left out. */
export function workValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (/^data:[\w.+-]+\/[\w.+-]+;base64,/.test(value) || (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value))) return "[图片或二进制内容，未显示]";
    return value.length > CLIP_FROM
      ? `${value.slice(0, CLIP_HEAD)}\n…（中间省略 ${value.length - CLIP_HEAD - CLIP_TAIL} 字）…\n${value.slice(-CLIP_TAIL)}`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => workValue(item, depth + 1));
    return value.length > 50 ? [...items, `…（还有 ${value.length - 50} 项）`] : items;
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, item]) => [key, workValue(item, depth + 1)]),
  );
}

/** A tool result as written: AI SDK outputs wrap the value (`{type: "json", value}`), and error types mean it failed. */
export function toolResult(output: unknown): { output: unknown; failed: boolean } {
  const wrapped =
    output && typeof output === "object" && !Array.isArray(output) ? (output as { type?: unknown; value?: unknown; reason?: unknown }) : undefined;
  if (wrapped?.type === "execution-denied") return { output: workValue(wrapped.reason ?? "没有执行"), failed: true };
  if (typeof wrapped?.type !== "string" || !("value" in wrapped)) return { output: workValue(output), failed: operationFailed(output) };
  return { output: workValue(wrapped.value), failed: wrapped.type.startsWith("error") || operationFailed(wrapped.value) };
}
