import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import type { ComputerDriver } from "@yesimbot/computer-driver";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createComputerUseTool } from "../src/tool.js";
import { scriptedModel } from "./scripted-model.js";

const SCREENSHOT = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" as const };

function context() {
  return { toolCallId: "computer-call", turnId: "turn-1", abortSignal: new AbortController().signal, messages: [] } as never;
}

describe("computer_use tool", () => {
  it("projects only the current turn screenshot into model output", async () => {
    const projection = new EphemeralImageProjectionStore();
    const driver: ComputerDriver = { execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) };
    const tool = createComputerUseTool({
      imageProjection: projection,
      imageInput: { mode: "native" },
      model: scriptedModel([[{ name: "desktop_screenshot" }], "完成"]).model,
      driverFactory: () => driver,
      timeoutMs: 10_000,
    });

    const result = await tool.execute({ task: "查看桌面" }, context());
    const modelOutput = tool.toModelOutput?.({ toolCallId: "computer-call", output: result } as never) as { value: Array<{ type: string; data?: string }> };

    expect(result).toMatchObject({ ok: true, status: "completed" });
    expect(modelOutput.value.map((part) => part.type)).toEqual(["text", "image-data"]);
    expect(modelOutput.value[1]?.data).toBe(Buffer.from(SCREENSHOT.bytes).toString("base64"));
    expect(driver.close).toHaveBeenCalledOnce();
    projection.clearAll();
  });

  it("keeps provider diagnostics for the owner but strips keys and URL queries from them", async () => {
    const projection = new EphemeralImageProjectionStore();
    const tool = createComputerUseTool({
      imageProjection: projection,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("403 https://gateway.example.com/v1/responses?key=AIzaSyA1234567890abcdef rejected Bearer abc.def.ghi");
        },
      }),
      driverFactory: () => ({ execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) }),
      timeoutMs: 10_000,
    });

    const result = await tool.execute({ task: "查看桌面" }, context());
    expect(result).toMatchObject({ ok: false, error: { code: "provider_error" } });
    const message = (result as { error: { message: string } }).error.message;
    expect(message).toContain("https://gateway.example.com/v1/responses");
    expect(message).not.toContain("AIzaSyA1234567890abcdef");
    expect(message).not.toContain("abc.def.ghi");
  });

  it("returns a bounded failure when the execution signal is already aborted", async () => {
    const projection = new EphemeralImageProjectionStore();
    const driverFactory = vi.fn();
    const tool = createComputerUseTool({
      imageProjection: projection,
      model: scriptedModel([]).model,
      driverFactory,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ task: "不要执行" }, { ...context(), abortSignal: controller.signal } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", retryable: false } });
    expect(driverFactory).not.toHaveBeenCalled();
  });

  it.each(["expired", "replaced", "copied"])("does not claim the final screenshot was seen when its projection is %s", async (loss) => {
    const projection = new EphemeralImageProjectionStore();
    const driver: ComputerDriver = { execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) };
    const tool = createComputerUseTool({
      imageProjection: projection,
      imageInput: { mode: "native" },
      model: scriptedModel(() => "verified").model,
      driverFactory: () => driver,
      timeoutMs: 10_000,
    });
    let result = await tool.execute({ task: "observe" }, context());
    expect(result).toMatchObject({ imageMode: "native" });
    if (loss === "expired") projection.clearAll();
    if (loss === "replaced") {
      const replacement = await tool.execute({ task: "observe again" }, context());
      expect(tool.toModelOutput!({ toolCallId: "computer-call", input: { task: "observe again" }, output: replacement })).toMatchObject({
        value: [{ type: "text" }, { type: "image-data" }],
      });
    }
    if (loss === "copied") result = { ...result };
    const projected = tool.toModelOutput!({ toolCallId: "computer-call", input: { task: "observe" }, output: result }) as { value: [{ text: string }] };
    expect(projected.value).toHaveLength(1);
    expect(JSON.parse(projected.value[0].text)).toMatchObject({ imageMode: "unavailable", imageError: "image_projection_unavailable" });
    projection.clearAll();
  });

  it("reports an unavailable final screenshot if a caller omitted its native projection store", async () => {
    const tool = createComputerUseTool({
      imageProjection: undefined as never,
      imageInput: { mode: "native" },
      model: scriptedModel(() => "verified").model,
      driverFactory: () => ({ execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) }),
      timeoutMs: 10_000,
    });
    const result = await tool.execute({ task: "observe" }, context());
    expect(result).toMatchObject({ imageMode: "unavailable", imageError: "image_input_unavailable" });
    expect(JSON.stringify(result)).not.toContain(Buffer.from(SCREENSHOT.bytes).toString("base64"));
  });

  it("still aborts an in-flight model request and closes the driver on timeout", async () => {
    vi.useFakeTimers();
    try {
      const driver: ComputerDriver = { execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) };
      const request = vi.fn(
        ({ abortSignal }: { abortSignal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true })),
      );
      const tool = createComputerUseTool({
        imageProjection: new EphemeralImageProjectionStore(),
        model: new MockLanguageModelV3({ doGenerate: request }),
        driverFactory: () => driver,
        timeoutMs: 50,
      });

      const pending = tool.execute({ task: "等待页面" }, context());
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "timeout", retryable: false } });
      expect(request).toHaveBeenCalledOnce();
      expect(driver.execute).toHaveBeenCalledOnce();
      expect(driver.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still propagates manual cancellation to the model request and closes the driver", async () => {
    const controller = new AbortController();
    const driver: ComputerDriver = { execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) };
    const request = vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      controller.abort();
      throw abortSignal?.reason;
    });
    const tool = createComputerUseTool({
      imageProjection: new EphemeralImageProjectionStore(),
      model: new MockLanguageModelV3({ doGenerate: request }),
      driverFactory: () => driver,
      timeoutMs: 10_000,
    });

    const result = await tool.execute({ task: "取消任务" }, { ...context(), abortSignal: controller.signal } as never);

    expect(result).toMatchObject({ ok: false, error: { code: "aborted", retryable: false } });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
    expect(driver.execute).toHaveBeenCalledOnce();
    expect(driver.close).toHaveBeenCalledOnce();
  });
});
