import { generateImage } from "ai";
import { imageTransportFailure, type ImageModelAdapter } from "koishi-plugin-yesimbot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAIImageAdapter, createOpenAIImageEditor } from "../src/images.js";
import { registerWith } from "./register.js";

const bytes = new Uint8Array([0, 255, 1, 128]);
const response = () =>
  new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(bytes).toString("base64") }] }), {
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared OpenAI Images connection", () => {
  it.each(["chat", "responses"] as const)("shares the %s connection credentials and exact JSON edits protocol", async (format) => {
    const requests: Array<{ url: string; headers: Headers; body: unknown; signal?: AbortSignal | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal: init?.signal });
        return response();
      }),
    );
    let provider: { imageModels(): unknown[]; image(id: string): ImageModelAdapter } | undefined;
    registerWith(
      {
        id: "shared",
        apiKey: "shared-key",
        baseURL: "https://shared.invalid/v1/",
        format,
        chatModels: [],
        embeddingModels: [],
        imageModels: [{ id: "image-1" }],
      },
      (value) => {
        provider = value as never;
        return () => undefined;
      },
    );
    expect(provider!.imageModels()).toEqual([{ id: "image-1" }]);
    const adapter = provider!.image("image-1");
    const controller = new AbortController();
    await generateImage({ model: adapter.model, prompt: "new image", n: 1, size: "1024x1024", maxRetries: 0, abortSignal: controller.signal });
    expect(
      await adapter.edit({
        sourceDataUrls: ["data:image/png;base64,AP8BgA=="],
        prompt: "edit image",
        size: "1024x1536",
        maxBytes: 4,
        abortSignal: controller.signal,
      }),
    ).toEqual({ images: [{ uint8Array: bytes }], totalImages: 1 });
    expect(requests.map(({ url }) => url)).toEqual(["https://shared.invalid/v1/images/generations", "https://shared.invalid/v1/images/edits"]);
    expect(requests.every(({ headers }) => headers.get("authorization") === "Bearer shared-key")).toBe(true);
    expect(requests[1]!.headers.get("content-type")).toBe("application/json");
    expect(requests[1]!.body).toEqual({
      model: "image-1",
      prompt: "edit image",
      images: [{ image_url: "data:image/png;base64,AP8BgA==" }],
      size: "1024x1536",
      n: 1,
      response_format: "b64_json",
    });
    expect(requests[1]!.signal).toBe(controller.signal);
  });

  it("keeps each request's resource cap instead of sharing a previous channel's limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const { edit } = createOpenAIImageAdapter({ apiKey: "test", modelId: "image-1", fetch });
    const request = { sourceDataUrls: ["data:image/png;base64,AQ=="], prompt: "edit", abortSignal: new AbortController().signal };
    await expect(edit({ ...request, maxBytes: 3 })).rejects.toMatchObject({ code: "image_too_large" });
    await expect(edit({ ...request, maxBytes: 4 })).resolves.toMatchObject({ images: [{ uint8Array: bytes }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, '{"error":"content policy blocked"}', "image_content_refused", false],
    [503, '{"error":"secret internal details"}', "image_provider_failed", true],
    [200, '{"data":[]}', "image_result_empty", true],
    [200, '{"data":[{"b64_json":"bad base64"}]}', "image_data_invalid", true],
    [200, "x".repeat(70_000), "image_too_large", false],
  ])("bounds and sanitizes a %s edit failure without retries", async (status, body, code, retryable) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body as string, { status: status as number }));
    const edit = createOpenAIImageEditor({ apiKey: "secret-key", modelId: "image-1", fetch });
    const pending = edit({ sourceDataUrls: [], prompt: "secret prompt", maxBytes: 4, abortSignal: new AbortController().signal });
    const failure = await pending.then(
      () => undefined,
      (cause: unknown) => imageTransportFailure(cause),
    );
    expect(failure).toMatchObject({ code, retryable });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// Images follow the endpoint (user, 2026-11-23: 「图片也需要看端点」): a gateway forwarded the OpenAI Images body to
