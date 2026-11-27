import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { configureLogging, type LogRecord, systemClock } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

// A repeatable image challenge; the image renderer and native request serialization remain real.
vi.mock("node:crypto", async (actual) => ({ ...(await actual<typeof import("node:crypto")>()), randomInt: () => 246810 }));

import { ModelService } from "../../../core/src/models/index.js";
import { createGoogleProvider } from "../../../providers/model-provider/src/google.js";
import { createOpenAIProvider } from "../../../providers/model-provider/src/openai.js";
import { capabilityProbeRequest, probeModelCapabilities } from "../src/model-probe.js";
import type { ModelCapabilityProbeResult } from "../src/model-settings-types.js";
import { installModelSettings } from "../src/model-settings.js";

/** Registers one Google connection, as the model-provider extension does for each. */
const applyGoogle = (ctx: { yesimbot: { model: { register(provider: never): unknown } } }, config: unknown) =>
  ctx.yesimbot.model.register(createGoogleProvider(config as never) as never);
/** Registers one OpenAI connection, as the model-provider extension does for each. */
const applyOpenAI = (ctx: { yesimbot: { model: { register(provider: never): unknown } } }, config: unknown) =>
  ctx.yesimbot.model.register(createOpenAIProvider(config as never) as never);

interface ProbeRequest {
  messages?: ({ role: "tool"; content: string } | { role: "user" | "assistant" | "system"; content: unknown })[];
  input?: ({ type: "function_call_output"; output: string } | { type?: "message" | "function_call" })[];
  contents?: {
    parts: {
      functionResponse?: { response: { content: { proof: string } } };
      functionCall?: { name: string };
      thoughtSignature?: string;
    }[];
  }[];
  generationConfig?: { thinkingConfig: { thinkingLevel: string } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("live model capability checks", () => {
  it.each(["chat", "responses", "google"] as const)(
    "performs text, signed tool roundtrip and image checks through the registered %s provider over HTTP",
    async (format) => {
      const requests: ProbeRequest[] = [];
      const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body: ProbeRequest = JSON.parse(raw);
        requests.push(body);
        const serialized = JSON.stringify(body);
        const image = /(?:image_url|input_image|inlineData)/.test(serialized);
        const proofMatch = serialized.match(/YESIMBOT_[a-f0-9]+/);
        let proof = "";
        if (format === "chat") {
          const result = body.messages!.find((m) => m.role === "tool");
          if (result) proof = JSON.parse(result.content).proof;
        } else if (format === "responses") {
          const result = body.input!.find((m) => m.type === "function_call_output");
          if (result) proof = JSON.parse(result.output).proof;
        } else {
          const result = body.contents!.flatMap((m) => m.parts).find((part) => part.functionResponse);
          if (result) proof = result.functionResponse!.response.content.proof;
        }
        const tool = !image && !proofMatch && !proof;
        const text = image ? "246810" : proof || proofMatch?.[0] || "bad";
        let reply;
        if (format === "chat")
          reply = {
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                finish_reason: tool ? "tool_calls" : "stop",
                message: tool
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [{ id: "probe-call", type: "function", function: { name: "yesimbot_probe", arguments: "{}" } }],
                    }
                  : { role: "assistant", content: text },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          };
        else if (format === "responses")
          reply = {
            id: `response-${requests.length}`,
            created_at: 1,
            model: "fixture",
            status: "completed",
            output: tool
              ? [{ type: "function_call", id: "fc-probe", call_id: "probe-call", name: "yesimbot_probe", arguments: "{}", status: "completed" }]
              : [{ type: "message", id: `message-${requests.length}`, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
            usage: { input_tokens: 3, output_tokens: 2 },
          };
        else
          reply = {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: tool
                    ? [{ functionCall: { id: "probe-call", name: "yesimbot_probe", args: {} }, thoughtSignature: "same-route-signature" }]
                    : [{ text }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
          };
        res.setHeader("content-type", "application/json");
        res.setHeader("x-request-id", `fixture-${requests.length}`);
        res.end(JSON.stringify(reply));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const service = new ModelService({ baseDir: "/", emit: () => {} }, { logLevel: 0 });
      const ready: Function[] = [];
      const context = {
        on: (event: string, cb: Function) => {
          if (event === "ready") ready.push(cb);
        },
        yesimbot: { model: service },
        logger: () => ({ warn() {} }),
      };
      const config = {
        id: "fixture-route",
        apiKey: "fixture-private-key",
        baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${format === "google" ? "v1beta" : "v1"}`,
        format,
        chatModels: [{ id: format === "google" ? "gemini-3-fixture" : "gpt-5", reasoning: true, thinkingLevel: "low" }],
        embeddingModels: [],
      };
      (format === "google" ? applyGoogle : applyOpenAI)(context as never, config as never);
      ready.forEach((cb) => cb());
      const records: LogRecord[] = [];
      configureLogging({ sink: (record) => records.push(record) });
      vi.stubEnv("YESIMBOT_MODEL_DIAGNOSTICS", "1");
      try {
        const ref = service.resolveChatModel(`fixture-route:${config.chatModels[0]!.id}`);
        const result = await probeModelCapabilities(ref.model, ["text", "tool", "image"], "private-test-session", systemClock());
        expect(result.checks.map((check) => ({ capability: check.capability, ok: check.ok, error: check.error }))).toEqual([
          { capability: "text", ok: true },
          { capability: "tool", ok: true },
          { capability: "image", ok: true },
        ]);
        expect(result.ok).toBe(true);
        expect(requests).toHaveLength(4);
        expect(result.checks.map((check) => check.requestIds.length)).toEqual([1, 2, 1]);
        if (format === "google") {
          const paired = requests[2].contents!.flatMap((m) => m.parts).find((part) => part.functionCall);
          expect(paired).toMatchObject({ thoughtSignature: "same-route-signature", functionCall: { name: "yesimbot_probe" } });
          expect(requests[0].generationConfig!.thinkingConfig.thinkingLevel).toBe("low");
        } else expect(JSON.stringify(requests[0])).toContain(format === "chat" ? '"reasoning_effort":"low"' : '"effort":"low"');
        const diagnostics = records.filter((record) => record.scope.startsWith("yesimbot.model-")) as unknown as Array<{
          request?: string;
          correlation?: { requestId?: string };
          actualUsage?: { inputTokens?: number };
        }>;
        expect(diagnostics.some((event) => event.actualUsage?.inputTokens === 3)).toBe(true);
        expect(JSON.stringify(diagnostics)).not.toMatch(/fixture-private-key|private-test-session|YESIMBOT_|same-route-signature/);
        const requestIds = result.checks.flatMap((check) => check.requestIds);
        expect(diagnostics.every((event) => requestIds.includes((event.request ?? event.correlation?.requestId)!))).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
  );

  it("fails a plausible answer when the actual proof, tool roundtrip, or image content is missing", async () => {
    const model = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "fixture",
      supportedUrls: {},
      async doGenerate() {
        return {
          content: [{ type: "text", text: "OK" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        };
      },
    };
    const result = await probeModelCapabilities(model as never, ["text", "tool", "image"], undefined, systemClock());
    expect(result.ok).toBe(false);
    expect(result.checks.every((check) => check.error === "invalid_result")).toBe(true);
  });

  it("validates a bounded saved-model request", () => {
    expect(capabilityProbeRequest({ key: "connection:0", model: "fixture", capabilities: ["text", "tool", "image"] })).toBeDefined();
    for (const value of [
      null,
      { key: "new:0", model: "m", capabilities: ["text"] },
      { key: "connection:0", model: "m", capabilities: ["shell"] },
      { key: "connection:0", model: "", capabilities: ["text"] },
    ])
      expect(capabilityProbeRequest(value)).toBeUndefined();
  });
});

describe("capability route authorization", () => {
  function setup() {
    const routes: Record<string, Function> = {};
    const resolveChatModel = vi.fn(() => ({
      model: {
        specificationVersion: "v3",
        provider: "fixture",
        modelId: "fixture",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("secret upstream key");
        },
      },
    }));
    const ctx = {
      loader: {
        config: {
          plugins: {
            "yesimbot-model-provider:p": { connections: [{ type: "openai", id: "saved", apiKey: "saved-secret", chatModels: [{ id: "m" }] }] },
            "yesimbot:core": {},
          },
        },
        writable: true,
      },
      yesimbot: { model: { resolveChatModel } },
      server: {
        get: (path: string, cb: Function) => {
          routes[path] = cb;
        },
        post: (path: string, cb: Function) => {
          routes[path] = cb;
        },
      },
    };
    const auth = {
      config: { enabled: true },
      requireOwner: (http: { owner: boolean; status: number }) => {
        if (http.owner) return true;
        http.status = 401;
        return false;
      },
      sameOrigin: (http: { same: boolean }) => http.same,
      sessionFromCookie: () => ({ username: "owner" }),
    };
    installModelSettings({ ...ctx, clock: systemClock() } as never, auth as never);
    const call = async (body: unknown, extra = {}) => {
      const http = {
        owner: true,
        same: true,
        status: 200,
        body: undefined as ModelCapabilityProbeResult | undefined,
        request: { body },
        set() {},
        get: (name: string) => (name === "content-type" ? "application/json" : ""),
        ...extra,
      };
      await routes["/yesimbot/model-settings/capability-probe"]!(http);
      return http;
    };
    return { call, resolveChatModel };
  }
  it("requires owner+same-origin and never sends saved credentials to a client-selected destination", async () => {
    const { call, resolveChatModel } = setup();
    const input = { key: "connection:0", model: "m", capabilities: ["text"] };
    expect((await call(input, { owner: false })).status).toBe(401);
    expect((await call(input, { same: false })).status).toBe(403);
    expect(resolveChatModel).not.toHaveBeenCalled();
    expect((await call({ ...input, model: "unsaved" })).body!.error).toBe("not_registered");
    expect((await call({ ...input, key: "new:0" })).body!.error).toBe("invalid_request");
    const response = await call(input);
    expect(resolveChatModel).toHaveBeenCalledWith("saved:m");
    expect(response.body!.checks[0].error).toBe("network");
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
