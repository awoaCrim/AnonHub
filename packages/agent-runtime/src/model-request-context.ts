import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { logger, contentHash } from "@yesimbot/foundation";
import type { LanguageModelMiddleware } from "ai";

import { markModelError } from "./model-errors.js";

const requests = new AsyncLocalStorage<ModelRequestContext>();

const usageLog = logger("yesimbot.model-usage");

export interface ModelRetryBudget {
  remaining: number;
}

export interface ModelRequestContext {
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly retryBudget?: ModelRetryBudget;
}

export const currentModelRequestContext = () => requests.getStore();

export function withModelRequestContext<T>(context: ModelRequestContext, run: () => T): T {
  return requests.run({ ...requests.getStore(), ...context }, run);
}

export function consumeModelRetry(): boolean {
  const budget = requests.getStore()?.retryBudget;
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining--;
  return true;
}

/** IDs are correlated without recording account names, channel IDs or operator-supplied labels. */
export const modelDiagnosticId = (value: string) => contentHash(value, { hexLength: 16 });

export function modelDiagnosticContext(context = requests.getStore()) {
  const result: Record<string, string> = {};
  for (const key of ["sessionId", "taskId", "agentId", "turnId"] as const) {
    if (context?.[key]) result[key] = modelDiagnosticId(context[key]);
  }
  if (context?.requestId) result.requestId = context.requestId;
  return result;
}

/** No request data is added to model messages or headers. Each SDK attempt gets a request ID. */
export function modelRequestContextMiddleware(context: ModelRequestContext): LanguageModelMiddleware {
  const scope = () => ({ requestId: requests.getStore()?.requestId ?? randomUUID(), ...context });
  return {
    specificationVersion: "v3",
    wrapGenerate: ({ doGenerate }) =>
      withModelRequestContext(scope(), async () => {
        try {
          return await doGenerate();
        } catch (error) {
          throw markModelError(error, requests.getStore()?.requestId);
        }
      }),
    wrapStream: ({ doStream }) =>
      withModelRequestContext(scope(), async () => {
        const requestId = requests.getStore()?.requestId;
        try {
          const result = await doStream();
          const reader = result.stream.getReader();
          return {
            ...result,
            stream: new ReadableStream({
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (next.done) {
                    reader.releaseLock();
                    controller.close();
                  } else controller.enqueue(next.value.type === "error" ? { ...next.value, error: markModelError(next.value.error, requestId) } : next.value);
                } catch (error) {
                  controller.error(markModelError(error, requestId));
                }
              },
              cancel: (reason) => reader.cancel(reason),
            }),
          };
        } catch (error) {
          throw markModelError(error, requestId);
        }
      }),
  };
}

/** Actual upstream counters, kept separate from serialized-size estimates. */
export function reportModelUsageDiagnostic(usage: unknown, context = requests.getStore()): void {
  if (process.env.YESIMBOT_MODEL_DIAGNOSTICS !== "1" || !usage || typeof usage !== "object") return;
  const raw = usage as Record<string, unknown>;
  const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const total = (value: unknown) => count(value && typeof value === "object" ? (value as Record<string, unknown>).total : value);
  const actualUsage = { inputTokens: total(raw.inputTokens), outputTokens: total(raw.outputTokens) };
  if (Object.values(actualUsage).every((value) => value === undefined)) return;
  try {
    usageLog.info("model_usage.actual", { correlation: modelDiagnosticContext(context), actualUsage });
  } catch {
    /* observation only */
  }
}
