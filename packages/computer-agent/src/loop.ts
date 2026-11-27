import type { ComputerDriver, ComputerUseRunnerResult } from "@yesimbot/computer-driver";
import { generateText, wrapLanguageModel, type LanguageModel, type ModelMessage } from "ai";

import { CONFIRMATION_TOOL, createDesktopTools } from "./desktop-tools.js";

const MAX_RESPONSE_TEXT = 4_000;
const MAX_CALLS_PER_STEP = 8;
const MAX_REPLAY_STEPS = 4;
const OMITTED_SCREENSHOT_TEXT = "Earlier screenshots were omitted to keep this request bounded; use the latest screenshot as ground truth.";

export interface ComputerUseLoopOptions {
  readonly prompt: string;
  readonly model: Exclude<LanguageModel, string>;
  readonly driver: ComputerDriver;
  readonly signal: AbortSignal;
  readonly displayWidth: number;
  readonly displayHeight: number;
}

class TooManyActions extends Error {}

/**
 * The sub-model loop of `computer_use`: it sees a screenshot, calls desktop tools, and every tool result brings the
 * next screenshot back. There is no step limit; the caller's signal ends a task that runs too long.
 */
export async function runComputerUse(options: ComputerUseLoopOptions): Promise<ComputerUseRunnerResult> {
  let screenshot = await options.driver.execute([], options.signal);
  let failure: { readonly cause: unknown } | undefined;
  let confirmation: { id: string; reason?: string } | undefined;

  const tools = createDesktopTools({
    driver: options.driver,
    signal: options.signal,
    displayWidth: options.displayWidth,
    displayHeight: options.displayHeight,
    onScreenshot: (next) => {
      screenshot = next;
    },
    onFailure: (cause) => {
      failure ??= { cause };
    },
  });

  const model = wrapLanguageModel({
    // The registry hands out v3 models.
    model: options.model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        const calls = result.content.filter((part) => part.type === "tool-call");
        if (calls.length > MAX_CALLS_PER_STEP) throw new TooManyActions();
        const asked = calls.find((call) => call.toolName === CONFIRMATION_TOOL);
        if (!asked) return result;
        confirmation = { id: asked.toolCallId, reason: confirmationReason(asked.input) };
        // A confirmation request means nothing else of this step runs.
        return { ...result, content: result.content.filter((part) => part.type !== "tool-call" || part === asked) };
      },
    },
  });

  const start = screenshot;
  let generated;
  try {
    generated = await generateText({
      model,
      tools,
      maxRetries: 0,
      abortSignal: options.signal,
      stopWhen: () => failure !== undefined,
      prepareStep: ({ messages }) => ({ messages: boundedHistory(messages) }),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: options.prompt },
            { type: "image", image: start.bytes, mediaType: start.mediaType },
          ],
        },
      ],
    });
  } catch (cause) {
    if (cause instanceof TooManyActions) {
      return {
        result: {
          ok: false,
          error: { code: "invalid_response", message: "The computer model requested too many actions in one step.", retryable: false },
          steps: 0,
        },
        screenshot,
      };
    }
    throw cause;
  }
  if (failure) throw failure.cause;

  const steps = generated.steps.length;
  if (confirmation) {
    return {
      result: {
        ok: false,
        error: {
          code: "safety_check_required",
          message: "The computer model asked for confirmation before a consequential action. No action was executed.",
          retryable: false,
        },
        steps,
        safetyChecks: [{ id: confirmation.id.slice(0, 128), code: "confirmation_requested", ...(confirmation.reason ? { message: confirmation.reason } : {}) }],
      },
      screenshot,
    };
  }
  const status = generated.finishReason === "length" ? "incomplete" : "completed";
  const summary = generated.text.trim().slice(0, MAX_RESPONSE_TEXT);
  return {
    result: {
      ok: true,
      status,
      summary: summary || (status === "incomplete" ? "Computer task stopped before completion." : "Computer task completed."),
      steps,
    },
    screenshot,
  };
}

function confirmationReason(input: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    const reason = typeof parsed === "object" && parsed !== null ? (parsed as { reason?: unknown }).reason : undefined;
    return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 512) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each request replays the task message and the last few steps, with only the newest screenshot in them. A step is
 * an assistant message with its tool results, so a call never loses its result.
 */
function boundedHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  const [task, ...steps] = messages;
  const kept = steps.slice(-MAX_REPLAY_STEPS * 2);
  const history = [task!, ...kept];
  const latest = history.length === 1 ? 0 : history.map((message) => message.role).lastIndexOf("tool");
  return history.map((message, index) => (index === latest ? message : withoutImages(message)));
}

function withoutImages(message: ModelMessage): ModelMessage {
  if (message.role === "user" && Array.isArray(message.content)) {
    if (!message.content.some((part) => part.type === "image")) return message;
    return { ...message, content: [...message.content.filter((part) => part.type !== "image"), { type: "text", text: OMITTED_SCREENSHOT_TEXT }] };
  }
  if (message.role !== "tool") return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "tool-result" || part.output.type !== "content") return part;
      if (!part.output.value.some((item) => item.type === "image-data")) return part;
      return {
        ...part,
        output: {
          ...part.output,
          value: [...part.output.value.filter((item) => item.type !== "image-data"), { type: "text" as const, text: OMITTED_SCREENSHOT_TEXT }],
        },
      };
    }),
  };
}
