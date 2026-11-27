import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { errorFields, isRecord, logger, writeFileAtomic } from "@yesimbot/foundation";
import { CONTEXT_POLICY_FILE, contextPolicy, LOCKED, memberId, POLICY_FILE, readContextPolicy, readPluginPolicy } from "koishi-plugin-yesimbot-console/server";

const log = logger("host.member");

/** How often the account manager's files are read again, as on Koishi. */
const POLICY_INTERVAL_MS = 5000;

type Tree = Record<string, unknown>;

export interface MemberPolicyOptions {
  /** `YESIMBOT_TENANT_ID`: a member runtime has both policies. */
  readonly tenantId?: string;
  /** `YESIMBOT_MANAGED_CONTEXT=1` outside a member runtime: the context policy only. */
  readonly managedContext?: boolean;
  readonly pluginsFile?: string;
  readonly contextFile?: string;
}

/**
 * The account manager's read-only policy for this runtime (`/run/yesimbot/policy`), as the Koishi glue enforced it
 * before leave-koishi stage 8: which optional modules may run, and the session settings every Core gets. `undefined` when neither applies.
 */
export class MemberPolicy {
  public readonly plugins: boolean;
  private allowed: Set<string> | undefined;
  private session: Tree | undefined;
  private signatures: { plugins: string; context: string };
  private readonly pluginsFile: string;
  private readonly contextFile: string;

  private constructor(options: MemberPolicyOptions, plugins: boolean) {
    this.plugins = plugins;
    this.pluginsFile = options.pluginsFile ?? POLICY_FILE;
    this.contextFile = options.contextFile ?? CONTEXT_POLICY_FILE;
    this.signatures = { plugins: signature(this.pluginsFile), context: signature(this.contextFile) };
    if (plugins) this.allowed = this.readPlugins();
    try {
      this.session = readContextPolicy(this.contextFile);
    } catch (error) {
      // Fails closed: Core does not start until a valid policy is read.
      log.warn("context_policy.unavailable", { ...errorFields(error) });
    }
  }

  public static from(options: MemberPolicyOptions): MemberPolicy | undefined {
    const member = memberId.test(options.tenantId ?? "");
    if (!member && !options.managedContext) return undefined;
    return new MemberPolicy(options, member);
  }

  /** Whether the module may run: every module outside a member runtime, else the console's required set and the grant. */
  public admits(id: string): boolean {
    return !this.allowed || this.allowed.has(id);
  }

  /** Whether the console may change this module: a member never stops or reconfigures the console holding this policy. */
  public locks(id: string): boolean {
    return this.plugins && id === LOCKED;
  }

  /** Core's config with the policy's session in place. */
  public withSession(config: unknown): Tree {
    const value = isRecord(config) ? config : {};
    return { ...value, session: structuredClone(this.currentSession()) };
  }

  /** Whether a stored Core config already holds the policy's session. */
  public holdsSession(config: unknown): boolean {
    const session = isRecord(config) ? config.session : undefined;
    return isRecord(session) && isDeepStrictEqual(session, this.currentSession());
  }

  /** Reads both files again when they changed; says which did. */
  public refresh(): { plugins: boolean; context: boolean } {
    const next = { plugins: signature(this.pluginsFile), context: signature(this.contextFile) };
    const changed = { plugins: this.plugins && next.plugins !== this.signatures.plugins, context: next.context !== this.signatures.context };
    this.signatures = next;
    if (changed.plugins) this.allowed = this.readPlugins();
    if (changed.context) {
      try {
        this.session = readContextPolicy(this.contextFile);
      } catch (error) {
        // Members keep the last valid policy.
        changed.context = false;
        log.warn("context_policy.unavailable", { ...errorFields(error) });
      }
    }
    return changed;
  }

  /** Calls `apply` whenever a file changed, until the returned function runs. */
  public watch(apply: (changed: { plugins: boolean; context: boolean }) => void, intervalMs = POLICY_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      const changed = this.refresh();
      if (changed.plugins || changed.context) apply(changed);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private currentSession(): Tree {
    if (!this.session) throw new Error("managed_context_unavailable");
    return this.session;
  }

  private readPlugins(): Set<string> {
    return readPluginPolicy(this.pluginsFile, (reason) => log.warn("plugin.policy.unavailable", { reason }));
  }
}

/**
 * The owner's effective session settings, published for the account manager to copy into every member's policy
 * (`data/console-admin/context-policy.json`, as on Koishi). Writes only when they changed.
 */
export function contextPublisher(baseDir: string, session: () => unknown, intervalMs = POLICY_INTERVAL_MS): { publish(): Promise<void>; stop(): void } {
  const file = resolve(baseDir, "data/console-admin/context-policy.json");
  const publish = async () => {
    const current = session();
    if (current === undefined) return;
    try {
      const data = JSON.stringify(contextPolicy(current)) + "\n";
      try {
        if (readFileSync(file, "utf8") === data) return;
      } catch {
        /* First publication. */
      }
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, data, { mode: 0o600 });
    } catch (error) {
      // Members keep the last valid policy.
      log.warn("context_policy.publish_failed", { ...errorFields(error) });
    }
  };
  const timer = setInterval(() => void publish(), intervalMs);
  timer.unref?.();
  void publish();
  return { publish, stop: () => clearInterval(timer) };
}

function signature(file: string): string {
  try {
    const info = statSync(file);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}
