import { textPart } from "@yesimbot/contracts/parts";
import { vi } from "vitest";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function outputs(...content: string[]) {
  return (async function* () {
    yield { turnId: "turn-1", messageId: "assistant-1", segments: content.map((text) => [textPart(text)]) };
  })();
}

export function delivery(signal?: AbortSignal) {
  return {
    fail: vi.fn(async () => ({ kind: "wait" as const, eventId: "failure-1" })),
    onDelivered: vi.fn(async () => undefined),
    signal: signal ?? new AbortController().signal,
  };
}
