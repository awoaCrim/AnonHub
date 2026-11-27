import type { Host } from "../host.js";

export const kRecord = Symbol.for("koishi.loader.record");

export async function settleReload(
  ctx: Host,
  fork?: { error?: unknown; isActive?: boolean; runtime?: { error?: unknown; isReusable?: boolean; isActive?: boolean } },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.lifecycle.flush(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("startup_timeout")), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (fork && (fork.error || fork.runtime?.error || fork.isActive === false || (fork.runtime?.isReusable === false && fork.runtime.isActive === false)))
    throw new Error("scope_failed");
}
