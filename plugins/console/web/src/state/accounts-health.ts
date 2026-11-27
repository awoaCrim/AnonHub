import type { AccountHealth, AccountView, BotSummary, OpsInstance } from "../../../src/shared/accounts";

export type AccountStatusFilter = "all" | "attention" | "stopped";

export interface AccountIssue {
  tone: "danger" | "warn";
  label: string;
}

/** What an owner should look at for one member. Unknown health is reported once, not as several failures. */
export function accountIssues(account: Pick<AccountView, "enabled" | "runtime">, row: AccountHealth | undefined): AccountIssue[] {
  if (!account.enabled) return [];
  const state = account.runtime.state;
  if (state === "error") return [{ tone: "danger", label: "bot 启动失败" }];
  if (state === "setup-required") return [{ tone: "warn", label: "好友还没完成首次设置" }];
  if (state !== "running") return [{ tone: "warn", label: "bot 未运行" }];
  if (!row) return [];
  if (!row.health) return row.error === "not_running" ? [] : [{ tone: "warn", label: row.error === "timeout" ? "状态读取超时" : "无法读取状态" }];
  return summaryIssues(row.health);
}

export function summaryIssues(health: BotSummary): AccountIssue[] {
  const issues: AccountIssue[] = [];
  if (health.qqOnline === false) issues.push({ tone: "danger", label: "QQ 不在线" });
  if (health.modelReady === false) issues.push({ tone: "warn", label: "未设置回复模型" });
  if (health.allowedChannels === 0) issues.push({ tone: "warn", label: "未选择回复范围" });
  if (health.attention) issues.push({ tone: "warn", label: `${health.attention} 个提醒` });
  return issues;
}

/** The one badge for a bot summary: its first problem, or 运行正常. */
export function summaryBadge(health: BotSummary): { tone: "danger" | "warn" | "ok"; label: string } {
  return summaryIssues(health)[0] ?? { tone: "ok", label: "运行正常" };
}

export interface FriendProblem {
  tone: "danger" | "warn";
  label: string;
  /** What the owner can do about it. */
  hint: string;
}
/** One status for a friend's bot, worded for the owner; `problems` lists every cause with what to do. */
export interface FriendStatus {
  tone: "" | "ok" | "warn" | "danger";
  label: string;
  problems: FriendProblem[];
}

/** A process the manager reports as down. Starting or unknown is not a problem; the manager restarts what crashed on its own. */
const down = (state: string | undefined) => state !== undefined && !["RUNNING", "STARTING", "UNKNOWN"].includes(state);

/** What the host manager's view of an instance says needs a look: its bot or its QQ process is not running. */
export function opsProblems(ops: OpsInstance | undefined): FriendProblem[] {
  if (!ops) return [];
  const problems: FriendProblem[] = [];
  if (!ops.container.running) return [{ tone: "danger", label: "容器没在运行", hint: "到「实例」详情里重启 bot；还不行请看服务器日志。" }];
  if (down(ops.programs.koishi?.state)) problems.push({ tone: "danger", label: "bot 没在运行", hint: "点「重启 bot」，通常几十秒后恢复。" });
  if (down(ops.programs.napcat?.state)) problems.push({ tone: "danger", label: "QQ 进程没在运行", hint: "点「重启 QQ」，之后可能需要重新扫码。" });
  return problems;
}

/** Problems from both sources, without naming the same cause twice. */
function withOps(status: FriendStatus, ops: OpsInstance | undefined): FriendStatus {
  const extra = opsProblems(ops).filter((item) => !status.problems.some((known) => known.label === item.label));
  if (!extra.length) return status;
  const problems = [...extra, ...status.problems];
  return { tone: "danger", label: problems[0]!.label, problems };
}

/** The owner's own bot, with the same vocabulary as a friend's. */
export function ownerStatus(health: BotSummary | null | undefined, ops: OpsInstance | undefined): FriendStatus {
  const problems: FriendProblem[] = [];
  if (health?.qqOnline === false) problems.push({ tone: "danger", label: "QQ 掉线", hint: "在下面的 QQ 卡片里扫码重新登录。" });
  if (health?.modelReady === false) problems.push({ tone: "warn", label: "没选回复模型", hint: "在「设置 → 模型」里选一个回复模型。" });
  if (health?.allowedChannels === 0) problems.push({ tone: "warn", label: "没选回复范围", hint: "在「设置 → 平台」里选在哪些群和私聊回复。" });
  if (health?.attention)
    problems.push({ tone: "warn", label: `${health.attention} 个提醒`, hint: (health.issues ?? []).join("；") || "打开「系统」看看提醒。" });
  const base: FriendStatus = problems.length
    ? { tone: problems.some((item) => item.tone === "danger") ? "danger" : "warn", label: problems[0]!.label, problems }
    : { tone: "ok", label: health ? "正常" : "运行中", problems };
  return withOps(base, ops);
}

