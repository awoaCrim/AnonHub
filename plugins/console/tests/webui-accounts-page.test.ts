import { expect, it } from "vitest";

import type { AccountHealth, AccountView, BotSummary } from "../src/shared/accounts";
import { accountIssues, friendOrder, friendStatus, matchesFilter, relativeTime } from "../web/src/state/accounts-health";

const healthy: BotSummary = { qqOnline: true, modelReady: true, roleReady: null, allowedChannels: 2, todayCalls: 3, lastActivityAt: 0, attention: 0 };
const account = (state: AccountView["runtime"]["state"], enabled = true, username = "alice", qqAccount = "12345") =>
  ({ id: "a", username, enabled, runtime: { id: "a", state, qqAccount } }) as AccountView;
const row = (health: BotSummary | null, error?: AccountHealth["error"]): AccountHealth => ({ id: "a", health, ...(error ? { error } : {}) });

it("reports what an owner should act on, once per cause", () => {
  expect(accountIssues(account("running"), row(healthy))).toEqual([]);
  expect(accountIssues(account("running", false), row(null, "not_running"))).toEqual([]);
  expect(accountIssues(account("error"), undefined).map((issue) => issue.label)).toEqual(["bot 启动失败"]);
  expect(accountIssues(account("setup-required"), undefined).map((issue) => issue.label)).toEqual(["好友还没完成首次设置"]);
  expect(accountIssues(account("stopped"), undefined).map((issue) => issue.label)).toEqual(["bot 未运行"]);
  expect(accountIssues(account("running"), row(null, "timeout")).map((issue) => issue.label)).toEqual(["状态读取超时"]);
  expect(accountIssues(account("running"), row(null, "unreachable")).map((issue) => issue.label)).toEqual(["无法读取状态"]);
  expect(
    accountIssues(account("running"), row({ ...healthy, qqOnline: false, modelReady: false, allowedChannels: 0, attention: 2 })).map((issue) => [
      issue.tone,
      issue.label,
    ]),
  ).toEqual([
    ["danger", "QQ 不在线"],
    ["warn", "未设置回复模型"],
    ["warn", "未选择回复范围"],
    ["warn", "2 个提醒"],
  ]);
  // Unknown values are not failures.
  expect(accountIssues(account("running"), row({ ...healthy, qqOnline: null, modelReady: null, allowedChannels: null, attention: null }))).toEqual([]);
});

it("filters by status and searches name or QQ", () => {
  expect(matchesFilter(account("running"), row(healthy), "attention", "")).toBe(false);
  expect(matchesFilter(account("running"), row({ ...healthy, qqOnline: false }), "attention", "")).toBe(true);
  expect(matchesFilter(account("stopped"), undefined, "stopped", "")).toBe(true);
  expect(matchesFilter(account("running", false), undefined, "stopped", "")).toBe(true);
  expect(matchesFilter(account("running"), undefined, "stopped", "")).toBe(false);
  expect(matchesFilter(account("running", true, "Bob", "998877"), undefined, "all", "9988")).toBe(true);
  expect(matchesFilter(account("running", true, "Bob", "998877"), undefined, "all", "bo")).toBe(true);
  expect(matchesFilter(account("running", true, "Bob", "998877"), undefined, "all", "alice")).toBe(false);
});

it("formats recent activity", () => {
  const now = Date.UTC(2026, 10, 1, 12);
  expect(relativeTime(null, now)).toBe("暂无记录");
  expect(relativeTime(now - 20_000, now)).toBe("刚刚");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
  expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
});

it("gives each friend one status and every problem with a next step", () => {
  const status = (state: AccountView["runtime"]["state"], health?: BotSummary | null, enabled = true) =>
    friendStatus(account(state, enabled), health === undefined ? undefined : row(health));
  expect(status("running", healthy)).toMatchObject({ tone: "ok", label: "正常", problems: [] });
  expect(status("running", null, false)).toMatchObject({ tone: "", label: "已停用", problems: [] });
  expect(status("error").label).toBe("启动失败");
  expect(status("setup-required").label).toBe("等好友首次设置");
  expect(status("starting")).toMatchObject({ label: "正在启动", problems: [] });
  // Running but not read yet is not a problem.
  expect(status("running")).toMatchObject({ tone: "ok", label: "运行中" });
  const broken = status("running", { ...healthy, qqOnline: false, modelReady: false, attention: 1, issues: ["记忆没能启动"] });
  expect(broken.tone).toBe("danger");
  expect(broken.label).toBe("QQ 掉线");
  expect(broken.problems.map((problem) => problem.label)).toEqual(["QQ 掉线", "没选回复模型", "1 个提醒"]);
  expect(broken.problems.every((problem) => problem.hint)).toBe(true);
  expect(broken.problems[2]!.hint).toBe("记忆没能启动");
  // Unknown values are never problems.
  expect(status("running", { ...healthy, qqOnline: null, modelReady: null, allowedChannels: null, attention: null }).problems).toEqual([]);
  // Problems first, then running, then stopped.
  expect([status("running", null, false), status("running", healthy), broken].map(friendOrder)).toEqual([2, 1, 0]);
});

import type { OpsInstance } from "../src/shared/accounts";
import { ownerStatus, opsProblems } from "../web/src/state/accounts-health";

const ops = (koishi = "RUNNING", napcat = "RUNNING", running = true): OpsInstance => ({
  target: "owner",
  container: { name: "demo", running },
  programs: { koishi: { state: koishi as never }, napcat: { state: napcat as never } },
});

it("flags a bot or QQ process the manager reports down, but not one that is only starting", () => {
  expect(opsProblems(undefined)).toEqual([]);
  expect(opsProblems(ops())).toEqual([]);
  expect(opsProblems(ops("STARTING", "UNKNOWN"))).toEqual([]);
  expect(opsProblems(ops("FATAL")).map((item) => item.label)).toEqual(["bot 没在运行"]);
  expect(opsProblems(ops("RUNNING", "BACKOFF")).map((item) => item.label)).toEqual(["QQ 进程没在运行"]);
  expect(opsProblems(ops("RUNNING", "RUNNING", false)).map((item) => item.label)).toEqual(["容器没在运行"]);
});

it("puts manager-reported problems into a friend's and the owner's status", () => {
  const running = account("running");
  const friend = friendStatus(running, row(healthy), ops("RUNNING", "STOPPED"));
  expect(friend).toMatchObject({ tone: "danger", label: "QQ 进程没在运行" });
  // The same cause is named once even when both sources see it.
  const both = friendStatus(running, row({ ...healthy, qqOnline: false }), ops("EXITED"));
  expect(both.problems.map((item) => item.label)).toEqual(["bot 没在运行", "QQ 掉线"]);
  // A stopped friend's old container state is not shown as a problem.
  expect(friendStatus(account("running", false), undefined, ops("EXITED")).problems).toEqual([]);
  expect(friendStatus(account("stopped"), undefined, ops("EXITED")).label).toBe("没在运行");
  expect(ownerStatus(healthy, ops())).toMatchObject({ tone: "ok", label: "正常" });
  expect(ownerStatus(null, undefined)).toMatchObject({ tone: "ok", label: "运行中" });
  expect(ownerStatus({ ...healthy, qqOnline: false }, ops()).label).toBe("QQ 掉线");
  expect(ownerStatus(healthy, ops("STOPPED")).label).toBe("bot 没在运行");
  expect(friendOrder(friend)).toBe(0);
});
