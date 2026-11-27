import type { AgentPlugin } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";

import { rejectedTaskReportDraft } from "./failure.js";
import { readOnlyCommand } from "./shell-command.js";
import { LiveSteps } from "./steps.js";

/** The same call made this often is pointed out (preview records: one screenshot taken 12 times in a task). */
const REPEATED_CALLS = 3;
/** Calls listed for a task that ends without a report. */
const RECENT_CALLS = 8;
/** Changes (commands that are not read-only, file writes) listed with any result. */
const RECENT_CHANGES = 12;
/** Workspace tools that write files. */
const FILE_WRITES = new Set(["writeFile", "editFile"]);
/** Input fields that say what a call did without carrying what was typed or sent. */
const DETAIL_FIELDS = ["action", "tool", "ref", "url", "command", "path", "jobId", "id"] as const;
/** A secret given as a command option (`--password x`, `--token=x`), beyond what the report redaction catches. */
const SECRET_OPTION = /(--?(?:password|passwd|pass|token|secret|api[-_]?key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;

/** One tool call as a task that ended without a report lists it. */
type WorkerCall = { tool: string; detail: string; outcome: string };

/**
 * What a background task did, kept so that a task ending without an accepted report (out of steps, model failure)
 * still tells the main conversation how far it got.
 */
export class WorkerActivity {
  /** The worker's latest words, for a run that ends without an accepted report (redacted when listed). */
  lastWords?: string;
  /** Its calls under way, which the console shows before the transcript has them. */
  readonly live = new LiveSteps();
  private total = 0;
  private readonly counts = new Map<string, number>();
  private readonly recent: WorkerCall[] = [];
  private changeTotal = 0;
  private readonly recentChanges: WorkerCall[] = [];

  readonly plugin: AgentPlugin = {
    name: "core.task-activity",
    afterToolCall: (call) => {
      if (call.toolName === "task_report") return;
      this.total++;
      this.counts.set(call.toolName, (this.counts.get(call.toolName) ?? 0) + 1);
      const entry = { tool: call.toolName, detail: callDetail(call.args), outcome: callOutcome(call.result, call.isError) };
      this.recent.push(entry);
      if (this.recent.length > RECENT_CALLS) this.recent.shift();
      if (!changes(call.toolName, call.args)) return;
      this.changeTotal++;
      this.recentChanges.push(entry);
      if (this.recentChanges.length > RECENT_CHANGES) this.recentChanges.shift();
    },
  };

  /**
   * The commands and file writes that may have changed something, for the main conversation to check a report
   * against (preview task 29e33d79, 2026-11-20: its report left out half of what it changed in ~/.ssh/config).
   */
  changes(): string {
    if (!this.changeTotal) return "";
    const shown = this.recentChanges.length < this.changeTotal ? `，最近 ${this.recentChanges.length} 项` : "";
    const lines = this.recentChanges.map((call) => `- ${call.tool}${call.detail ? ` ${call.detail}` : ""} → ${call.outcome}`).join("\n");
    return rejectedTaskReportDraft(`\n执行过的改动（不是只读的命令和文件写入，共 ${this.changeTotal} 项${shown}）：\n${lines}`);
  }

  /**
   * The end of a failed task's result: what to check, and what the task did before it stopped. `unknownEffect`: a call
   * whose outcome is unknown, which may never have reached this plugin.
   */
  summary(unknownEffect = false): string {
    if (!this.total) return unknownEffect ? "已执行的操作不会自动重跑；请先核实已完成的操作和工具结果。" : "代理还没有执行任何工具操作，可以直接重新委派。";
    const counts = [...this.counts].map(([tool, count]) => `${tool} ×${count}`).join("、");
    const recent = this.recent.map((call, index) => `${index + 1}. ${call.tool}${call.detail ? ` ${call.detail}` : ""} → ${call.outcome}`).join("\n");
    return (
      rejectedTaskReportDraft(
        `已执行的操作不会自动重跑；请先核实已完成的操作和工具结果。\n停止前代理一共调用了 ${this.total} 次工具（${counts}），最后 ${this.recent.length} 次：\n${recent}`,
      ) + this.changes()
    );
  }

  /** What a running task has done so far, for the main conversation's overtime notice. */
  progress(): string {
    if (!this.total) return "它还没有调用任何工具。";
    const counts = [...this.counts].map(([tool, count]) => `${tool} ×${count}`).join("、");
    const recent = this.recent.map((call, index) => `${index + 1}. ${call.tool}${call.detail ? ` ${call.detail}` : ""} → ${call.outcome}`).join("\n");
    return rejectedTaskReportDraft(`它到现在一共调用了 ${this.total} 次工具（${counts}），最近 ${this.recent.length} 次：\n${recent}`) + this.changes();
  }
}

/**
 * What a task cut off by a process loss had done, read back from its transcript (JSONL agent entries): every tool call
 * with its result, a call still running when the process ended, and its latest words. The live record of it went with
 * the process (the bot's own account, 2026-11-20: 「后台中断时只知道"挂了"，不知道挂在哪」).
 */
export function transcriptActivity(transcript: string): WorkerActivity {
  const activity = new WorkerActivity();
  const pending = new Map<string, { toolName: string; args: unknown }>();
  const done = (toolName: string, args: unknown, result: unknown, isError: boolean) =>
    activity.plugin.afterToolCall?.({ toolName, args, result, isError } as never, undefined as never);
  for (const line of transcript.split("\n")) {
    let entry: { type?: unknown; data?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || !Array.isArray(entry.data?.content)) continue;
    for (const part of entry.data.content as Record<string, unknown>[]) {
      if (entry.data.role === "assistant" && part.type === "text" && typeof part.text === "string" && part.text.trim()) activity.lastWords = part.text.trim();
      if (entry.data.role === "assistant" && part.type === "tool-call" && typeof part.toolCallId === "string")
        pending.set(part.toolCallId, { toolName: String(part.toolName), args: part.input });
      if (entry.data.role !== "tool" || part.type !== "tool-result" || typeof part.toolCallId !== "string") continue;
      const call = pending.get(part.toolCallId);
      if (!call) continue;
      pending.delete(part.toolCallId);
      const output = (part.output ?? {}) as { type?: unknown; value?: unknown };
      done(call.toolName, call.args, output.value, typeof output.type === "string" && output.type.startsWith("error"));
    }
  }
  for (const call of pending.values()) done(call.toolName, call.args, { status: "未完成", code: "进程中断时还在执行" }, false);
  return activity;
}

/**
 * Points out, in the request only (nothing is stored), that a background task keeps making the very same call. Steps
 * and time never stop a task, so nothing here asks it to wrap up: the main conversation hears about a task past its
 * time limit and decides (user, 2026-11-20: 「超时/步数超了仅提醒主bot（主bot可以结束/延长/steer等），不强制结束」).
 */
export function workerRepeatGuard(): AgentPlugin {
  return {
    name: "core.task-repeat-guard",
    prepareStep(messages) {
      const repeated = repeatedCall(messages);
      if (!repeated) return undefined;
      return [
        ...messages,
        {
          role: "user",
          content: `（执行提示，不是新的要求）你已经 ${repeated.count} 次用完全相同的参数调用 ${repeated.tool}，结果都一样。同样的调用不会带来新信息：换一种做法；确实卡住了就调用 task_report，写清卡在哪里。`,
        },
      ];
    },
  };
}

/**
 * The latest tool call, when earlier calls with the same input also got the same result often enough to point out.
 * Polling a job or waiting gets new output or a new duration each time, so it is not a repetition; images are compared
 * by their place only, so the same screenshot of an unchanged page is.
 */
function repeatedCall(messages: readonly ModelMessage[]): { tool: string; count: number } | undefined {
  const calls: { id: string; tool: string; key: string }[] = [];
  const results = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    if (message.role === "assistant")
      for (const part of message.content)
        if (part.type === "tool-call") calls.push({ id: part.toolCallId, tool: part.toolName, key: `${part.toolName}\0${stable(part.input)}` });
    if (message.role === "tool") for (const part of message.content) if (part.type === "tool-result") results.set(part.toolCallId, resultText(part.output));
  }
  const last = calls.at(-1);
  if (!last || last.tool === "task_report" || !results.has(last.id)) return undefined;
  const outcome = results.get(last.id);
  const count = calls.filter((call) => call.key === last.key && results.get(call.id) === outcome).length;
  return count >= REPEATED_CALLS ? { tool: last.tool, count } : undefined;
}

function resultText(output: unknown): string {
  if (!output || typeof output !== "object") return stable(output);
  const { type, value } = output as { type?: unknown; value?: unknown };
  if (type !== "content" || !Array.isArray(value)) return stable(value);
  return value.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : stable((part as { type?: unknown })?.type))).join("\n");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function changes(tool: string, args: unknown): boolean {
  if (FILE_WRITES.has(tool)) return true;
  if (tool !== "computer_exec" || !args || typeof args !== "object") return false;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" && !readOnlyCommand(command);
}

function callDetail(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const input = args as Record<string, unknown>;
  return DETAIL_FIELDS.filter((field) => typeof input[field] === "string" || typeof input[field] === "number")
    .map(
      (field) =>
        `${field}=${clip(field === "command" ? String(input[field]).replace(SECRET_OPTION, "$1[redacted]") : String(input[field]), field === "command" ? 80 : 60)}`,
    )
    .join(" ");
}

function callOutcome(result: unknown, isError: boolean): string {
  if (isError) return "出错";
  if (!result || typeof result !== "object") return "完成";
  const value = result as Record<string, unknown>;
  const error = value.error;
  if (typeof value.status === "string" && value.status !== "succeeded") return `${value.status}${typeof value.code === "string" ? ` ${value.code}` : ""}`;
  if (value.ok === false)
    return `失败${error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? ` ${(error as { code: string }).code}` : ""}`;
  if (typeof error === "string") return `错误 ${clip(error, 40)}`;
  const output = value.output && typeof value.output === "object" ? (value.output as Record<string, unknown>) : {};
  if (output.timedOut === true) return "超时停止";
  if (typeof output.exitCode === "number" && output.exitCode !== 0) return `退出码 ${output.exitCode}`;
  return "完成";
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