/** The friend's bot in one word, plus each problem with a next step. Unknown values are never problems. */
export function friendStatus(account: Pick<AccountView, "enabled" | "runtime">, row: AccountHealth | undefined, ops?: OpsInstance): FriendStatus {
  return withOps(baseFriendStatus(account, row), account.enabled && account.runtime.state === "running" ? ops : undefined);
}

function baseFriendStatus(account: Pick<AccountView, "enabled" | "runtime">, row: AccountHealth | undefined): FriendStatus {
  if (!account.enabled) return { tone: "", label: "已停用", problems: [] };
  const state = account.runtime.state;
  const one = (problem: FriendProblem): FriendStatus => ({ tone: problem.tone, label: problem.label, problems: [problem] });
  if (state === "error") return one({ tone: "danger", label: "启动失败", hint: "先停用再重新启用试试；还不行请看「系统 → 服务器」里的日志。" });
  if (state === "setup-required") return one({ tone: "warn", label: "等好友首次设置", hint: "把登录信息发给好友，让他登录后按提示完成设置。" });
  if (state === "starting") return { tone: "warn", label: "正在启动", problems: [] };
  if (state === "stopping") return { tone: "warn", label: "正在停止", problems: [] };
  if (state !== "running") return one({ tone: "warn", label: "没在运行", hint: "停用再重新启用后会重新启动。" });
  if (!row) return { tone: "ok", label: "运行中", problems: [] };
  if (!row.health)
    return row.error === "not_running"
      ? { tone: "ok", label: "运行中", problems: [] }
      : one({ tone: "warn", label: "状态读不到", hint: "它可能正忙或刚重启，过一会儿会自动重试。" });
  const health = row.health;
  const problems: FriendProblem[] = [];
  if (health.qqOnline === false) problems.push({ tone: "danger", label: "QQ 掉线", hint: "在下面的 QQ 卡片里扫码重新登录，或让好友登录自己的控制台扫码。" });
  if (health.modelReady === false) problems.push({ tone: "warn", label: "没选回复模型", hint: "让好友在「设置 → 模型」里选一个回复模型。" });
  if (health.allowedChannels === 0) problems.push({ tone: "warn", label: "没选回复范围", hint: "让好友在「设置 → 平台」里选在哪些群和私聊回复。" });
  if (health.attention)
    problems.push({ tone: "warn", label: `${health.attention} 个提醒`, hint: (health.issues ?? []).join("；") || "让好友打开「系统」看看提醒。" });
  return problems.length
    ? { tone: problems.some((item) => item.tone === "danger") ? "danger" : "warn", label: problems[0]!.label, problems }
    : { tone: "ok", label: "正常", problems };
}

/** Friends that need a look first, then running ones, then stopped ones; each group keeps its order. */
export function friendOrder(status: FriendStatus): number {
  return status.problems.length ? 0 : status.tone === "" ? 2 : 1;
}

/** Badge tone of an account's runtime; a disabled account has none. */
export function runtimeTone(account: Pick<AccountView, "enabled" | "runtime">): "" | "ok" | "danger" | "warn" {
  if (!account.enabled) return "";
  return account.runtime.state === "running" ? "ok" : account.runtime.state === "error" ? "danger" : "warn";
}

export function matchesFilter(
  account: Pick<AccountView, "enabled" | "runtime" | "username">,
  row: AccountHealth | undefined,
  filter: AccountStatusFilter,
  query: string,
): boolean {
  const keyword = query.trim().toLowerCase();
  if (keyword && !`${account.username} ${account.runtime.qqAccount ?? ""}`.toLowerCase().includes(keyword)) return false;
  if (filter === "attention") return accountIssues(account, row).length > 0;
  if (filter === "stopped") return !account.enabled || account.runtime.state !== "running";
  return true;
}

/** "3 分钟前" style; dates further back read as month-day. */
export function relativeTime(epoch: number | null, now = Date.now()): string {
  if (epoch === null || !Number.isFinite(epoch)) return "暂无记录";
  const minutes = Math.floor((now - epoch) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / 1440)} 天前`;
  return new Date(epoch).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
