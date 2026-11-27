import type { AgentMessage, AgentPlugin } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";

import { shortenToolResults } from "../tasks/request-budget.js";

/** From this many tool calls in one turn, the request reminds the main agent that long work belongs in a background task. */
export const LONG_TURN_TOOL_CALLS = 10;

/** The latest tool results of a turn, which its next steps build on, stay whole. */
const KEPT_TOOL_RESULTS = 10;

/** Calls that deliver or end a turn; they are not the work a turn piles up. */
const REPLY_TOOLS = new Set(["send_message", "finish"]);

export interface LongTurnPlugin extends AgentPlugin {
  /** The provider's input tokens for a step of the turn. */
  observe(turnId: string, inputTokens: number | undefined): void;
}

/**
 * Keeps one long turn from filling the context: history summaries never touch the current turn, so a turn that runs
 * dozens of commands grew to 500k tokens (preview owner, 2026-11-22). Request only; the conversation keeps every result.
 *
 * - Once the turn's actual input reaches `trigger` (the context-summary trigger), its tool results older than the
 *   latest 10 and larger than 2 KB become a one-line note. What was shortened only grows, so the start of each request
 *   stays the same for the provider's cache until the next shortening.
 * - From 10 tool calls in the turn, a note at the end suggests handing what is left to a background task. Nothing is
 *   enforced: the main agent keeps every tool (user, 2026-11-22: 「后台不要真正去约束能够使用的工具，靠主agent的提示词去约束就好了」).
 */
export function createLongTurnPlugin(options: { readonly trigger: number; readonly delegation: boolean }): LongTurnPlugin {
  let turn: { id: string; inputTokens: number; shortened: number } | undefined;
  const state = (id: string) => (turn?.id === id ? turn : (turn = { id, inputTokens: 0, shortened: 0 }));
  return {
    name: "core.long-turn",
    enforce: "post",
    observe(turnId, inputTokens) {
      if (inputTokens !== undefined && Number.isSafeInteger(inputTokens) && inputTokens > 0) state(turnId).inputTokens = inputTokens;
    },
    prepareStep(messages, context) {
      const current = state(context.turnId);
      const calls = turnToolCalls(context.messages ?? []);
      if (calls.length === 0) return undefined;
      const ids = new Set(calls.map((call) => call.id));
      if (current.inputTokens >= options.trigger) current.shortened = Math.max(current.shortened, calls.length - KEPT_TOOL_RESULTS);
      let result = shortenToolResults(messages, current.shortened, { include: (part) => ids.has(part.toolCallId), note: shortenedNote });
      if (result !== messages && context.projection)
        result.forEach((message, index) => {
          if (message !== messages[index]) context.projection!.inherit(message, [messages[index]!]);
        });
      const work = calls.filter((call) => !REPLY_TOOLS.has(call.name));
      if (options.delegation && work.length >= LONG_TURN_TOOL_CALLS && !work.some((call) => call.name === "task_create")) {
        const note: ModelMessage = {
          role: "user",
          content: `（执行提示，不是新的要求）这一轮你已经调用了 ${work.length} 次工具。剩下的如果还要多步（继续跑命令、排查、多处核对），用 task_create 交给后台任务，写清已完成的内容、剩余步骤和约束，再把进展告诉对方；只差一两步就自己做完。`,
        };
        context.projection?.register(note, { kind: "mandatory", sourceEntryIds: [] });
        result = [...result, note];
      }
      return result === messages ? undefined : result;
    },
  };
}

/** The tool results this turn produced, oldest first. */
function turnToolCalls(messages: readonly AgentMessage[]): { id: string; name: string }[] {
  const calls: { id: string; name: string }[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) if (part.type === "tool-result") calls.push({ id: part.toolCallId, name: part.toolName });
  }
  return calls;
}

function shortenedNote(part: { toolName: string; output: unknown }, bytes: number): string {
  // A result cut to a preview keeps its archive, which read_tool_output still pages through.
  const outputId = /"outputId":"([^"]+)"/.exec(JSON.stringify(part.output) ?? "")?.[1];
  const archived = outputId ? `完整结果仍可用 read_tool_output（id ${outputId}）读取` : "需要其中的信息就重新查看";
  return `[本轮较早的 ${part.toolName} 结果（约 ${Math.ceil(bytes / 1024)} KB）已从这次请求中省略，对话记录里还在；${archived}]`;
}
