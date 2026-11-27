import { classifyModelError, withModelRequestContext } from "@yesimbot/agent-runtime";
import { AppError, httpFetch, newId, type BoundedResponse, type Clock } from "@yesimbot/foundation";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod/v4";

import { imageProbeChallenge } from "./model-probe-image.js";
import type { ModelProbeRequest, ModelProbeResult } from "./model-settings-types.js";
import type { ModelCapability, ModelCapabilityCheck, ModelCapabilityProbeRequest, ModelCapabilityProbeResult } from "./model-settings-types.js";

/** Defaults of the AI SDK clients used by the model provider when no base URL is configured. */
const DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

const MAX_BYTES = 1024 * 1024;

const MAX_MODELS = 500;

const TIMEOUT_MS = 8_000;

export interface ProbeTarget {
  type: string;
  baseURL: string;
  apiKey: string;
}

/**
 * Lists the models a provider offers, to validate an address/key and to fill model pickers.
 * Only fixed error codes leave this function: upstream bodies may echo credentials or internals.
 */
export async function probeModels(target: ProbeTarget, fetcher: typeof httpFetch = httpFetch): Promise<ModelProbeResult> {
  const base = (target.baseURL.trim() || DEFAULT_BASE[target.type] || "").replace(/\/+$/, "");
  if (!DEFAULT_BASE[target.type] || !/^https?:\/\//i.test(base)) return { ok: false, models: [], error: "invalid_request" };
  const headers: Record<string, string> = { accept: "application/json" };
  if (target.type === "anthropic") Object.assign(headers, { "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" });
  else if (target.type === "google") headers["x-goog-api-key"] = target.apiKey;
  else headers.authorization = `Bearer ${target.apiKey}`;
  let url: URL;
  try {
    url = new URL(`${base}/models`);
  } catch {
    return { ok: false, models: [], error: "invalid_request" };
  }
  if (target.type === "google") url.searchParams.set("pageSize", "1000");
  if (target.type === "anthropic") url.searchParams.set("limit", "1000");

  let response: BoundedResponse;
  try {
    // A redirect could carry the credential to another host.
    response = await fetcher(url, { purpose: "model", headers, maxRedirects: 0, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
  } catch (error) {
    const timedOut = (error as Error)?.name === "TimeoutError" || (error instanceof AppError && error.code === "network_timeout");
    return { ok: false, models: [], error: timedOut ? "timeout" : "network" };
  }
  if (response.status === 401 || response.status === 403) return discard(response, "unauthorized");
  if (response.status === 404) return discard(response, "not_found");
  if (!response.ok) return discard(response, "bad_response");
  const body = await readLimited(response);
  if (body === undefined) return { ok: false, models: [], error: "bad_response" };
  const models = modelIds(body, target.type);
  return models ? { ok: true, models } : { ok: false, models: [], error: "bad_response" };
}

export function probeRequest(value: unknown): ModelProbeRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const string = (field: unknown, limit: number) => typeof field === "string" && field.length <= limit;
  if (!string(input.type, 32) || !string(input.baseURL, 2048)) return undefined;
  if (input.apiKey !== undefined && !string(input.apiKey, 8192)) return undefined;
  if (input.key !== undefined && !string(input.key, 64)) return undefined;
  return {
    type: input.type as string,
    baseURL: input.baseURL as string,
    ...(input.apiKey ? { apiKey: input.apiKey as string } : {}),
    ...(input.key ? { key: input.key as string } : {}),
  };
}

export function capabilityProbeRequest(value: unknown): ModelCapabilityProbeRequest | undefined {
  if (!value || typeof value !== "object") return;
  const input = value as Record<string, unknown>;
  if (
    typeof input.key !== "string" ||
    !/^connection:\d+$/.test(input.key) ||
    input.key.length > 64 ||
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 256 ||
    !Array.isArray(input.capabilities) ||
    input.capabilities.length < 1 ||
    input.capabilities.length > 3 ||
    !input.capabilities.every((value) => value === "text" || value === "tool" || value === "image")
  )
    return;
  return { key: input.key, model: input.model, capabilities: [...new Set(input.capabilities)] as ModelCapability[] };
}

/** Small live checks on the exact registered provider/config path. They never run user tools or
 * change configured capability flags. A failure is a failed check, not proof of non-support. */
export async function probeModelCapabilities(
  model: LanguageModel,
  capabilities: ModelCapability[],
  sessionId: string | undefined,
  clock: Clock,
): Promise<ModelCapabilityProbeResult> {
  const checks: ModelCapabilityCheck[] = [];
  for (const capability of capabilities) {
    const started = clock.now(),
      requestIds: string[] = [];
    const signal = AbortSignal.timeout(20_000);
    const call = (options: {
      messages: ModelMessage[];
      tools?: Parameters<typeof generateText>[0]["tools"];
      toolChoice?: Parameters<typeof generateText>[0]["toolChoice"];
    }) => {
      const requestId = newId();
      requestIds.push(requestId);
      return withModelRequestContext({ requestId, ...(sessionId ? { sessionId } : {}) }, () =>
        generateText({
          model,
          ...options,
          maxRetries: 0,
          maxOutputTokens: 1024,
          abortSignal: signal,
        }),
      );
    };
    try {
      let ok = false,
        reasoningObserved = false;
      if (capability === "text") {
        const proof = `YESIMBOT_${newId().replaceAll("-", "")}`;
        const result = await call({ messages: [{ role: "user", content: `Reply with exactly this text and nothing else: ${proof}` }] });
        ok = result.text.trim() === proof;
        reasoningObserved = result.reasoning.length > 0;
      } else if (capability === "tool") {
        const messages: ModelMessage[] = [
          { role: "user", content: "Call yesimbot_probe once, then reply with exactly the proof string from its result and nothing else." },
        ];
        const tools = {
          yesimbot_probe: {
            description: "Returns the proof for this isolated capability check. No external effects.",
            inputSchema: z.strictObject({}),
          },
        };
        const first = await call({ messages, tools, toolChoice: { type: "tool", toolName: "yesimbot_probe" } });
        reasoningObserved = first.reasoning.length > 0;
        const invocation = first.toolCalls[0];
        if (
          first.toolCalls.length === 1 &&
          invocation?.toolName === "yesimbot_probe" &&
          invocation.input &&
          typeof invocation.input === "object" &&
          !Array.isArray(invocation.input) &&
          Object.keys(invocation.input).length === 0 &&
          !("invalid" in invocation && invocation.invalid)
        ) {
          const proof = newId();
          const second = await call({
            messages: [
              ...messages,
              ...first.response.messages,
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: invocation.toolCallId,
                    toolName: invocation.toolName,
                    output: { type: "json", value: { proof } },
                  },
                ],
              },
            ],
            tools,
            toolChoice: "none",
          });
          ok = second.text.trim() === proof && second.toolCalls.length === 0;
          reasoningObserved ||= second.reasoning.length > 0;
        }
      } else {
        const challenge = imageProbeChallenge();
        const result = await call({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Read the six digits in this image. Reply with exactly those six digits and nothing else." },
                { type: "image", image: challenge.image, mediaType: "image/png" },
              ],
            },
          ],
        });
        ok = result.text.trim() === challenge.answer;
        reasoningObserved = result.reasoning.length > 0;
      }
      checks.push({ capability, ok, ...(ok ? {} : { error: "invalid_result" as const }), elapsedMs: clock.now() - started, requestIds, reasoningObserved });
    } catch (error) {
      const failure = signal.aborted ? "timeout" : classifyModelError(error).kind;
      checks.push({ capability, ok: false, error: failure, elapsedMs: clock.now() - started, requestIds });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

async function discard(response: Pick<BoundedResponse, "body">, error: NonNullable<ModelProbeResult["error"]>): Promise<ModelProbeResult> {
  await response.body?.cancel().catch(() => {});
  return { ok: false, models: [], error };
}

async function readLimited(response: Pick<BoundedResponse, "body">): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function modelIds(body: unknown, type: string): string[] | undefined {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const list = type === "google" ? record.models : record.data;
  if (!Array.isArray(list)) return undefined;
  const ids = list
    .map((item) => {
      const value = item && typeof item === "object" ? (item as Record<string, unknown>)[type === "google" ? "name" : "id"] : undefined;
      return typeof value === "string" ? value.replace(/^models\//, "").trim() : "";
    })
    .filter((id) => id && id.length <= 256);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_MODELS);
}