// Gemini unconverted, and Gemini answered 400 for the missing `contents`.
describe("Gemini endpoint images", () => {
  const geminiImage = () =>
    new Response(
      JSON.stringify({
        candidates: [
          { content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from(bytes).toString("base64") } }] }, finishReason: "STOP" },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );

  function registerGoogle() {
    let provider: { capabilities: { image?: boolean }; imageModels(): unknown[]; image(id: string): ImageModelAdapter } | undefined;
    registerWith(
      {
        type: "google",
        id: "gemini",
        apiKey: "gemini-key",
        baseURL: "https://gateway.invalid/v1beta",
        chatModels: [],
        embeddingModels: [],
        imageModels: [{ id: "gemini-3.1-flash-image" }],
      },
      (value) => {
        provider = value as never;
        return () => undefined;
      },
    );
    return provider!;
  }

  it("draws and edits through generateContent with image parts, never the Images API body", async () => {
    const requests: Array<{ url: string; body: { contents: Array<{ parts: Array<Record<string, unknown>> }>; generationConfig?: Record<string, unknown> } }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return geminiImage();
      }),
    );
    const provider = registerGoogle();
    expect(provider.capabilities.image).toBe(true);
    expect(provider.imageModels()).toEqual([{ id: "gemini-3.1-flash-image" }]);
    const adapter = provider.image("gemini-3.1-flash-image");

    const generated = await generateImage({ model: adapter.model, prompt: "a cat", n: 1, size: "1536x1024", maxRetries: 0 });
    expect(generated.images[0]!.uint8Array).toEqual(bytes);
    expect(
      await adapter.edit({
        sourceDataUrls: ["data:image/png;base64,AP8BgA=="],
        prompt: "make it blue",
        size: "1024x1536",
        maxBytes: 4,
        abortSignal: new AbortController().signal,
      }),
    ).toEqual({ images: [{ uint8Array: bytes }], totalImages: 1 });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://gateway.invalid/v1beta/models/gemini-3.1-flash-image:generateContent",
      "https://gateway.invalid/v1beta/models/gemini-3.1-flash-image:generateContent",
    ]);
    const [draw, edit] = requests;
    expect(draw!.body.contents[0]!.parts).toEqual([{ text: "a cat" }]);
    expect(draw!.body.generationConfig).toMatchObject({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:2" } });
    expect(edit!.body.contents[0]!.parts).toEqual([{ text: "make it blue" }, { inlineData: { mimeType: "image/png", data: "AP8BgA==" } }]);
    expect(edit!.body.generationConfig).toMatchObject({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "2:3" } });
  });

  it.each([
    [400, '{"error":{"message":"blocked by safety settings"}}', "image_content_refused", false],
    [503, '{"error":{"message":"overloaded"}}', "image_provider_failed", true],
  ])("reports a %s edit failure as the tools' own error", async (status, body, code, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(body as string, { status: status as number, headers: { "content-type": "application/json" } })),
    );
    const { edit } = registerGoogle().image("gemini-3.1-flash-image");
    await expect(
      edit({ sourceDataUrls: ["data:image/png;base64,AQ=="], prompt: "edit", maxBytes: 4, abortSignal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it("keeps the provider's status and message for the log, and retries a dropped connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const request = { sourceDataUrls: ["data:image/png;base64,AQ=="], prompt: "edit", maxBytes: 4, abortSignal: new AbortController().signal };
    const rejected = registerGoogle().image("gemini-3.1-flash-image").edit(request);
    await expect(rejected).rejects.toMatchObject({ code: "image_provider_failed", retryable: false, message: "image_provider_failed" });
    await expect(rejected).rejects.toMatchObject({ detail: expect.stringMatching(/^HTTP 400：.*invalid argument/) });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed", { cause: new Error("other side closed") });
      }),
    );
    const dropped = registerGoogle().image("gemini-3.1-flash-image").edit(request);
    await expect(dropped).rejects.toMatchObject({
      code: "image_provider_failed",
      retryable: true,
      detail: expect.stringMatching(/^重试后仍失败，没有收到响应：.*other side closed/),
    });
  });

  it("retries once when a 200 response breaks off while it is read, and logs what was underneath", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AP8'));
            controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const request = { sourceDataUrls: ["data:image/png;base64,AQ=="], prompt: "edit", maxBytes: 4, abortSignal: new AbortController().signal };
    const flaky = vi.fn<typeof fetch>().mockResolvedValueOnce(broken()).mockResolvedValueOnce(geminiImage());
    vi.stubGlobal("fetch", flaky);
    await expect(registerGoogle().image("gemini-3.1-flash-image").edit(request)).resolves.toEqual({ images: [{ uint8Array: bytes }], totalImages: 1 });
    expect(flaky).toHaveBeenCalledTimes(2);

    const failing = vi.fn<typeof fetch>(async () => broken());
    vi.stubGlobal("fetch", failing);
    await expect(registerGoogle().image("gemini-3.1-flash-image").edit(request)).rejects.toMatchObject({
      code: "image_provider_failed",
      retryable: true,
      detail: expect.stringMatching(
        /^重试后仍失败，HTTP 200：Failed to process successful response ← TypeError: terminated ← Error\[UND_ERR_SOCKET\]: other side closed/,
      ),
    });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("keeps the request's output cap on Gemini edits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => geminiImage()),
    );
    const { edit } = registerGoogle().image("gemini-3.1-flash-image");
    await expect(
      edit({ sourceDataUrls: ["data:image/png;base64,AQ=="], prompt: "edit", maxBytes: 3, abortSignal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "image_too_large",
    });
  });
});
