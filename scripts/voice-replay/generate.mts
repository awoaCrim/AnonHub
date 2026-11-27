/**
 * Send captured replay requests to real models through the production provider adapters.
 *
 * The request JSON is the provider-neutral call recorded by capture.mts, so every model sees the
 * same Core-built prompt and tools. Only the first model step is taken: a send_message call is
 * scored, anything else is recorded as its action.
 *
 * Env: REPLAY_GOOGLE_KEY, REPLAY_ANTHROPIC_KEY, REPLAY_GATEWAY (e.g. http://127.0.0.1:18334)
 * Usage:
 *   node --import tsx scripts/voice-replay/generate.mts \
 *     <work-dir> <variant> <gemini|glm> [--runs 2]
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";

import { ModelService } from "../../core/src/models/index.js";
import { createAnthropicProvider, type Config as AnthropicConfig } from "../../providers/model-provider/src/anthropic.js";
import { createGoogleProvider, type Config as GoogleConfig } from "../../providers/model-provider/src/google.js";

const TARGETS = {
  gemini: { projection: "gemini-native", fullId: "antigravity-gemini:gemini-3.8-flash-high" },
  glm: { projection: "default", fullId: "uwoacrimson-anthropic:wbcn/glm-5.3-flash" },
} as const;

interface Lifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface Result {
  readonly action: string;
  readonly inputTokens?: number;
  readonly texts?: readonly string[];
  readonly error?: string;
  readonly toolCalls?: readonly { name: string; input: string }[];
}

async function connect(work: string): Promise<ModelService> {
  const gateway = process.env.REPLAY_GATEWAY ?? "http://127.0.0.1:18334";
  const service = new ModelService({ baseDir: process.cwd(), emit: () => {} }, { basePath: work, logLevel: 0 });
  // A host normally drives the lifecycle hooks; the script calls them directly.
  await (service as unknown as Lifecycle).start();
  // Same connection entries as the owner instance; glm is the candidate added for this comparison.
  service.register(
    createGoogleProvider({
      id: "antigravity-gemini",
      apiKey: process.env.REPLAY_GOOGLE_KEY ?? "",
      baseURL: `${gateway}/v1beta`,
      chatModels: [{ id: "gemini-3.8-flash-high", toolCall: true, reasoning: true, thinkingLevel: "high" }],
    } as unknown as GoogleConfig),
  );
  service.register(
    createAnthropicProvider({
      id: "uwoacrimson-anthropic",
      apiKey: process.env.REPLAY_ANTHROPIC_KEY ?? "",
      baseURL: `${gateway}/v1`,
      chatModels: [{ id: "wbcn/glm-5.3-flash", toolCall: true, reasoning: false }],
    } as unknown as AnthropicConfig),
  );
  return service;
}

async function once(model: LanguageModelV3, request: LanguageModelV3CallOptions): Promise<Result> {
  const response = await model.doGenerate({ ...request, abortSignal: AbortSignal.timeout(Number(process.env.REPLAY_TIMEOUT_MS ?? 600_000)) });
  const inputTokens = response.usage.inputTokens.total;
  const usage = inputTokens === undefined ? {} : { inputTokens };
  const calls = response.content.filter((part) => part.type === "tool-call");
  const toolCalls = calls.map((call) => ({ name: call.toolName, input: call.input }));
  const call = calls[0];
  if (!call) return { action: "text-only", ...usage, texts: response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) };
  if (call.toolName !== "send_message") return { action: `tool:${call.toolName}`, ...usage, toolCalls };
  const input = JSON.parse(call.input) as { parts?: Array<{ kind?: string; text?: string }> };
  const texts = (Array.isArray(input.parts) ? input.parts : []).flatMap((part) =>
    part?.kind === "text" && typeof part.text === "string" && part.text ? [part.text] : [],
  );
  return { action: texts.length ? "send" : "send-without-readable-text", ...usage, texts, toolCalls };
}

async function main(): Promise<void> {
  const [workArg, variant, modelName, ...flags] = process.argv.slice(2);
  if (!workArg || !variant || !(modelName in TARGETS)) {
    console.error("usage: generate.mts <work-dir> <variant> <gemini|glm> [--runs 2]");
    process.exit(2);
  }
  const target = TARGETS[modelName as keyof typeof TARGETS];
  const runsFlag = flags.indexOf("--runs");
  const runs = runsFlag >= 0 ? Number(flags[runsFlag + 1]) : 2;
  const work = resolve(workArg);
  const service = await connect(work);
  const model = service.resolveChatModel(target.fullId).model as LanguageModelV3;
  const requestDir = join(work, "requests", variant, target.projection);
  const outDir = join(work, "outputs", variant, modelName);
  await mkdir(outDir, { recursive: true });

  const only = process.env.REPLAY_CASES?.split(",").filter(Boolean);
  const files = (await readdir(requestDir)).filter((name) => name.endsWith(".json")).sort();
  const queue = files.filter((name) => !only || only.includes(name.replace(/\.json$/, "")));
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const id = name.replace(/\.json$/, "");
      const request = JSON.parse(await readFile(join(requestDir, name), "utf8")) as LanguageModelV3CallOptions;
      for (let run = 1; run <= runs; run++) {
        const output = join(outDir, `${id}.r${run}.json`);
        // Resumable: finished runs are kept so a restarted batch only pays for missing ones.
        if (
          await readFile(output, "utf8").then(
            (text) => (JSON.parse(text) as Result).action !== "error",
            () => false,
          )
        )
          continue;
        let result: Result;
        try {
          result = await once(model, request);
        } catch (error) {
          result = { action: "error", error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
        }
        await writeFile(output, JSON.stringify(result, null, 2));
        console.log(`${variant}/${modelName}/${id}.r${run}: ${result.action}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.REPLAY_CONCURRENCY ?? 4) }, worker));
  await (service as unknown as Lifecycle).stop();
}

await main();
process.exit(0);
