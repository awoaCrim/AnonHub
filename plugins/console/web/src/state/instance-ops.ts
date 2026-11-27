import type { InstanceRestartResponse, OpsInstance, OpsProgram, OpsProgramName, OpsProgramState } from "../../../src/shared/accounts";
import { adminRequest } from "../lib/admin-request";

export const programLabels: Record<OpsProgramState, string> = {
  RUNNING: "运行中",
  STARTING: "正在启动",
  STOPPED: "已停止",
  STOPPING: "正在停止",
  BACKOFF: "反复启动失败",
  EXITED: "已退出",
  FATAL: "无法启动",
  UNKNOWN: "未知",
};

export function programTone(program: OpsProgram | undefined): "ok" | "warn" | "danger" | "" {
  if (!program || program.state === "UNKNOWN") return "";
  if (program.state === "RUNNING") return "ok";
  return program.state === "STARTING" || program.state === "STOPPING" ? "warn" : "danger";
}

/** `release.commit` as shown: the short form. */
export const shortCommit = (ops: OpsInstance | undefined) => ops?.release?.commit.slice(0, 7);

export type RestartOutcome = { kind: "done"; instance?: OpsInstance } | { kind: "accepted" };

/**
 * Restarts a bot or QQ. The owner's own bot answers 202 and then goes away, so for it a dropped connection is the
 * expected result, not a failure.
 */
export async function restartInstance(target: string, program: OpsProgramName, request: typeof adminRequest = adminRequest): Promise<RestartOutcome> {
  const own = target === "owner" && program === "koishi";
  try {
    const result = await request<InstanceRestartResponse>("admin/instances/restart", { target, program });
    return result.accepted || own ? { kind: "accepted" } : { kind: "done", instance: result.instance };
  } catch (error) {
    if (own && error instanceof TypeError) return { kind: "accepted" };
    throw error;
  }
}

/** The result of a restart, merged into the page's last ops snapshot so the card updates without a reload. */
export function mergeOps<T extends { owner?: OpsInstance; accounts: Record<string, OpsInstance> }>(snapshot: T | null | undefined, instance: OpsInstance): T {
  const base = (snapshot ?? { accounts: {} }) as T;
  return instance.target === "owner" ? { ...base, owner: instance } : { ...base, accounts: { ...base.accounts, [instance.target]: instance } };
}
