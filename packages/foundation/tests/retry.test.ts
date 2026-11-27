import { describe, expect, it } from "vitest";

import { AppError, retry, type RetryPolicy } from "../src/index.js";

const waits: number[] = [];
const base = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  attempts: 3,
  effect: "idempotent",
  classify: (error) =>
    error instanceof AppError && error.status === 429 ? "rate_limited" : error instanceof AppError && error.retryable ? "transient" : "fatal",
  backoff: { baseMs: 100, factor: 2, maxMs: 1000, jitter: false },
  sleep: async (ms) => void waits.push(ms),
  ...overrides,
});

describe("retry", () => {
  it("retries transient failures with backoff and returns the first success", async () => {
    waits.length = 0;
    let calls = 0;
    const value = await retry(async (attempt) => {
      calls++;
      if (attempt < 3) throw new AppError("network_failed");
      return "done";
    }, base());
    expect(value).toBe("done");
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("throws the last error unchanged, and fatal errors at once", async () => {
    let calls = 0;
    const last = new AppError("network_failed");
    await expect(retry(async () => Promise.reject((calls++, last)), base())).rejects.toBe(last);
    expect(calls).toBe(3);
    calls = 0;
    await expect(retry(async () => Promise.reject((calls++, new AppError("input_invalid"))), base())).rejects.toMatchObject({ code: "input_invalid" });
    expect(calls).toBe(1);
  });

  it("retries an unsafe operation only when the failure proves nothing happened", async () => {
    let calls = 0;
    await expect(
      retry(async () => Promise.reject((calls++, new AppError("network_failed", { effect: "unknown" }))), base({ effect: "unsafe" })),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      retry(async () => Promise.reject((calls++, new AppError("network_failed", { effect: "none" }))), base({ effect: "unsafe" })),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("honours a server wait hint up to the cap", async () => {
    waits.length = 0;
    let calls = 0;
    await retry(async () => {
      if (calls++ === 0) throw new AppError("network_failed", { status: 429, retryAfterMs: 700 });
      return "ok";
    }, base());
    expect(waits).toEqual([700]);
    calls = 0;
    await expect(
      retry(async () => Promise.reject((calls++, new AppError("network_failed", { status: 429, retryAfterMs: 120_000 }))), base()),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("never retries an abort and stops waiting when aborted", async () => {
    let calls = 0;
    await expect(retry(async () => Promise.reject((calls++, new DOMException("stop", "AbortError"))), base())).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    const controller = new AbortController();
    const pending = retry(
      async () => {
        controller.abort(new Error("cancelled"));
        throw new AppError("network_failed");
      },
      { ...base(), sleep: undefined, signal: controller.signal, backoff: { baseMs: 60_000, factor: 1, maxMs: 60_000, jitter: false } },
    );
    await expect(pending).rejects.toThrow();
    await expect(retry(async () => 1, base({ attempts: 0 }))).rejects.toThrow(RangeError);
  });
});
