import { unwatchFile, watchFile } from "node:fs";

import { configureNetwork, errorFields, logger, readJson, type NetworkPolicy } from "@yesimbot/foundation";
import { z } from "zod/v4";

/** How often the policy file is checked for a change; the runtime manager replaces it atomically. */
const POLL_MS = 2000;
const POLICY_FILE = z.object({ proxy: z.string().optional(), directHosts: z.string().optional() });
const log = logger("yesimbot.network");

export interface NetworkPolicyOptions {
  /** `network.json`: the runtime manager's read-only policy mount in a member runtime, `data/network.json` otherwise. */
  readonly file: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pollMs?: number;
}

/** Where the egress policy lives when `YESIMBOT_NETWORK_FILE` does not say, relative to the app directory. */
export function defaultNetworkPolicyFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.YESIMBOT_NETWORK_FILE ?? (env.YESIMBOT_TENANT_ID ? "/run/yesimbot/policy/network.json" : "data/network.json");
}

/**
 * Applies the egress policy of every `httpFetch` and `modelFetch` (convention 05): `YESIMBOT_OUTBOUND_PROXY` (with
 * `YESIMBOT_DIRECT_HOSTS`) when set, otherwise the policy file, read now and again whenever it changes. A file that is
 * missing means no proxy; an invalid one is logged and the last valid policy stays. Returns the stop function.
 */
export async function startNetworkPolicy(options: NetworkPolicyOptions): Promise<() => void> {
  const env = options.env ?? process.env;
  if (env.YESIMBOT_OUTBOUND_PROXY) {
    configureNetwork({ proxy: env.YESIMBOT_OUTBOUND_PROXY, directHosts: env.YESIMBOT_DIRECT_HOSTS ?? "" });
    return () => undefined;
  }
  let stopped = false;
  let reading = Promise.resolve();
  const apply = async () => {
    let next: NetworkPolicy;
    try {
      const file = await readJson(options.file, POLICY_FILE);
      next = {
        ...(file?.proxy ? { proxy: file.proxy } : {}),
        directHosts: env.YESIMBOT_DIRECT_HOSTS ?? file?.directHosts ?? "",
      };
      if (stopped) return;
      configureNetwork(next);
    } catch (error) {
      log.error("network.policy_invalid", { file: options.file, ...errorFields(error) });
      return;
    }
    log.info("network.policy_applied", { proxied: next.proxy !== undefined });
  };
  await apply();
  const listener = () => void (reading = reading.then(apply));
  watchFile(options.file, { interval: options.pollMs ?? POLL_MS, persistent: false }, listener);
  return () => {
    stopped = true;
    unwatchFile(options.file, listener);
  };
}
