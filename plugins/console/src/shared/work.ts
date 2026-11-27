/**
 * One step of the bot's work as the console shows it: a tool call with what it asked for and what came back, cut down
 * for display (Core's `WorkStep`). Background tasks list theirs in order
 * (user, 2026-11-20: 「我需要可以点开查看具体的命令和对应的输出」「至少我得知道，执行了哪些命令，正在执行什么命令吧？」).
 */
export interface WorkStep {
  /** The tool call ID. */
  id: string;
  tool: string;
  input: unknown;
  /** `unknown`: recorded without a result (the run stopped while it ran). */
  status: "running" | "ok" | "failed" | "unknown";
  output?: unknown;
  at?: number;
}

/** `GET /yesimbot/api/v1/tasks/steps?id&from`: the steps from `from` on, of `total`. */
export interface TaskStepsResponse {
  steps: WorkStep[];
  total: number;
}
