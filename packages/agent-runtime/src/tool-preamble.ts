import type { LanguageModelMiddleware } from "ai";

/** Observe public text before handing a local tool call to the SDK for execution. */
export function toolPreambleMiddleware(publish: (text: string, toolName: string) => Promise<void>): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    async wrapStream({ doStream, params }) {
      const result = await doStream();
      let text = "";
      let announced = false;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            async transform(part, controller) {
              if (params.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
              if (part.type === "text-delta") text += part.delta;
              if (part.type === "tool-call" && !part.providerExecuted && part.toolName !== "finish") {
                // One explanation can cover a batch of parallel calls. A later model step has
                // its own stream and must announce its next action again. Never read reasoning.
                if (text.trim() || !announced) {
                  await publish(text.trim(), part.toolName);
                  text = "";
                  announced = true;
                }
              }
              if (params.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}
