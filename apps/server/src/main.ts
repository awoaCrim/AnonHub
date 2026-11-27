#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { errorFields, logger } from "@yesimbot/foundation";

import { startServer } from "./host.js";

const log = logger("host");
/** How long a stop may take before the process exits anyway. */
const STOP_TIMEOUT_MS = 30_000;

/** `yesimbot-server [--state <dir>]`: runs one instance until SIGTERM or SIGINT. The state directory defaults to the current one. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { state: { type: "string" } } });
  const server = await startServer({ stateDir: resolve(values.state ?? process.cwd()), env: process.env });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("host.stopping", { signal });
    setTimeout(() => {
      log.error("host.stop_timeout", { ms: STOP_TIMEOUT_MS });
      process.exit(1);
    }, STOP_TIMEOUT_MS).unref();
    server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("host.stop_failed", { ...errorFields(error) });
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => log.error("host.unhandled_rejection", { ...errorFields(reason) }));
main().catch((error: unknown) => {
  log.error("host.start_failed", { ...errorFields(error) });
  process.exit(1);
});
