import { AppError, isAbortError } from "./errors.js";

const DEFAULT_BACKOFF = { baseMs: 500, factor: 2, maxMs: 30_000, jitter: true } as const;

export type RetryClass = "transient" | "rate_limited" | "fatal";

/**
 * `idempotent`: repeating is harmless. `keyed`: the server deduplicates by an idempotency key the operation sends.
 * `unsafe`: repeating may do it twice, so only a failure proven to have done nothing (`AppError` with effect `none`)
 * is retried.
 */
export type RetryEffect = "idempotent" | "keyed" | "unsafe";

export interface RetryPolicy {
  /** Total attempts including the first, 1 to 10. */
  readonly attempts: number;
  readonly classify: (error: unknown) => RetryClass;
  readonly effect: RetryEffect;
  readonly backoff?: { readonly baseMs: number; readonly factor: number; readonly maxMs: number; readonly jitter: boolean };
  /** A longer server wait hint than this ends the retries; default 60 s. */
  readonly retryAfterCapMs?: number;
  readonly signal?: AbortSignal;
  /** Tests replace the wait. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The one retry loop. The last error is thrown unchanged; an abort is never retried. */
export async function retry<T>(operation: (attempt: number, signal: AbortSignal) => Promise<T>, policy: RetryPolicy): Promise<T> {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1 || policy.attempts > 10) throw new RangeError("attempts must be 1 to 10");
  const signal = policy.signal ?? new AbortController().signal;
  const backoff = policy.backoff ?? DEFAULT_BACKOFF;
  const wait = policy.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await operation(attempt, signal);
    } catch (error) {
      if (attempt >= policy.attempts || isAbortError(error) || signal.aborted) throw error;
      const kind = policy.classify(error);
      if (kind === "fatal") throw error;
      if (policy.effect === "unsafe" && !(error instanceof AppError && error.effect === "none")) throw error;
      const hint = error instanceof AppError ? error.retryAfterMs : undefined;
      let delay = Math.min(backoff.maxMs, backoff.baseMs * backoff.factor ** (attempt - 1));
      if (backoff.jitter) delay = delay / 2 + Math.random() * (delay / 2);
      if (kind === "rate_limited" && hint !== undefined && Number.isFinite(hint) && hint >= 0) {
        if (hint > (policy.retryAfterCapMs ?? 60_000)) throw error;
        delay = Math.max(delay, hint);
      }
      await wait(Math.round(delay), signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
