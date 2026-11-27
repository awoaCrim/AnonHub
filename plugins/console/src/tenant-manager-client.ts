import { lstat, readFile } from "node:fs/promises";

import type { UsagePayload } from "@yesimbot/contracts";
import { httpFetch, type BoundedResponse, type HttpFetchOptions } from "@yesimbot/foundation";

import { memberId } from "./accounts.js";
import {
  OPS_PROGRAM_STATES,
  type BotSummary,
  type InstanceRestartResponse,
  type OpsInstance,
  type OpsProgram,
  type OpsProgramName,
  type OpsSnapshot,
  type RuntimeView,
} from "./shared/accounts.js";
import { normalizeMemberPlugins } from "./shared/plugin-catalog.js";

/** The manager refused or failed; `status` is its HTTP status so routes can pass the useful ones on. */
export class ManagerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class TenantManagerClient {
  readonly endpoint: URL;
  constructor(
    endpoint: string,
    private keyFile: string,
    private readonly send: typeof httpFetch = httpFetch,
  ) {
    this.endpoint = new URL(endpoint);
    if (
      !["http:", "https:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.pathname !== "/" ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new Error("invalid_manager_endpoint");
  }
  /** The manager is on this machine or the private network; a redirect from it is a failure. */
  private fetch(url: URL, init: Omit<HttpFetchOptions, "purpose" | "maxBytes"> & { maxBytes?: number }): Promise<BoundedResponse> {
    return this.send(url, { purpose: "internal", maxBytes: 1024 * 1024, ...init });
  }
  async headers() {
    const info = await lstat(this.keyFile);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("manager_unavailable");
    const key = (await readFile(this.keyFile, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("manager_unavailable");
    return { Authorization: `Bearer ${key}` };
  }
  path(id: string, suffix = "") {
    if (!memberId.test(id)) throw new Error("invalid_account_id");
    return `/v1/runtimes/${id}${suffix}`;
  }
  async runtime(id: string, action?: "register" | "start" | "stop", qqAccount?: unknown, plugins?: readonly string[]): Promise<RuntimeView> {
    if (qqAccount !== undefined && (typeof qqAccount !== "string" || !/^[1-9][0-9]{4,11}$/.test(qqAccount))) throw new Error("invalid_qq_account");
    // Only registration carries the plugin grant; the manager rejects it elsewhere.
    const granted = action === "register" && plugins !== undefined ? normalizeMemberPlugins(plugins) : undefined;
    const response = await this.fetch(new URL(this.path(id, action && action !== "register" ? `/${action}` : ""), this.endpoint), {
      method: action === "register" ? "PUT" : action ? "POST" : "GET",
      headers: { ...(await this.headers()), "Content-Type": "application/json" },
      ...(action ? { body: JSON.stringify({ qqAccount, ...(granted ? { plugins: granted } : {}) }) } : {}),
      timeoutMs: 10000,
    });
    if (!response.ok) throw new Error("runtime_operation_failed");
    const data = (await response.json()) as { runtime?: RuntimeView };
    const r = data.runtime;
    if (!r || r.id !== id || !["setup-required", "starting", "running", "stopping", "stopped", "error"].includes(r.state))
      throw new Error("manager_unavailable");
    return {
      id,
      state: r.state,
      ...(r.location === "local"
        ? {
            location: "local" as const,
            name: typeof r.name === "string" ? r.name.slice(0, 128) : undefined,
            version: typeof r.version === "string" ? r.version.slice(0, 100) : undefined,
            policyVersion: typeof r.policyVersion === "string" && /^[a-f0-9]{64}$/.test(r.policyVersion) ? r.policyVersion : undefined,
          }
        : {}),
      ...(typeof r.qqAccount === "string" && /^[1-9][0-9]{4,11}$/.test(r.qqAccount) ? { qqAccount: r.qqAccount } : {}),
      ...(r.state === "error" ? { errorCode: "runtime_operation_failed" } : {}),
      ...(typeof r.updatedAt === "string" && Number.isFinite(Date.parse(r.updatedAt)) ? { updatedAt: r.updatedAt } : {}),
    };
  }
  async usage(id: string): Promise<UsagePayload> {
    const response = await this.fetch(new URL(this.path(id, "/http/yesimbot/api/v1/usage"), this.endpoint), {
      headers: { ...(await this.headers()), Accept: "application/json" },
      timeoutMs: 4000,
    });
    if (!response.ok) throw new Error("usage_unavailable");
    const text = await boundedText(response, "usage_unavailable");
    const data = JSON.parse(text) as UsagePayload;
    if (!data?.today || !data.rate || !Array.isArray(data.recent) || !Array.isArray(data.byHour) || !Array.isArray(data.byModel))
      throw new Error("usage_unavailable");
    return data;
  }
  /** Deleting a friend: the manager removes its bot, computer and data, then forgets it. */
  async remove(id: string): Promise<void> {
    const response = await this.fetch(new URL(this.path(id), this.endpoint), {
      method: "DELETE",
      headers: await this.headers(),
      timeoutMs: 10000,
    });
    // Already gone counts as deleted.
    if (response.status === 404) return;
    if (!response.ok) throw new Error("runtime_operation_failed");
    const data = (await response.json()) as { runtime?: { id?: unknown; state?: unknown } };
    if (data.runtime?.id !== id || data.runtime.state !== "deleting") throw new Error("manager_unavailable");
  }
  /** A running member's health, read as that runtime's own administrator. Only known fields of known types survive. */
  async summary(id: string, timeoutMs = 4000): Promise<BotSummary> {
    const response = await this.fetch(new URL(this.path(id, "/http/yesimbot/api/v1/bot/summary"), this.endpoint), {
      headers: { ...(await this.headers()), Accept: "application/json" },
      timeoutMs,
      maxBytes: 16 * 1024,
    });
    if (!response.ok) throw new Error("summary_unavailable");
    const text = await boundedText(response, "summary_unavailable");
    const data = JSON.parse(text) as Record<string, unknown>;
    const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
    const strings = (value: unknown, max: number, length: number) =>
      Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === "string")
            .slice(0, max)
            .map((item) => item.slice(0, length))
        : undefined;
    return {
      qqOnline: flag(data.qqOnline),
      modelReady: flag(data.modelReady),
      roleReady: flag(data.roleReady),
      allowedChannels: count(data.allowedChannels),
      todayCalls: count(data.todayCalls),
      lastActivityAt: count(data.lastActivityAt),
      attention: count(data.attention),
      chatModel: typeof data.chatModel === "string" ? data.chatModel.slice(0, 120) : null,
      todayTokens: count(data.todayTokens),
      plugins: strings(data.plugins, 40, 40),
      issues: strings(data.issues, 5, 120),
      failures: count(data.failures),
      conversations: count(data.conversations),
      uptimeSeconds: count(data.uptimeSeconds),
      recent: Array.isArray(data.recent)
        ? data.recent
            .filter(
              (row): row is { type: "channel" | "guild" | "direct"; channelId: string; at: number } =>
                !!row && ["channel", "guild", "direct"].includes(row.type) && typeof row.channelId === "string" && count(row.at) !== null,
            )
            .slice(0, 5)
            .map((row) => ({ type: row.type, channelId: row.channelId.slice(0, 64), at: row.at }))
        : undefined,
    };
  }
  /** Container and process state of the owner's bot and every friend's. */
  async ops(timeoutMs = 4000): Promise<OpsSnapshot> {
    const response = await this.fetch(new URL("/v1/ops", this.endpoint), {
      headers: { ...(await this.headers()), Accept: "application/json" },
      timeoutMs,
    });
    if (!response.ok) throw new ManagerError("ops_unavailable", response.status);
    const text = await boundedText(response, "ops_unavailable");
    const data = JSON.parse(text) as { instances?: unknown };
    if (!Array.isArray(data.instances)) throw new Error("ops_unavailable");
    const snapshot: OpsSnapshot = { accounts: {} };
    for (const item of data.instances) {
      const instance = sanitizeOps(item);
      if (!instance) continue;
      if (instance.target === "owner") snapshot.owner = instance;
      else snapshot.accounts[instance.target] = instance;
    }
    return snapshot;
  }
  /** Restarts the bot (Koishi) or QQ (NapCat) of one instance. The owner's own Koishi is answered 202 before it goes down. */
  async restart(target: string, program: OpsProgramName): Promise<InstanceRestartResponse & { status: number }> {
    if (target !== "owner" && !memberId.test(target)) throw new Error("invalid_target");
    if (program !== "koishi" && program !== "napcat") throw new Error("invalid_program");
    const response = await this.fetch(new URL(`/v1/ops/${target}/restart`, this.endpoint), {
      method: "POST",
      headers: { ...(await this.headers()), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ program }),
      // A member's restart waits for the process to be back.
      timeoutMs: 60_000,
    });
    if (!response.ok) throw new ManagerError("restart_failed", response.status);
    if (response.status === 202) return { status: 202, accepted: true };
    const data = (await response.json()) as { instance?: unknown };
    const instance = sanitizeOps(data.instance);
    return { status: 200, ...(instance ? { instance } : {}) };
  }
  /** One call into a friend's own NapCat login API through the manager's relay. The caller has already checked the path. */
  async napcat(id: string, method: "GET" | "POST", rest: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await this.fetch(new URL(this.path(id, `/http/yesimbot/napcat/${rest}`), this.endpoint), {
      method,
      headers: { ...(await this.headers()), Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      // A password or captcha login waits on QQ's own server.
      timeoutMs: 45_000,
      maxBytes: 4 * 1024 * 1024,
    });
    const text = await boundedText(response, "napcat_unavailable");
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  }
}

/** Only known fields of known types survive; anything else from the manager is dropped. */
export function sanitizeOps(value: unknown): OpsInstance | undefined {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.target !== "string" || !(raw.target === "owner" || memberId.test(raw.target))) return undefined;
  const container = raw.container as Record<string, unknown> | undefined;
  if (!container || typeof container.name !== "string" || typeof container.running !== "boolean") return undefined;
  const programs = (raw.programs ?? {}) as Record<string, unknown>;
  const koishi = program(programs.koishi);
  const napcat = program(programs.napcat);
  const startedAt = dateText(container.startedAt);
  const memory = raw.memory as Record<string, unknown> | undefined;
  const used = finite(memory?.usedBytes);
  const limit = finite(memory?.limitBytes);
  const cpu = finite(raw.cpuPercent, 100_000);
  const release = raw.release as Record<string, unknown> | undefined;
  const commit = typeof release?.commit === "string" && /^[0-9a-f]{7,64}$/i.test(release.commit) ? release.commit : undefined;
  const deployedAt = dateText(release?.deployedAt);
  return {
    target: raw.target,
    container: { name: container.name.slice(0, 128), running: container.running, ...(startedAt ? { startedAt } : {}) },
    ...(used !== undefined && limit !== undefined ? { memory: { usedBytes: used, limitBytes: limit } } : {}),
    ...(cpu !== undefined ? { cpuPercent: cpu } : {}),
    programs: { ...(koishi ? { koishi } : {}), ...(napcat ? { napcat } : {}) },
    ...(commit
      ? {
          release: {
            commit: commit.slice(0, 64),
            ...(typeof release?.deployId === "string" ? { deployId: release.deployId.slice(0, 64) } : {}),
            ...(deployedAt ? { deployedAt } : {}),
          },
        }
      : {}),
  };
}

/** The response's text, or the given error when it is larger than the call allows. */
async function boundedText(response: BoundedResponse, code: string): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new Error(code, { cause: error });
  }
}

const finite = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;

const dateText = (value: unknown) => (typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined);

function program(value: unknown): OpsProgram | undefined {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || !OPS_PROGRAM_STATES.includes(raw.state as never)) return undefined;
  const pid = finite(raw.pid);
  const uptime = finite(raw.uptimeSeconds);
  return { state: raw.state as OpsProgram["state"], ...(pid !== undefined ? { pid } : {}), ...(uptime !== undefined ? { uptimeSeconds: uptime } : {}) };
}
