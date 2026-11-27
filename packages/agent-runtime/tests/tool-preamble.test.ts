import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { expect, it, vi } from "vitest";

import { toolPreambleMiddleware } from "../src/tool-preamble.js";

async function stream(parts: LanguageModelV3StreamPart[], publish: (text: string, name: string) => Promise<void>, signal?: AbortSignal) {
  const middleware = toolPreambleMiddleware(publish);
  return await middleware.wrapStream!({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
    params: { abortSignal: signal },
  } as never);
}
const call = (toolName = "lookup"): LanguageModelV3StreamPart => ({ type: "tool-call", toolCallId: "call", toolName, input: "{}" });
it("only publishes public text, once for a parallel tool batch", async () => {
  const publish = vi.fn(async () => {});
  const parts: LanguageModelV3StreamPart[] = [
    { type: "reasoning-delta", id: "r", delta: "private reasoning" },
    { type: "text-delta", id: "t", delta: "我先核对两份资料。" },
    call(),
    call("read"),
  ];
  const result = await stream(parts, publish);
  expect(await Array.fromAsync(result.stream)).toEqual(parts);
  expect(publish).toHaveBeenCalledExactlyOnceWith("我先核对两份资料。", "lookup");
});
it("does not announce a final answer or finish", async () => {
  const publish = vi.fn(async () => {});
  await Array.fromAsync((await stream([{ type: "text-delta", id: "t", delta: "完成" }, call("finish")], publish)).stream);
  expect(publish).not.toHaveBeenCalled();
});
it("does not let a tool call through when publication fails", async () => {
  const result = await stream([call()], async () => {
    throw Error("delivery failed");
  });
  await expect(Array.fromAsync(result.stream)).rejects.toThrow("delivery failed");
});
it("checks cancellation again after awaiting publication", async () => {
  const abort = new AbortController();
  const result = await stream(
    [call()],
    async () => {
      abort.abort();
    },
    abort.signal,
  );
  await expect(Array.fromAsync(result.stream)).rejects.toThrow("Aborted");
});
