import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

export type ScriptedCall = { readonly name: string; readonly args?: Record<string, unknown>; readonly id?: string };

/** One model step: tool calls, or the final text. */
export type ScriptedStep = readonly ScriptedCall[] | string;

/** A model that plays the given steps in order and records the prompt of every request. */
export function scriptedModel(steps: ScriptedStep[] | ((index: number) => ScriptedStep)) {
  const prompts: LanguageModelV3CallOptions["prompt"][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const index = prompts.push(options.prompt) - 1;
      const step = typeof steps === "function" ? steps(index) : steps[index];
      if (step === undefined) throw new Error("script exhausted");
      if (typeof step === "string") {
        return { content: [{ type: "text", text: step }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      }
      return {
        content: step.map((call, n) => ({
          type: "tool-call" as const,
          toolCallId: call.id ?? `call-${index}-${n}`,
          toolName: call.name,
          input: JSON.stringify(call.args ?? {}),
        })),
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage,
        warnings: [],
      };
    },
  });
  return { model, prompts };
}
